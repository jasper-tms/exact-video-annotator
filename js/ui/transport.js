// Transport bar: play/pause, single-frame stepping, a frame-unit scrubber,
// a numeric frame input, and a readout. Everything is denominated in integer
// frame indices; times shown are derived from the engine, never the reverse.

// Transport-button glyphs, as inline SVG rather than Unicode text characters.
// A font glyph is centered by its line box, not its ink, so a swapped-in
// character (the play triangle versus the pause bars, in particular) can
// visibly shift and can also change the button's rendered width, which is why
// the play/pause button used to resize itself on every click. Each shape
// here has its own bounding box centered in its 24x24 viewBox — equal empty
// margin on the left and right — so centering holds regardless of which font
// the page loads, and both play and pause sit in a same-sized fixed box (see
// .transport-play in style.css) so toggling between them never resizes it.
// The chevrons open to a 110-degree interior angle (rather than a right
// angle) as a deliberate style choice.
const CHEVRON_LEFT_ICON = '<svg class="transport-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.1 6L9.9 12L14.1 18"/></svg>';
const CHEVRON_RIGHT_ICON = '<svg class="transport-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 6L14.1 12L9.9 18"/></svg>';
const PLAY_ICON = '<svg class="transport-icon transport-icon-play" viewBox="0 0 24 24" fill="currentColor"><path d="M3.6 3.25L3.6 20.75L20.4 12Z"/></svg>';
const PAUSE_ICON = '<svg class="transport-icon transport-icon-pause" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>';

export function initializeTransport(app, containerElement) {
  containerElement.innerHTML = `
    <button class="transport-play" title="Play/pause (Space)" disabled>${PLAY_ICON}${PAUSE_ICON}</button>
    <button class="transport-step-backward" title="Back one frame (← or ,)" disabled>${CHEVRON_LEFT_ICON}</button>
    <button class="transport-step-forward" title="Forward one frame (→ or .)" disabled>${CHEVRON_RIGHT_ICON}</button>
    <input type="range" class="transport-scrubber" min="0" max="0" step="1" value="0" disabled>
    <span class="transport-readout"><span>Frame</span><input type="text" class="transport-frame-input"
      inputmode="numeric" title="Frame number (press Enter to jump)" disabled><span
      class="transport-frame-total"></span><span class="transport-time-gap">·</span><span
      class="transport-time"></span></span>
    <span class="index-waiting" hidden
          title="Playback has reached the last frame indexed so far and is waiting for the index to catch up."
          >waiting for index…</span>
    <span class="exactness-warning" hidden
          title="This clip could not be indexed, so frame numbers are only as good as an assumed constant frame rate."
          >frame numbers approximate</span>
  `;

  const playButton = containerElement.querySelector('.transport-play');
  const stepBackwardButton = containerElement.querySelector('.transport-step-backward');
  const stepForwardButton = containerElement.querySelector('.transport-step-forward');
  const scrubber = containerElement.querySelector('.transport-scrubber');
  const frameInput = containerElement.querySelector('.transport-frame-input');
  const frameTotal = containerElement.querySelector('.transport-frame-total');
  const timeGap = containerElement.querySelector('.transport-time-gap');
  const timeReadout = containerElement.querySelector('.transport-time');
  const readout = containerElement.querySelector('.transport-readout');
  const indexWaiting = containerElement.querySelector('.index-waiting');
  const exactnessWarning = containerElement.querySelector('.exactness-warning');

  let scrubbingWasPlaying = false;

  playButton.addEventListener('click', () => app.togglePlayback());

  stepBackwardButton.addEventListener('click', () => app.stepFrame(-1));
  stepForwardButton.addEventListener('click', () => app.stepFrame(1));

  // Holding the scrubber suspends playback; releasing it resumes. It also
  // suspends the seek-pending video dimming (see app.setScrubDragActive) —
  // rapid-fire seeks mid-drag are expected to lag a little, and dimming on
  // every intermediate tick would be noise, not signal.
  scrubber.addEventListener('pointerdown', () => {
    app.setScrubDragActive(true);
    if (app.isPlaying) {
      scrubbingWasPlaying = true;
      app.pausePlayback();
    }
  });
  scrubber.addEventListener('input', () => {
    app.seekToFrame(Number(scrubber.value));
  });
  scrubber.addEventListener('pointerup', () => {
    app.setScrubDragActive(false);
    if (scrubbingWasPlaying) {
      scrubbingWasPlaying = false;
      app.startPlayback();
      updateControls();
    }
  });
  // The range input's own arrow-key handling ignores our frame semantics and
  // would double-handle the global shortcuts; keep focus off it.
  scrubber.addEventListener('keydown', (event) => event.preventDefault());
  scrubber.addEventListener('focus', () => scrubber.blur());

  // Committing happens once, from blur — Enter just moves focus out (which
  // triggers that blur), so a typed value is committed identically whether
  // the user presses Enter or simply clicks elsewhere. Escape discards the
  // edit instead of committing it, via the suppress flag below.
  let suppressNextFrameInputCommit = false;

  function commitFrameInputIfChanged() {
    const engine = app.engine;
    if (!engine) return;
    const frameNumber = Number.parseInt(frameInput.value, 10);
    if (Number.isInteger(frameNumber) && frameNumber !== engine.currentFrame) {
      app.seekToFrame(frameNumber);
    }
  }

  frameInput.addEventListener('keydown', (event) => {
    event.stopPropagation();   // typing digits must not trigger global hotkeys
    if (event.key === 'Enter') {
      event.preventDefault();
      frameInput.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      suppressNextFrameInputCommit = true;
      frameInput.blur();
    }
  });
  frameInput.addEventListener('blur', () => {
    if (!suppressNextFrameInputCommit) commitFrameInputIfChanged();
    suppressNextFrameInputCommit = false;
    updateFrameDisplays();
  });

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '0:00.00';
    const wholeMinutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds - wholeMinutes * 60;
    return `${wholeMinutes}:${remainingSeconds.toFixed(2).padStart(5, '0')}`;
  }

  /** The last frame the engine will name right now. While the index is growing
      this is a floor that rises, never a total — every frame up to it is
      exact and stays exact. */
  function lastIndexedFrame(engine) {
    return Math.max(0, (engine.numFrames ?? 1) - 1);
  }

  /** How far right the scrubber's track should reach.

      Sizing it by the indexed frame count would stretch the track under the
      cursor on every publish, so while the index grows the track is sized
      against the whole clip instead: the container's DECLARED duration scaled
      into frames by the mean rate of the part already indexed. That projection
      is geometry only — it is never displayed and never names a frame, and
      app.seekToFrame still clamps to what is actually indexed, so the grey
      remainder cannot be seeked into. It snaps to the true count the moment
      the index settles. A container that declares no duration (expectedDuration
      0) has nothing to project from, and the track simply grows. */
  function scrubberMaximum(engine) {
    const lastFrame = lastIndexedFrame(engine);
    if (engine.frameIndexState !== 'growing') return lastFrame;
    const declaredDuration = engine.expectedDuration ?? 0;
    const indexedDuration = engine.duration ?? 0;
    if (!(indexedDuration > 0) || !(declaredDuration > indexedDuration)) return lastFrame;
    const projectedFrames = Math.round(engine.numFrames * declaredDuration / indexedDuration);
    return Math.max(lastFrame, projectedFrames - 1);
  }

  /** The clip's total duration as displayed in the readout: a plain time once
      the pass has read the whole clip, otherwise a declared-duration estimate
      ('~') or a growing floor ('+'). Depends only on facts the index carries,
      not on the current playhead, so sizing code can call it too. */
  function totalTimeText(engine) {
    const indexState = engine.frameIndexState ?? 'complete';
    if (indexState !== 'growing') return formatTime(engine.duration);
    const declaredDuration = engine.expectedDuration ?? 0;
    return declaredDuration > 0 ? `~${formatTime(declaredDuration)}` : `${formatTime(engine.duration)}+`;
  }

  /** How many digit characters the minutes portion of a formatted time takes
      up — the only part of that string whose length varies as playback
      proceeds (seconds and the decimal are always a fixed width). A leading
      '~' (declared-duration estimate) sits before the minutes, so strip it
      before measuring; a trailing '+' (growing floor) sits after the whole
      time and does not affect where the minutes end. */
  function minuteDigitCount(formattedTime) {
    const withoutEstimateMark = formattedTime.startsWith('~') ? formattedTime.slice(1) : formattedTime;
    return withoutEstimateMark.indexOf(':');
  }

  function updateFrameDisplays() {
    const engine = app.engine;
    if (!engine) return;
    const frame = engine.currentFrame ?? 0;
    scrubber.value = String(frame);
    if (document.activeElement !== frameInput) frameInput.value = String(frame);

    const lastFrame = lastIndexedFrame(engine);
    const indexState = engine.frameIndexState ?? 'complete';
    // A growing count is a floor ('+'), and a declared duration is the
    // container's claim rather than a scanned fact ('~'). Both marks come off
    // once the pass has actually read the whole clip.
    const totalFramesText = indexState === 'growing' ? `${lastFrame}+`
      : indexState === 'truncated' ? `${lastFrame} (partial)`
      : `${lastFrame}`;
    frameTotal.textContent = `/ ${totalFramesText}`;

    const currentTimeText = formatTime(engine.currentTime);
    const totalTime = totalTimeText(engine);
    timeReadout.textContent = `${currentTimeText} / ${totalTime}`;

    // Reserve blank space to the left of the current time's minute digits, so
    // a newly grown digit (9:59 -> 10:00, 99:59 -> 100:00) fills into space
    // that was already there instead of pushing the total time to the right.
    // The dot separator floats centered in whatever remains of that gap, so
    // it drifts half a digit's width to the left each time the gap shrinks.
    const reservedDigits = Math.max(0, minuteDigitCount(totalTime) - minuteDigitCount(currentTimeText));
    timeGap.style.width = `calc(1ch + ${reservedDigits}ch)`;

    readout.classList.toggle('index-growing', indexState === 'growing');
    readout.classList.toggle('index-truncated', indexState === 'truncated');
  }

  /** Scrubber geometry and the index-state chips — everything that moves when
      the index publishes more frames rather than when the playhead moves. */
  function updateIndexDisplays() {
    const engine = app.engine;
    if (!engine) return;
    const maximum = scrubberMaximum(engine);
    scrubber.max = String(maximum);
    // The share of the track that is actually indexed; the rest is painted as
    // the lighter "not here yet" grey, the way a buffered range is.
    const indexedFraction = maximum > 0 ? Math.min(1, lastIndexedFrame(engine) / maximum) : 1;
    scrubber.style.setProperty('--indexed-fraction', `${(indexedFraction * 100).toFixed(2)}%`);
    indexWaiting.hidden = !engine.waitingForIndex;
    exactnessWarning.hidden = engine.frameIndexIsExact !== false;
    // Wide enough for the last frame number so the box does not resize as the
    // user types a shorter or longer one. The box is border-box, so its own
    // padding and border (10px, see .transport-frame-input) would otherwise eat
    // into a plain "+1ch" buffer meant for breathing room — add that overhead
    // back in pixels so the digits themselves always fit.
    frameInput.style.width = `calc(${String(maximum).length}ch + 14px)`;
    updateFrameDisplays();
  }

  function updateControls() {
    const engine = app.engine;
    const hasVideo = engine !== null;
    for (const control of [playButton, stepBackwardButton, stepForwardButton, scrubber, frameInput]) {
      control.disabled = !hasVideo;
    }
    if (!hasVideo) return;
    // isPlaying, not engine.paused: a synchronized play advances the videos
    // while every engine's own paused flag stays true (see app.isPlaying).
    playButton.classList.toggle('is-playing', app.isPlaying);
    updateIndexDisplays();
  }

  app.addEventListener('video-loaded', updateControls);
  app.addEventListener('frame-changed', updateFrameDisplays);
  app.addEventListener('playback-changed', updateControls);
  app.addEventListener('index-changed', updateIndexDisplays);

  updateControls();
}
