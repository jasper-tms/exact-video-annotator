// Transport bar: play/pause, single-frame stepping, a frame-unit scrubber,
// a numeric frame input, and a readout. Everything is denominated in integer
// frame indices; times shown are derived from the engine, never the reverse.

export function initializeTransport(app, containerElement) {
  containerElement.innerHTML = `
    <button class="transport-play" title="Play/pause (Space)" disabled>▶</button>
    <button class="transport-step-backward" title="Back one frame (← or ,)" disabled>⏮︎</button>
    <button class="transport-step-forward" title="Forward one frame (→ or .)" disabled>⏭︎</button>
    <input type="range" class="transport-scrubber" min="0" max="0" step="1" value="0" disabled>
    <input type="text" class="transport-frame-input" inputmode="numeric"
           title="Frame number (press Enter to jump)" disabled>
    <span class="transport-readout"></span>
    <span class="exactness-warning" hidden
          title="This clip could not be indexed, so frame numbers are only as good as an assumed constant frame rate."
          >frame numbers approximate</span>
  `;

  const playButton = containerElement.querySelector('.transport-play');
  const stepBackwardButton = containerElement.querySelector('.transport-step-backward');
  const stepForwardButton = containerElement.querySelector('.transport-step-forward');
  const scrubber = containerElement.querySelector('.transport-scrubber');
  const frameInput = containerElement.querySelector('.transport-frame-input');
  const readout = containerElement.querySelector('.transport-readout');
  const exactnessWarning = containerElement.querySelector('.exactness-warning');

  let scrubbingWasPlaying = false;

  playButton.addEventListener('click', () => app.togglePlayback());

  stepBackwardButton.addEventListener('click', () => app.stepFrame(-1));
  stepForwardButton.addEventListener('click', () => app.stepFrame(1));

  // Holding the scrubber suspends playback; releasing it resumes.
  scrubber.addEventListener('pointerdown', () => {
    if (app.engine && !app.engine.paused) {
      scrubbingWasPlaying = true;
      app.engine.pause();
    }
  });
  scrubber.addEventListener('input', () => {
    app.seekToFrame(Number(scrubber.value));
  });
  scrubber.addEventListener('pointerup', () => {
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

  frameInput.addEventListener('keydown', (event) => {
    event.stopPropagation();   // typing digits must not trigger global hotkeys
    if (event.key === 'Enter') {
      const frameNumber = Number.parseInt(frameInput.value, 10);
      if (Number.isInteger(frameNumber)) app.seekToFrame(frameNumber);
      frameInput.blur();
    } else if (event.key === 'Escape') {
      frameInput.blur();
    }
  });
  frameInput.addEventListener('blur', () => updateFrameDisplays());

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '0:00.00';
    const wholeMinutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds - wholeMinutes * 60;
    return `${wholeMinutes}:${remainingSeconds.toFixed(2).padStart(5, '0')}`;
  }

  function updateFrameDisplays() {
    const engine = app.engine;
    if (!engine) return;
    const frame = engine.currentFrame ?? 0;
    scrubber.value = String(frame);
    if (document.activeElement !== frameInput) frameInput.value = String(frame);
    const lastFrame = Math.max(0, (engine.numFrames ?? 1) - 1);
    readout.textContent =
      `frame ${frame} / ${lastFrame} · ${formatTime(engine.currentTime)} / ${formatTime(engine.duration)}`;
  }

  function updateControls() {
    const engine = app.engine;
    const hasVideo = engine !== null;
    for (const control of [playButton, stepBackwardButton, stepForwardButton, scrubber, frameInput]) {
      control.disabled = !hasVideo;
    }
    if (!hasVideo) return;
    playButton.textContent = engine.paused ? '▶' : '⏸';
    scrubber.max = String(Math.max(0, (engine.numFrames ?? 1) - 1));
    exactnessWarning.hidden = engine.frameIndexIsExact !== false;
    updateFrameDisplays();
  }

  app.addEventListener('video-loaded', updateControls);
  app.addEventListener('frame-changed', updateFrameDisplays);
  app.addEventListener('playback-changed', updateControls);

  updateControls();
}
