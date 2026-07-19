- [x] Set up a github repo and push to it.
- [ ] Set up cloudflare pages build from the repo. (Dashboard step: connect the
  repo, framework preset None, build command `bash build.sh`, output dir `dist`.)
- [x] Easy to add either frame-anchored annotations (specific coordinates on a
  specific frame) or frame-agnostic annotations (a location across the whole
  video). A single ∞ toggle in the left tool rail (below the polygon tool;
  hotkey `a`), off by default, switches new point/line/polygon annotations to
  frame-agnostic. Agnostic items store frame = null and draw full-strength on
  every frame; the annotations table shows their frame as "all".
- [x] Down/up arrow button at the bottom of the left tool rail: scrolls the page
  down to the details below the canvas, then back up. The glyph flips to ↑ while
  the page is not fully scrolled up.
