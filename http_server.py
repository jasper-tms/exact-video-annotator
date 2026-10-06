#!/usr/bin/env python3
"""
Local development server that reproduces Cloudflare Pages' serving behavior.

Matches production behavior that a plain `python3 -m http.server` cannot:
  - Cloudflare-style _redirects rules, including `/*` wildcard sources and
    incoming-query-string preservation (e.g. /training?debug=1 -> /?debug=1).
  - Pretty (extensionless) URLs: /coach is served from coach.html, like Pages.
  - 404.html served with a real 404 status for unknown paths.
  - HTTP Range requests (206 partial content), matching Pages so range-based
    fetches behave the same locally.
  - No browser caching (Cache-Control: no-store), so a plain refresh always
    shows your latest edits.

Rebuild-on-refresh: by default the server runs the build (`node build.mjs
--dist`, the same thing Cloudflare's build.sh runs) once on startup, and again
whenever the browser loads an HTML page, so a refresh reflects your latest edits
to the source files the build assembles. Asset requests (images, JSON, CSS, JS)
do NOT trigger a rebuild, so a single page load rebuilds once. This assumes the
build is fast, since it reruns on every page load.

Works on Windows (PowerShell, Command Prompt), macOS and Linux. Needs only
Python 3 and Node.js (for the build) -- no bash.

Usage:
    python http_server.py [port] [directory]
                         [--no-build] [--no-browser]

    port         Port to serve on. If omitted, the first free port from 8000
                 upward is used; if given and already in use, the server exits.
    directory    Directory to serve (default: the freshly built "dist", or the
                 repository root under --no-build).
    --no-build   Skip the build entirely (no startup build, no rebuild-on-
                 refresh) and serve the repository root (or an explicit
                 directory) live. Pages that only exist post-build are then
                 unavailable, since they live only in dist/.
    --no-browser Do not open the site in a browser on startup.

Note: Cloudflare Pages Functions (e.g. an access-gate _middleware.js) are NOT
run here -- they are a Pages-only runtime -- so the site loads without them.
Any backend the pages talk to (e.g. Firebase) is still whatever the pages point
at, typically the live project.
"""

import argparse
import errno
import http.server
import os
import re
import socket
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path
from urllib.parse import unquote

DEFAULT_PORT = 8000


def parse_redirects_file(filepath):
    """Parse a Cloudflare-style _redirects file.

    Format: /source /destination [status_code]
    - 200 = rewrite (serve destination content at source URL)
    - 301 = permanent redirect (the default when no status is given)
    - 302 = temporary redirect

    A source ending in `/*` is a wildcard that matches that prefix (e.g.
    `/training/*` matches `/training/anything`), mirroring Pages splats.
    """
    rules = []
    if not os.path.exists(filepath):
        return rules

    with open(filepath, 'r', encoding='utf-8') as file:
        for line in file:
            line = line.strip()
            if not line or line.startswith('#'):
                continue

            parts = line.split()
            if len(parts) >= 2:
                source = parts[0]
                destination = parts[1]
                status = int(parts[2]) if len(parts) >= 3 else 301
                rules.append((source, destination, status))

    return rules


def match_redirect(path, rules):
    """Return (destination, status) for the first rule matching `path`, or None.

    `path` is the request path with the query string already stripped off.
    Exact sources match equal paths; a `/*`-suffixed source matches any path
    under that prefix. Rules are tried in file order (most specific first, as
    the file is expected to be authored).
    """
    for source, destination, status in rules:
        if source.endswith('/*'):
            if path.startswith(source[:-1]):  # `/training/*` -> prefix `/training/`
                return destination, status
        elif path == source:
            return destination, status
    return None


def parse_byte_range(byte_range):
    """Parse a "bytes=first-last" Range header (last may be empty)."""
    match = re.match(r'bytes=(\d+)-(\d*)$', byte_range.strip())
    if not match:
        raise ValueError(f'Unsupported byte range: {byte_range}')
    first = int(match.group(1))
    last = int(match.group(2)) if match.group(2) else None
    if last is not None and last < first:
        raise ValueError(f'Invalid byte range: {byte_range}')
    return first, last


class RedirectHandler(http.server.SimpleHTTPRequestHandler):
    redirect_rules = []

    # Absolute directory to serve. Passed to the handler explicitly (rather than
    # relying on the process working directory) so serving keeps working after a
    # rebuild deletes and recreates dist/ under us -- the process cwd would be
    # left dangling, but this absolute path resolves to the new dist/.
    serve_directory = None

    # Set when the server is in build mode (not --no-build). When True, loading
    # an HTML page re-runs the build first so the page reflects the latest edits.
    rebuild_on_page_load = False
    repo_root = None
    # Serializes builds against each other and against serving, so a rebuild's
    # deletion of dist/ can't race a concurrent read of dist/ on another thread.
    build_lock = threading.Lock()

    # Pin the content types the site depends on. Otherwise Python asks the
    # operating system, and on Windows the registry can map e.g. .js to
    # text/plain, which browsers refuse to run as a script.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(self.serve_directory), **kwargs)

    def end_headers(self):
        # Development server: forbid browser caching so code edits and server
        # fixes always show up on a plain refresh. (Without this, Chrome
        # heuristically caches responses that carry Last-Modified, and can keep
        # replaying a stale or once-broken response.)
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        # Which file is being asked for: the query string and fragment are no
        # part of it, so /coach?lang=fr is still the /coach page (as on Pages).
        base = unquote(self.path.split('?', 1)[0].split('#', 1)[0])
        query = self.path.split('?', 1)[1] if '?' in self.path else ''

        # 1. Redirect rules (matched against the query-stripped path).
        match = match_redirect(base, self.redirect_rules)
        if match:
            destination, status = match
            if status == 200:
                # Rewrite: serve the destination file but keep the URL. A
                # rewrite onto a page (/performance -> /) is a page load too,
                # so rebuild first, as step 2 does for every other page.
                if self.rebuild_on_page_load and self.resolve_html_target(destination) is not None:
                    with self.build_lock:
                        if not run_build(self.repo_root):
                            return self.send_build_error()
                self.path = destination
                return super().do_GET()
            # Redirect: preserve the incoming query string, like Pages.
            location = destination + ('?' + query if query else '')
            self.send_response(status)
            self.send_header('Location', location)
            self.end_headers()
            return

        # 2. Rebuild-on-refresh: if this request would serve an HTML page,
        #    re-stage the site first so the page reflects the latest edits.
        if self.rebuild_on_page_load and self.resolve_html_target(base) is not None:
            with self.build_lock:
                if not run_build(self.repo_root):
                    return self.send_build_error()
        elif self.rebuild_on_page_load:
            # Non-page request: don't rebuild, but wait out any build in
            # progress so we never read dist/ mid-rebuild.
            with self.build_lock:
                pass

        # 3. Pretty URLs: try adding a .html extension (like Pages),
        #    e.g. /coach -> /coach.html.
        if not base.endswith('/') and '.' not in base.split('/')[-1]:
            html_path = Path(self.directory) / (base.lstrip('/') + '.html')
            if html_path.exists():
                self.path = base + '.html'
                return super().do_GET()

        # 4. Existing path: serve it (honoring Range requests).
        actual_path = Path(self.directory) / base.lstrip('/')
        if actual_path.exists():
            if 'Range' in self.headers and actual_path.is_file():
                return self.serve_byte_range()
            return super().do_GET()

        # 5. Unknown path: serve 404.html with a real 404 status, like Pages
        #    (its body's JS still bounces browsers back to /, but programmatic
        #    fetches correctly see the request fail).
        not_found_page = Path(self.directory) / '404.html'
        if not_found_page.is_file():
            body = not_found_page.read_bytes()
        else:
            body = b'Not Found'
        self.send_response(404)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def resolve_html_target(self, base):
        """Return the .html file this request would serve, or None.

        Used to decide whether a request is a page load (worth rebuilding for)
        versus an asset fetch. Mirrors the serving logic: directory index,
        pretty-URL .html, or a direct .html file.
        """
        directory = Path(self.directory)
        relative_path = base.lstrip('/')

        if base == '' or base.endswith('/'):
            index = directory / relative_path / 'index.html'
            return index if index.is_file() else None

        if '.' not in base.split('/')[-1]:
            html = directory / (relative_path + '.html')
            if html.is_file():
                return html
            index = directory / relative_path / 'index.html'
            return index if index.is_file() else None

        if base.endswith('.html'):
            direct = directory / relative_path
            return direct if direct.is_file() else None

        return None

    def send_build_error(self):
        body = (b'<!DOCTYPE html><meta charset=utf-8><title>Build failed</title>'
                b'<body style="font-family:system-ui;padding:2rem">'
                b'<h1>Build failed</h1>'
                b'<p>See the server terminal for the full output.</p></body>')
        self.send_response(500)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_byte_range(self):
        """
        Serve a partial-content (206) response for a "Range" request,
        matching Cloudflare's behavior in production.
        """
        try:
            first, last = parse_byte_range(self.headers['Range'])
        except ValueError:
            self.send_error(400, 'Invalid byte range')
            return
        path = self.translate_path(self.path)
        try:
            source = open(path, 'rb')
        except OSError:
            self.send_error(404, 'File not found')
            return
        with source:
            file_length = os.fstat(source.fileno()).st_size
            if first >= file_length:
                self.send_error(416, 'Requested range not satisfiable')
                return
            if last is None or last >= file_length:
                last = file_length - 1
            response_length = last - first + 1

            self.send_response(206)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Range',
                             f'bytes {first}-{last}/{file_length}')
            self.send_header('Content-Length', str(response_length))
            self.end_headers()

            source.seek(first)
            remaining = response_length
            try:
                while remaining > 0:
                    chunk = source.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                # Browsers routinely abort range requests mid-stream (they
                # seek elsewhere or have enough buffered); not an error.
                pass


def run_build(repo_root):
    """
    Run the build (blocking). Return True on success, False on failure.

    Runs `node build.mjs --dist` directly rather than build.sh (which is just a
    wrapper around it for Cloudflare), so no bash is needed on Windows.
    """
    try:
        result = subprocess.run(['node', 'build.mjs', '--dist'], cwd=repo_root)
    except FileNotFoundError:
        print('\nCould not find `node`. The build needs Node.js: install it from '
              'https://nodejs.org, then open a new terminal and try again.',
              file=sys.stderr)
        return False
    return result.returncode == 0


def main():
    parser = argparse.ArgumentParser(
        description='Development server matching Cloudflare Pages behavior '
                    '(_redirects, pretty URLs, 404.html, Range requests), '
                    'rebuilding on each page load.')
    parser.add_argument('port', nargs='?', type=int, default=None,
                        help='Port to serve on. If omitted, the first free '
                             f'port from {DEFAULT_PORT} upward is used.')
    parser.add_argument('directory', nargs='?', default=None,
                        help='Directory to serve (default: the freshly built '
                             '"dist", or this repository root under '
                             '--no-build).')
    parser.add_argument('--no-build', action='store_true',
                        help='Skip the build entirely (no startup build and no '
                             'rebuild-on-refresh) and serve the repository root '
                             'live (pages that only exist post-build are then '
                             'unavailable).')
    parser.add_argument('--no-browser', action='store_true',
                        help='Do not open the site in a browser on startup.')
    args = parser.parse_args()

    repo_root = Path(__file__).parent.resolve()

    # Build first (blocking) so the served dist/ reflects the current sources,
    # then serve dist/ by default and rebuild before each page load.
    if not args.no_build:
        print('Building...')
        if not run_build(repo_root):
            print('\nBuild failed; not starting the server.', file=sys.stderr)
            sys.exit(1)
        default_directory = repo_root / 'dist'
        RedirectHandler.rebuild_on_page_load = True
        RedirectHandler.repo_root = repo_root
    else:
        default_directory = repo_root

    if args.directory:
        serve_directory = Path(args.directory).resolve()
    else:
        serve_directory = default_directory

    # Parse _redirects from the served directory.
    redirects_path = serve_directory / '_redirects'
    RedirectHandler.redirect_rules = parse_redirects_file(redirects_path)

    if RedirectHandler.redirect_rules:
        print(f"Loaded {len(RedirectHandler.redirect_rules)} redirect rules:")
        for source, dest, status in RedirectHandler.redirect_rules:
            print(f"  {source} -> {dest} [{status}]")
    else:
        print("No _redirects file found or file is empty")

    RedirectHandler.serve_directory = serve_directory

    # Use the requested port, or if none was given, the first free port
    # starting from the default.
    if args.port is not None:
        candidate_ports = [args.port]
    else:
        candidate_ports = range(DEFAULT_PORT, DEFAULT_PORT + 100)
    httpd = None
    for port in candidate_ports:
        # Python's server sets SO_REUSEADDR, which on macOS lets it bind a port
        # that another server is already listening on via localhost, so bind()
        # alone can't be trusted to fail. Check for an existing listener first.
        port_in_use = False
        for family, host in [(socket.AF_INET, '127.0.0.1'),
                             (socket.AF_INET6, '::1')]:
            with socket.socket(family, socket.SOCK_STREAM) as probe:
                probe.settimeout(0.2)
                if probe.connect_ex((host, port)) == 0:
                    port_in_use = True
        if port_in_use:
            continue
        try:
            # Threading so a page and its concurrent asset / range-streamed
            # fetches can all be in flight at once.
            httpd = http.server.ThreadingHTTPServer(('', port), RedirectHandler)
            break
        except OSError as error:
            # Windows also refuses ports it has reserved (e.g. for Hyper-V)
            # with an access-denied error rather than "in use"; skip those too.
            if error.errno not in (errno.EADDRINUSE, errno.EACCES,
                                   getattr(errno, 'WSAEACCES', None)):
                raise
    if httpd is None:
        if args.port is not None:
            print(f'\nPort {args.port} is already in use. Pass a different '
                  'port, or omit it to pick a free one automatically.',
                  file=sys.stderr)
        else:
            print(f'\nNo free port found between {candidate_ports[0]} and '
                  f'{candidate_ports[-1]}.', file=sys.stderr)
        sys.exit(1)

    url = f'http://localhost:{port}'
    print(f"\nServing {serve_directory} at {url}")
    if RedirectHandler.rebuild_on_page_load:
        print("Rebuilding on each page load. Press Ctrl+C to stop\n")
    else:
        print("Press Ctrl+C to stop\n")

    with httpd:
        # The socket is already bound and listening, so the browser's first
        # request queues even if it beats serve_forever() below.
        if not args.no_browser:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down...")


if __name__ == '__main__':
    main()
