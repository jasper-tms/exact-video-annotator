// Transport bar: play/pause, single-frame stepping, a frame-unit scrubber,
// a numeric frame input, and a readout. Everything is denominated in integer
// frame indices; times shown are derived from the engine, never the reverse.

export function initializeTransport(app, containerElement) {
  containerElement.innerHTML = `
    <button class="transport-play" title="Play/pause (Space)" disabled>▶</button>
    <button class="transport-step-backward" title="Back one frame (← or ,)" disabled>⏮︎</button>
    <button class="transport-step-forward" title="Forward one frame (→ or .)" disabled>⏭︎</button>
    <input type="range" class="transport-scrubber" min="0" max="0" step="1" value="0" disabled>
    <span class="transport-readout"><span>Frame</span><input type="text" class="transport-frame-input"
      inputmode="numeric" title="Frame number (press Enter to jump)" disabled><span
      class="transport-frame-total"></span><span>·</span><span class="transport-time"></span></span>
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
  const timeReadout = containerElement.querySelector('.transport-time');
  const readout = containerElement.querySelector('.transport-readout');
  const indexWaiting = containerElement.querySelector('.index-waiting');
  const exactnessWarning = containerElement.querySelector('.exactness-warning');

  let scrubbingWasPlaying = false;
  let isDraggingScrubber = false;

  // A seek that is still catching up mutes the scrubber's thumb, but only
  // once it has taken a moment — an already-cached nearby frame resolves
  // within a tick or two, and greying the thumb for that would just flicker.
  // Never armed while dragging: rapid-fire seeks mid-drag are expected to lag
  // a little, and muting on every intermediate tick would be noise, not
  // signal (see 'seek-pending-changed' below for how pointerup catches up
  // on a drag's final, possibly-slow frame).
  const PENDING_INDICATOR_DELAY_MILLISECONDS = 400;
  let pendingIndicatorTimer = null;

  function clearPendingIndicator() {
    if (pendingIndicatorTimer !== null) {
      clearTimeout(pendingIndicatorTimer);
      pendingIndicatorTimer = null;
    }
    scrubber.classList.remove('seek-pending');
  }

  function armPendingIndicator() {
    if (isDraggingScrubber || pendingIndicatorTimer !== null) return;
    pendingIndicatorTimer = setTimeout(() => {
      pendingIndicatorTimer = null;
      if (app.isSeekPending) scrubber.classList.add('seek-pending');
    }, PENDING_INDICATOR_DELAY_MILLISECONDS);
  }

  playButton.addEventListener('click', () => app.togglePlayback());

  stepBackwardButton.addEventListener('click', () => app.stepFrame(-1));
  stepForwardButton.addEventListener('click', () => app.stepFrame(1));

  // Holding the scrubber suspends playback; releasing it resumes.
  scrubber.addEventListener('pointerdown', () => {
    isDraggingScrubber = true;
    clearPendingIndicator();
    if (app.engine && !app.engine.paused) {
      scrubbingWasPlaying = true;
      app.engine.pause();
    }
  });
  scrubber.addEventListener('input', () => {
    app.seekToFrame(Number(scrubber.value));
  });
  scrubber.addEventListener('pointerup', () => {
    isDraggingScrubber = false;
    // The drag's final frame may itself still be catching up; 'seek-pending-changed'
    // already fired (and was ignored) while isDraggingScrubber was true, so pick
    // it up here rather than waiting for a change that already happened.
    if (app.isSeekPending) armPendingIndicator();
    if (scrubbingWasPlaying) {
      scrubbingWasPlaying = false;
      app.engine?.play();
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
    const declaredDuration = engine.expectedDuration ?? 0;
    const totalTimeText = indexState !== 'growing' ? formatTime(engine.duration)
      : declaredDuration > 0 ? `~${formatTime(declaredDuration)}`
      : `${formatTime(engine.duration)}+`;
    frameTotal.textContent = `/ ${totalFramesText}`;
    timeReadout.textContent = `${formatTime(engine.currentTime)} / ${totalTimeText}`;
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
    // user types a shorter or longer one.
    frameInput.style.width = `${String(maximum).length + 1}ch`;
    updateFrameDisplays();
  }

  function updateControls() {
    const engine = app.engine;
    const hasVideo = engine !== null;
    for (const control of [playButton, stepBackwardButton, stepForwardButton, scrubber, frameInput]) {
      control.disabled = !hasVideo;
    }
    if (!hasVideo) return;
    playButton.textContent = engine.paused ? '▶' : '⏸';
    updateIndexDisplays();
  }

  app.addEventListener('video-loaded', updateControls);
  app.addEventListener('frame-changed', updateFrameDisplays);
  app.addEventListener('playback-changed', updateControls);
  app.addEventListener('index-changed', updateIndexDisplays);
  app.addEventListener('seek-pending-changed', () => {
    if (app.isSeekPending) armPendingIndicator();
    else clearPendingIndicator();
  });

  updateControls();
}
