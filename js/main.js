// Application wiring: owns the app object (state + events), the video
// pipeline, the animation loop, tool switching, global keyboard handling,
// import/export, and autosave. See ARCHITECTURE.md for every contract.

import { Viewer } from './viewer.js';
import { VideoLayer } from './layers/video-layer.js';
import { CoordinatesLayer } from './layers/coordinates-layer.js';
import { SegmentationLayer } from './layers/segmentation-layer.js';
import { FramesLayer } from './layers/frames-layer.js';
import { UndoHistory } from './undo.js';
import {
  createEmptyDocument, documentToJson, documentFromJson, newId,
  autosaveKey, saveAutosave, loadAutosave,
} from './document.js';
import { getSyncedPlaybackPacing } from './synced-playback-preference.js';
import { panTool } from './tools/pan-tool.js';
import { findPlugin } from './plugins/registry.js';
import { refitSelectedItem } from './plugins/refit.js';
import { pointTool } from './tools/point-tool.js';
import { polylineTool } from './tools/polyline-tool.js';
import { lineTool } from './tools/line-tool.js';
import { initializeEventHotkeys } from './tools/event-hotkeys.js';
import { initializeTransport } from './ui/transport.js';
import { initializeLayerTabs } from './ui/layer-tabs.js';
import { initializeLayerDetail } from './ui/layer-detail.js';
import { initializeAnnotationsTable } from './ui/annotations-table.js';
import { initializeClassManager } from './ui/class-manager.js';
import { initializeToasts } from './ui/toasts.js';
import { initializeSettingsModal } from './ui/settings-modal.js';
import { getSecondVideoBehavior, setSecondVideoBehavior } from './second-video-preference.js';
import { promptForSecondVideoChoice } from './ui/second-video-prompt.js';
import { drawPixelGrid } from './pixel-grid.js';

const ANNOTATION_LAYER_CONSTRUCTORS = {
  coordinates: CoordinatesLayer,
  segmentation: SegmentationLayer,
  frames: FramesLayer,
};

/** Layer type key -> the required tool, for the tool-rail's availability check. */
const TOOL_REQUIRED_LAYER_TYPE = { point: 'coordinates', line: 'coordinates', polyline: 'coordinates' };

function layerTypeDisplayName(type) {
  return `${type[0].toUpperCase()}${type.slice(1)}`;
}

const AUTOSAVE_DEBOUNCE_MILLISECONDS = 500;

// How long a seek must sit unresolved before the stall is shown on screen
// (the video picture dims) — see isSeekPendingDisplay.
const SEEK_PENDING_DISPLAY_DELAY_MILLISECONDS = 80;

// A growing index publishes frames faster than a panel rebuild is worth; this
// is how often those publishes are allowed to reach the UI. A settled index
// bypasses it — see attachEngine.
const INDEX_EVENT_THROTTLE_MILLISECONDS = 200;

class Application extends EventTarget {
  viewer = null;
  // The video whose engine drives the transport bar, the meaning of every
  // annotation frame index, and the autosave key. The first video loaded;
  // closing it promotes the next remaining video. Other videos are FOLLOWERS,
  // seeked to match it per their link settings (see synchronizeFollowerVideos).
  primaryVideoLayer = null;
  annotationDocument = createEmptyDocument();
  undoHistory = new UndoHistory();
  selection = null;
  hover = null;
  activeTool = null;
  activeLayerId = null;
  activeClassId = null;
  // How newly drawn point/shape annotations are bound in time:
  //   'anchored' — the item belongs to the current frame (frame = integer)
  //   'agnostic' — the item applies across every frame (frame = null)
  annotationMode = 'anchored';
  #keyHandlers = [];
  #autosaveTimer = null;
  // The frame last asked for via seekToFrame/stepFrame, kept to answer
  // isSeekPending: whether the engine has actually caught up to it yet.
  #requestedFrame = null;
  // Backing state for isSeekPendingDisplay; see that getter and
  // updateSeekPendingDisplay for the delay/suppression rules.
  #scrubDragActive = false;
  #seekPendingDisplayTimer = null;
  #isSeekPendingDisplay = false;
  // Synchronized multi-video playback: with more than one video open, the app
  // drives every engine from one master clock (never engine.play()) and only
  // paints once all of them have their target frame. See startSyncedPlayback /
  // driveSyncedPlayback and ARCHITECTURE.md's "Multiple videos" section. These
  // are session-only, like the followers' own link settings.
  isSyncedPlaying = false;
  #syncedPacing = 'realtime';         // captured at play start from the preference
  #syncedPlayStartWall = null;        // performance.now() at the first driven tick
  #syncedPlayStartTime = null;        // primary time (seconds) at that first tick
  #lastPaintedFrame = -1;             // primary frame of the last painted composite
  #syncedTargetFrame = null;          // primary frame every engine is currently aimed at
                                      // (the in-flight target); null before the first is issued
  #syncedFollowerTargets = new Map(); // follower layer -> its aimed frame, so the paint barrier
                                      // can re-check readiness without re-seeking every tick
  // Single-video fast path: when only one video is visible the app plays that one
  // engine natively (engine.play(), which drops frames itself to hold real time)
  // rather than driving the master-clock seek loop, so a hidden second video never
  // slows the visible one. Holds that engine's layer while it plays; null when a
  // synchronized play is running or nothing is playing.
  #soloPlayLayer = null;

  /* ---------- Coordinates ---------- */

  localFromWorld(layer, worldPoint) {
    const { scale, offsetX, offsetY } = layer.transform;
    return { x: (worldPoint.x - offsetX) / scale, y: (worldPoint.y - offsetY) / scale };
  }

  worldFromLocal(layer, localPoint) {
    const { scale, offsetX, offsetY } = layer.transform;
    return { x: localPoint.x * scale + offsetX, y: localPoint.y * scale + offsetY };
  }

  /* ---------- Selection ---------- */

  setSelection(selectionOrNull) {
    this.selection = selectionOrNull;
    this.dispatchEvent(new CustomEvent('selection-changed'));
    this.viewer.requestRender();
  }

  /** Delete the current selection — a single vertex when one is selected,
      otherwise the whole item. Returns true if something was deleted. Bound to
      Delete / Backspace globally, so it works no matter which tool is active. */
  deleteSelection() {
    const selection = this.selection;
    if (!selection) return false;
    const layer = this.viewer.layers.find((candidate) => candidate.id === selection.layerId);
    if (!layer?.isEditable) return false;
    const command = (selection.vertexIndex !== null && layer.commandDeleteVertex)
      ? layer.commandDeleteVertex(selection.itemId, selection.vertexIndex)
      : layer.commandDeleteItem(selection.itemId);
    if (!command) return false;
    this.setSelection(null);
    this.undoHistory.execute(command);
    return true;
  }

  /* ---------- Videos ---------- */

  get videoLayers() {
    return this.viewer.layers.filter((layer) => layer.type === 'video');
  }

  /** The video layers actually contributing pixels to the stage — hidden or
      fully-transparent ones do not. Playback-mode selection reads this (not
      videoLayers) so that hiding all but one video drops the app back to the
      single-video fast path (see shouldUseSyncedPlayback / startPlayback). */
  get visibleVideoLayers() {
    return this.videoLayers.filter((layer) => layer.visible && layer.opacity > 0);
  }

  /** The primary video's engine, or null before any video loads. Everything
      that predates multiple videos (transport, seeking, autosave) reads this
      alias and keeps meaning exactly what it always meant. */
  get engine() { return this.primaryVideoLayer?.engine ?? null; }

  /** The primary video's facts (see videoInformationFromEngine), or null. */
  get videoInformation() { return this.primaryVideoLayer?.videoInformation ?? null; }

  /** The frame a follower video should be sitting on right now, per its link
      settings. 'frame-index' pairs equal frame numbers (plus an offset in
      frames); 'timestamp' pairs the NEAREST presentation times (plus an offset
      in seconds), through the follower's own frame↔time table — never an assumed
      frame rate. Clamped to the follower's indexed range, which while its
      index is still growing is a floor that rises.

      Nearest, not "largest frame at or below t": the engine's `frameAtTime` is a
      floor, and flooring a timestamp correspondence is not stable across a
      primary swap. When two clips' frame boundaries don't line up, following A
      from B lands on B's frame at or before A's time, so an A→B→A swap floors on
      each leg and walks one frame backward every round trip. Shifting the lookup
      by half a frame turns the floor into round-to-nearest, which round-trips
      exactly (and also lands an exact frame boundary on its own frame, the float-
      error case the old ten-thousandth-of-a-frame snap guarded by hand). */
  #followerHalfFrame(engine) {
    return engine.numFrames > 0 ? engine.duration / engine.numFrames / 2 : 0;
  }

  followerTargetFrame(videoLayer) {
    const primaryEngine = this.engine;
    const followerEngine = videoLayer.engine;
    const targetFrame = videoLayer.linkMode === 'timestamp'
      ? followerEngine.frameAtTime(primaryEngine.currentTime + videoLayer.temporalOffset
        + this.#followerHalfFrame(followerEngine))
      : primaryEngine.currentFrame + Math.round(videoLayer.temporalOffset);
    const lastFrame = Math.max(0, (followerEngine.numFrames ?? 1) - 1);
    return Math.min(lastFrame, Math.max(0, targetFrame));
  }

  /** Put one follower on the frame matching the primary right now, per its link
      settings, and return the frame it was aimed at — or -1 when the primary's
      position falls outside this follower's own content, where it has no frame.
      There it is marked `inVoid` (VideoLayer.draw then paints only a grey
      placement outline) and -1 is returned, which the synchronized-playback
      barrier treats as ready-with-nothing-to-decode.

      A follower is out of content three ways, all "no frame here":
      - Past its last frame — the shared timeline runs beyond this shorter
        video's duration. A composition fact the app owns: the engine has no
        past-the-end, clamping currentTime to [0, duration], so this is caught
        by time before touching the engine.
      - Before its first frame — a negative-enough offset. Caught by time too.
      - Inside a leading empty edit's void — a real region of the media the
        engine knows. frameAtTime clamps up into it and cannot reveal it, so
        probe: set the playhead to the raw target time and read currentFrame,
        which is -1 there. (In frame-index mode there is no such void, only the
        two out-of-range ends.)

      Within content it seeks to the exact matching frame — the nearest frame,
      via followerTargetFrame's half-frame rounding — rather than leaving the
      playhead on the raw time. */
  applyFollowerTarget(videoLayer) {
    const followerEngine = videoLayer.engine;
    const lastFrame = Math.max(0, (followerEngine.numFrames ?? 1) - 1);
    let inVoid;
    if (videoLayer.linkMode === 'timestamp') {
      const targetTime = this.engine.currentTime + videoLayer.temporalOffset;
      // The void's edges get the same half-frame tolerance followerTargetFrame
      // rounds by: a target within half a frame of the first (or past the last)
      // frame rounds to that frame instead of flipping to the void. Two clips
      // whose frame boundaries don't line up otherwise show the void over a
      // fraction of a frame — an overlay's frame at 2.9996 s against a clip whose
      // first frame is at 3.000 s reads 0.4 ms "before the first frame" and,
      // without the tolerance, draws the void there. Beyond half a frame it is a
      // genuine gap.
      const halfFrame = this.#followerHalfFrame(followerEngine);
      inVoid = targetTime < -halfFrame || targetTime >= followerEngine.duration + halfFrame;
      if (!inVoid) {
        followerEngine.currentTime = targetTime + halfFrame;
        inVoid = followerEngine.currentFrame === -1;
      }
    } else {
      const rawFrame = this.engine.currentFrame + Math.round(videoLayer.temporalOffset);
      inVoid = rawFrame < 0 || rawFrame > lastFrame;
    }
    videoLayer.inVoid = inVoid;
    if (inVoid) return -1;
    const targetFrame = this.followerTargetFrame(videoLayer);
    followerEngine.seekToFrame(targetFrame);
    return targetFrame;
  }

  /** Seek every follower video to its frame matching the primary's. Called on
      each discrete frame change and on pause — never per tick of continuous
      playback, which only the primary plays (synchronized multi-engine
      playback drifts; seek-following is exact for stepping and scrubbing,
      which is how annotation actually happens). */
  synchronizeFollowerVideos() {
    if (!this.primaryVideoLayer) return;
    for (const videoLayer of this.videoLayers) {
      if (videoLayer === this.primaryVideoLayer) continue;
      const beforeFrame = videoLayer.engine.currentFrame;
      const beforeVoid = videoLayer.inVoid;
      this.applyFollowerTarget(videoLayer);
      // The picture changes both when the frame moves and when the follower
      // crosses into or out of a void (past-the-end leaves currentFrame put but
      // swaps the picture for the outline), so a repaint keys off either.
      if (videoLayer.engine.currentFrame !== beforeFrame || videoLayer.inVoid !== beforeVoid) {
        this.viewer.requestRender();
      }
    }
  }

  /** Switch a follower's link mode, keeping whatever offset is already in the
      box — 0 unless the user has typed one this session. It deliberately does
      NOT compute an alignment-preserving offset: injecting a number into the
      box on a mode toggle was surprising, and the common case aligns the two
      videos at offset 0 anyway. The only adjustment is the unit's integer
      constraint: a frame offset must be whole, so a fractional value carried
      over from timestamp mode is rounded. */
  setVideoLinkMode(videoLayer, linkMode) {
    if (linkMode === videoLayer.linkMode) return;
    const temporalOffset = linkMode === 'timestamp'
      ? videoLayer.temporalOffset : Math.round(videoLayer.temporalOffset);
    videoLayer.setLinkMode(linkMode, temporalOffset);
    this.synchronizeFollowerVideos();
  }

  setVideoTemporalOffset(videoLayer, temporalOffset) {
    videoLayer.setTemporalOffset(videoLayer.linkMode === 'timestamp'
      ? temporalOffset : Math.round(temporalOffset));
    this.synchronizeFollowerVideos();
  }

  /** Close a video: destroy its engine, remove its offscreen host and its
      layer. Closing the primary promotes the next remaining video (bottom of
      the stack first) — annotation frame indices then mean THAT video's
      frames, and the autosave key follows it. Not undoable: an engine cannot
      be revived, only reloaded. */
  closeVideoLayer(layerId) {
    const videoLayer = this.videoLayers.find((layer) => layer.id === layerId);
    if (!videoLayer) return;
    const wasPrimary = videoLayer === this.primaryVideoLayer;
    // Drop a solo-play pointer at the engine about to be destroyed before
    // anything (isPlaying, reconcile) reads it.
    if (this.#soloPlayLayer === videoLayer) this.#soloPlayLayer = null;
    releaseVideoLoad(videoLayer);
    videoLayer.engine.destroy();
    videoLayer.hostElement.remove();
    this.viewer.removeLayer(videoLayer);
    if (this.activeLayerId === layerId) this.activeLayerId = null;
    if (wasPrimary) {
      const promotedLayer = this.videoLayers[0] ?? null;
      this.primaryVideoLayer = promotedLayer;
      // The promoted video stops being a follower, so its link settings no
      // longer mean anything; reset them to the default for if it is ever
      // demoted back to a follower.
      promotedLayer?.setLinkMode('timestamp', 0);
      this.invalidateSeekTarget();
    }
    this.synchronizeFollowerVideos();
    // Removing a video can change which playback mode fits (e.g. synced down to a
    // single remaining visible video should hand back to native play).
    this.reconcilePlaybackMode();
    updateDropHint();
    this.dispatchEvent(new CustomEvent('layers-changed'));
    // The transport and panels re-read app.engine on these, whether it is now
    // a promoted video's engine or null.
    this.dispatchEvent(new CustomEvent('video-loaded'));
    this.dispatchEvent(new CustomEvent('frame-changed'));
    this.dispatchEvent(new CustomEvent('index-changed'));
    this.viewer.requestRender();
  }

  /** Re-evaluate which video owns the clock after a layer reorder: the leftmost
      video layer (bottom of the stack, `videoLayers[0]`) is always the primary,
      so dragging a video tab to the far left promotes it. Called after every
      reorder; a no-op unless the leftmost video actually changed.

      Promotion preserves alignment, changing nothing but link offsets. The old
      primary, which had no follower offset, becomes a follower in the promoted
      video's link mode with its offset NEGATED — the exact inverse relationship,
      so the two videos' relative timing is unchanged. Any further followers have
      the promoted video's offset subtracted out (same unit), or, if their mode
      differs from the promoted video's, their offset re-derived from where they
      currently sit — either way their alignment to the scene is preserved. The
      promoted video's own link settings, meaningless while it is primary, reset
      to the default. Annotations are untouched: their frame numbers now read
      against the new primary, exactly as closing the old primary already does. */
  reconcilePrimaryWithLayerOrder() {
    const newPrimary = this.videoLayers[0] ?? null;
    const oldPrimary = this.primaryVideoLayer;
    if (!newPrimary || newPrimary === oldPrimary) return;

    const promotedMode = newPrimary.linkMode;
    const promotedOffset = newPrimary.temporalOffset;
    // The promoted video stops being a follower, so it stops being a void: a
    // primary always shows a real frame. If it was sitting outside its own frame
    // range — a follower parked in its leading void (currentFrame -1) or past its
    // end — snap its playhead onto the nearest real frame so the video now
    // driving the timeline has a valid position. The offsets derived below then
    // read this snapped position, and the closing requestRender repaints it.
    newPrimary.inVoid = false;
    const lastFrame = Math.max(0, (newPrimary.engine.numFrames ?? 1) - 1);
    const primaryFrame = newPrimary.engine.currentFrame;
    if (primaryFrame < 0 || primaryFrame > lastFrame) {
      newPrimary.engine.seekToFrame(Math.min(lastFrame, Math.max(0, primaryFrame)));
    }
    for (const videoLayer of this.videoLayers) {
      if (videoLayer === newPrimary) continue;
      if (videoLayer === oldPrimary) {
        videoLayer.setLinkMode(promotedMode, promotedMode === 'timestamp'
          ? -promotedOffset : -Math.round(promotedOffset));
      } else if (videoLayer.linkMode === promotedMode) {
        videoLayer.setTemporalOffset(videoLayer.temporalOffset - promotedOffset);
      } else {
        videoLayer.setTemporalOffset(videoLayer.linkMode === 'timestamp'
          ? Number((videoLayer.engine.currentTime - newPrimary.engine.currentTime).toFixed(4))
          : videoLayer.engine.currentFrame - newPrimary.engine.currentFrame);
      }
    }
    newPrimary.setLinkMode('timestamp', 0);
    this.primaryVideoLayer = newPrimary;
    this.invalidateSeekTarget();
    // If this happened mid synchronized playback, the master clock was anchored
    // on the old primary's time; drop the anchor so the next tick re-anchors on
    // the new primary and playback carries on without a jump. Drop the in-flight
    // target too, so the next tick re-aims every engine off the new primary.
    this.#syncedPlayStartWall = null;
    this.#syncedPlayStartTime = null;
    this.#syncedTargetFrame = null;
    this.#syncedFollowerTargets.clear();
    this.synchronizeFollowerVideos();
    this.dispatchEvent(new CustomEvent('layers-changed'));
    // The transport and panels re-read app.engine/videoInformation on these.
    this.dispatchEvent(new CustomEvent('video-loaded'));
    this.dispatchEvent(new CustomEvent('frame-changed'));
    this.dispatchEvent(new CustomEvent('index-changed'));
    this.viewer.requestRender();
  }

  /* ---------- Playback ---------- */

  get currentFrame() { return this.engine?.currentFrame ?? 0; }

  /** The primary frame of the last composite actually PAINTED during synchronized
      playback — the frame whose pixels are on screen. Under load the in-flight
      target (primary.currentFrame) is seeked ahead of this, so overlays and
      frame-anchored annotations must align to this value, not currentFrame, while
      synced playback runs. Outside synced playback it trails currentFrame and is
      not read. */
  get syncedPaintedFrame() { return this.#lastPaintedFrame; }

  /** Whether the pixels on screen have not yet caught up with the last seek.
      `currentFrame` lands the instant a seek is requested — on the WebCodecs
      tier, before the target frame is necessarily decoded — so a host that
      wants to know whether the picture itself has settled needs to compare
      against `presentedFrame` instead. Always false during playback: only a
      discrete, paused seek (a scrub click, a step, a table-row jump) counts
      as "pending" in this sense. */
  get isSeekPending() {
    return this.engine != null && this.engine.paused
      && this.#requestedFrame !== null
      // Older pinned engine builds have no presentedFrame; degrade to "never
      // pending" rather than comparing against undefined, which would never
      // match a real frame index and leave this stuck true forever.
      && typeof this.engine.presentedFrame === 'number'
      && this.engine.presentedFrame !== this.#requestedFrame;
  }

  /** Whether a stalled seek has been unresolved long enough to show on
      screen. Anything that indicates the stall (currently the video picture
      dimming in video-layer.js) keys off this single flag rather than
      running its own timer, so future indicators would change in step with
      it. Only true once isSeekPending has held for
      SEEK_PENDING_DISPLAY_DELAY_MILLISECONDS with no scrubber drag in
      progress — a seek that resolves within a tick or two, or one still
      being dragged through, should not flicker the indicator. */
  get isSeekPendingDisplay() { return this.#isSeekPendingDisplay; }

  #setSeekPendingDisplay(value) {
    if (this.#isSeekPendingDisplay === value) return;
    this.#isSeekPendingDisplay = value;
    this.dispatchEvent(new CustomEvent('seek-pending-display-changed'));
    // The flag can flip from a setTimeout, with no frame or index change to
    // otherwise trigger a repaint — request one directly so the video's own
    // dimming (see video-layer.js) shows up without waiting on something
    // unrelated to nudge the animation loop.
    this.viewer?.requestRender();
  }

  /** Re-evaluates isSeekPendingDisplay. Call whenever isSeekPending changes
      and whenever a scrubber drag starts or ends. */
  updateSeekPendingDisplay() {
    if (this.#seekPendingDisplayTimer !== null) {
      clearTimeout(this.#seekPendingDisplayTimer);
      this.#seekPendingDisplayTimer = null;
    }
    if (!this.isSeekPending || this.#scrubDragActive) {
      this.#setSeekPendingDisplay(false);
      return;
    }
    this.#seekPendingDisplayTimer = setTimeout(() => {
      this.#seekPendingDisplayTimer = null;
      if (this.isSeekPending && !this.#scrubDragActive) this.#setSeekPendingDisplay(true);
    }, SEEK_PENDING_DISPLAY_DELAY_MILLISECONDS);
  }

  /** Holding the scrubber suspends the seek-pending display: rapid-fire seeks
      mid-drag are expected to lag a little, and flagging every intermediate
      tick would be noise, not signal. Re-evaluated on release, so a drag's
      final, possibly-slow frame still gets flagged. */
  setScrubDragActive(active) {
    this.#scrubDragActive = active;
    this.updateSeekPendingDisplay();
  }

  /** The `frame` value a newly drawn annotation should get: the current frame
      in anchored mode, or null (applies to every frame) in agnostic mode. */
  get newItemFrame() {
    return this.annotationMode === 'agnostic' ? null : this.currentFrame;
  }

  setAnnotationMode(mode) {
    if (mode !== 'anchored' && mode !== 'agnostic') return;
    if (mode === this.annotationMode) return;
    this.annotationMode = mode;
    this.dispatchEvent(new CustomEvent('annotation-mode-changed'));
  }

  /** Playback supersedes any discrete seek: once the engine is playing, the
      last requested frame is no longer a target the picture is chasing, and
      keeping it around would make isSeekPending read true forever after the
      next pause (the playhead has moved past it, so presentedFrame can never
      match it again). The animation loop calls this on every unpaused tick. */
  invalidateSeekTarget() {
    this.#requestedFrame = null;
  }

  seekToFrame(frameIndex) {
    if (!this.engine) return;
    const lastFrame = Math.max(0, (this.engine.numFrames ?? 1) - 1);
    const clampedFrame = Math.min(lastFrame, Math.max(0, frameIndex));
    this.#requestedFrame = clampedFrame;
    this.engine.seekToFrame(clampedFrame);
    this.viewer.requestRender();
  }

  /** True whenever the playhead is advancing, whether via a single engine's
      own play() or the app-driven synchronized loop. The transport button and
      every "pause first" caller read this rather than engine.paused, since a
      synchronized play leaves each engine's own `paused` true throughout. */
  get isPlaying() {
    if (this.isSyncedPlaying) return true;
    // The single-video fast path may be playing a follower's engine rather than
    // the primary's, so read the engine that is actually driving (#soloPlayLayer),
    // falling back to the primary for the ordinary single-video case.
    const engine = (this.#soloPlayLayer ?? this.primaryVideoLayer)?.engine;
    return engine != null && !engine.paused;
  }

  /** Synchronized playback applies when more than one video is VISIBLE and every
      visible one is on the WebCodecs tier (where a forward-by-one seek is cheap,
      so the master-clock loop stays smooth — proven by the engine's sync
      benchmark). With a single video visible — including the case where a second
      video is loaded but hidden — or any visible follower on the native tier,
      playback stays a single engine's own play() (which drops frames itself to
      hold real time) and hidden followers do no work. Keying off visibility, not
      the loaded count, is what keeps a hidden second video from slowing the one
      on screen. */
  shouldUseSyncedPlayback() {
    const visible = this.visibleVideoLayers;
    return visible.length > 1
      && visible.every((layer) => layer.engine.tier === 'webcodecs');
  }

  togglePlayback() {
    if (!this.engine) return;
    if (this.isPlaying) this.pausePlayback();
    else this.startPlayback();
  }

  startPlayback() {
    if (!this.engine || this.isPlaying) return;
    if (this.shouldUseSyncedPlayback()) {
      this.startSyncedPlayback();
    } else {
      // Play the one visible video (its own engine drops frames natively). With
      // no video visible, or several visible but not all WebCodecs, fall back to
      // the primary — the historical single-engine path, followers catching up on
      // pause. #soloPlayLayer records which engine is driving so pause/isPlaying
      // act on it rather than assuming the primary.
      const visible = this.visibleVideoLayers;
      this.#soloPlayLayer = visible.length === 1 ? visible[0] : this.primaryVideoLayer;
      this.#soloPlayLayer.engine.play();
    }
    this.dispatchEvent(new CustomEvent('playback-changed'));
  }

  pausePlayback() {
    if (!this.engine || !this.isPlaying) return;
    if (this.isSyncedPlaying) {
      this.stopSyncedPlayback();
    } else {
      const soloLayer = this.#soloPlayLayer ?? this.primaryVideoLayer;
      soloLayer.engine.pause();
      // A follower played on its own has advanced independently of the (hidden)
      // primary; leave it on the frame it stopped on rather than letting the
      // pause-time resync yank it back to the primary's position. When the
      // primary itself was the one playing, the followers do want to catch up —
      // the animation loop's paused-engine resync handles that.
      this.#soloPlayLayer = null;
    }
    this.dispatchEvent(new CustomEvent('playback-changed'));
  }

  /** Re-evaluate which playback mode fits and switch to it in place if the
      running one no longer does — called when a video layer's visibility or
      opacity changes, or a video is added or removed, WHILE playing (the mode is
      otherwise chosen once, at play start). Carries the playhead across so
      playback never stops: a second video shown mid solo-play hands off to the
      synchronized loop (which anchors on the primary's current position); the
      last visible video left hands back to that one engine's own play(). A no-op
      when paused — the next startPlayback picks the right mode then. */
  reconcilePlaybackMode() {
    if (!this.isPlaying) return;
    const wantSynced = this.shouldUseSyncedPlayback();
    if (wantSynced && !this.isSyncedPlaying) {
      this.#soloPlayLayer?.engine.pause();
      this.#soloPlayLayer = null;
      this.startSyncedPlayback();
      this.dispatchEvent(new CustomEvent('playback-changed'));
    } else if (!wantSynced && this.isSyncedPlaying) {
      // stopSyncedPlayback settles the primary on the last painted frame, so the
      // handoff resumes from what was on screen rather than an unseen target.
      this.stopSyncedPlayback();
      const visible = this.visibleVideoLayers;
      this.#soloPlayLayer = visible.length === 1 ? visible[0] : this.primaryVideoLayer;
      this.#soloPlayLayer.engine.play();
      this.dispatchEvent(new CustomEvent('playback-changed'));
    } else if (!wantSynced && !this.isSyncedPlaying) {
      // Still solo, but the one visible video may have changed identity (the
      // playing one hidden, another shown). Move native play onto it.
      const visible = this.visibleVideoLayers;
      const desired = visible.length === 1 ? visible[0] : this.primaryVideoLayer;
      if (desired && desired !== this.#soloPlayLayer) {
        this.#soloPlayLayer?.engine.pause();
        this.#soloPlayLayer = desired;
        desired.engine.play();
        this.dispatchEvent(new CustomEvent('playback-changed'));
      }
    }
    // wantSynced && isSyncedPlaying needs nothing: the synced loop already drives
    // every engine through its barrier, so shown videos are already in step and
    // hidden ones stay driven.
  }

  /** Begin driving every engine from one master clock. The clock's zero point
      is fixed on the first driven tick (when a `now` timestamp is in hand), not
      here, so the first frame is not charged the gap between this call and the
      next animation frame. The pacing preference is captured now so it stays
      consistent for the whole run even if the setting is changed mid-playback. */
  startSyncedPlayback() {
    if (this.isSyncedPlaying) return;
    this.isSyncedPlaying = true;
    this.#syncedPacing = getSyncedPlaybackPacing();
    this.#syncedPlayStartWall = null;
    this.#syncedPlayStartTime = null;
    this.#syncedTargetFrame = null;
    this.#syncedFollowerTargets.clear();
    // One before the starting frame, so 'every-frame' pacing (which advances at
    // most one past the last painted) can reach the frame play began on.
    this.#lastPaintedFrame = (this.engine?.currentFrame ?? 0) - 1;
    // A synchronized play supersedes any pending discrete seek, exactly as a
    // single engine's play() does (see invalidateSeekTarget).
    this.invalidateSeekTarget();
  }

  stopSyncedPlayback() {
    if (!this.isSyncedPlaying) return;
    this.isSyncedPlaying = false;
    this.#syncedPlayStartWall = null;
    this.#syncedPlayStartTime = null;
    // Settle the primary on the last frame actually PAINTED, not a later target
    // that was aimed at but never shown — under load ('realtime') the master
    // clock runs ahead of what has been decoded, so without this, pausing would
    // jump the timeline forward onto an unseen frame. Then sync the followers to
    // that settled position so a following step or scrub starts consistent.
    if (this.#lastPaintedFrame >= 0) this.engine?.seekToFrame(this.#lastPaintedFrame);
    this.#syncedTargetFrame = null;
    this.#syncedFollowerTargets.clear();
    this.synchronizeFollowerVideos();
  }

  /** Aim every engine at primary frame `target`: seek the primary there, then
      seek each follower to its matching frame through its own link settings
      (a follower with no frame for this position returns -1 and draws only its
      grey outline). Records what each engine was aimed at in #syncedTargetFrame /
      #syncedFollowerTargets so #syncedBarrierReady can re-check readiness on later
      ticks without re-seeking. */
  #issueSyncedTargets(target) {
    this.engine.seekToFrame(target);
    this.#syncedTargetFrame = target;
    this.#syncedFollowerTargets.clear();
    for (const videoLayer of this.videoLayers) {
      if (videoLayer === this.primaryVideoLayer) continue;
      this.#syncedFollowerTargets.set(videoLayer, this.applyFollowerTarget(videoLayer));
    }
  }

  /** Whether every engine has decoded the frame it was last aimed at, so the
      composite for #syncedTargetFrame is frame-exact across all videos and safe
      to paint. A void follower (-1) has nothing to decode and is always ready. */
  #syncedBarrierReady() {
    return this.videoLayers.every((videoLayer) => {
      const target = videoLayer === this.primaryVideoLayer
        ? this.#syncedTargetFrame
        : this.#syncedFollowerTargets.get(videoLayer);
      return target === -1 || videoLayer.engine.presentedFrame === target;
    });
  }

  /** One tick of synchronized playback, called from the animation loop while
      `isSyncedPlaying`. It aims every engine (the primary included — never
      engine.play()) at one target frame, waits until all of them have decoded it
      (the barrier), paints that exact cross-video composite, and only THEN picks
      the next target from the master clock. Holding the in-flight target until it
      lands — rather than re-seeking to a fresh clock frame every tick — is the
      frame-drop policy: it is what lets any frame reach the screen under load. If
      it re-aimed every tick, the 'realtime' clock would outrun the decoders and
      no single target would ever finish, so nothing would ever paint (the bug
      this replaced). See ARCHITECTURE.md's "Multiple videos" section. */
  driveSyncedPlayback(now) {
    const primary = this.engine;
    if (!primary) { this.stopSyncedPlayback(); return; }
    const lastFrame = Math.max(0, (primary.numFrames ?? 1) - 1);

    if (this.#syncedPlayStartWall === null) {
      this.#syncedPlayStartWall = now;
      this.#syncedPlayStartTime = primary.currentTime;
    }

    // Hold: a target is in flight but not every engine has decoded it yet. Do
    // nothing this tick — do NOT re-seek — and let the decoders keep working
    // (the animation loop already called engine.update on each of them).
    if (this.#syncedTargetFrame !== null && !this.#syncedBarrierReady()) return;

    // The in-flight target (if any) is fully decoded: paint that exact composite.
    if (this.#syncedTargetFrame !== null) {
      if (this.#syncedTargetFrame !== this.#lastPaintedFrame) {
        this.#lastPaintedFrame = this.#syncedTargetFrame;
        this.dispatchEvent(new CustomEvent('frame-changed'));
      }
      this.viewer.requestRender();
    }

    // The clip ends once its last frame has been painted. Loop back to frame 0
    // rather than stopping, matching a single video's own looping playback.
    // Re-anchor the master clock (null start) so the next tick restarts timing at
    // frame 0, and aim every engine there now so the wrap shows frame 0 next.
    if (this.#syncedTargetFrame !== null && this.#syncedTargetFrame >= lastFrame) {
      this.#syncedPlayStartWall = null;
      this.#syncedPlayStartTime = null;
      this.#issueSyncedTargets(0);
      return;
    }

    // Choose the next target from the master clock — elapsed wall-clock time
    // mapped through the primary's own frame↔time table, so neither pacing ever
    // runs faster than real time. 'realtime' jumps straight to wherever the clock
    // has reached, dropping every frame between the last painted and now;
    // 'every-frame' advances at most one frame past the last painted, so nothing
    // is skipped and playback instead falls behind real time until the decoders
    // recover. When they keep up the two are identical — every frame, at real
    // time. frameAtTime never assumes an fps; it binary-searches the real table.
    const masterTime = this.#syncedPlayStartTime + (now - this.#syncedPlayStartWall) / 1000;
    const realtimeFrame = Math.min(lastFrame, primary.frameAtTime(masterTime));
    const nextTarget = this.#syncedPacing === 'every-frame'
      ? Math.min(realtimeFrame, this.#lastPaintedFrame + 1)
      : realtimeFrame;

    // Re-aim only when the clock has moved past the frame just painted; otherwise
    // there is nothing new to decode and the composite on screen still stands.
    if (nextTarget !== this.#syncedTargetFrame) this.#issueSyncedTargets(nextTarget);
  }

  stepFrame(delta) {
    if (!this.engine) return;
    if (this.isPlaying) this.pausePlayback();
    this.seekToFrame(this.currentFrame + delta);
  }

  /* ---------- Layers ---------- */

  get annotationLayers() {
    return this.viewer.layers.filter((layer) => layer.type in ANNOTATION_LAYER_CONSTRUCTORS);
  }

  /** The annotation layer new items go into (never the video layer). */
  get activeLayer() {
    return this.annotationLayers.find((layer) => layer.id === this.activeLayerId)
      ?? this.annotationLayers[0]
      ?? null;
  }

  /** The layer whose details are shown below the canvas — may be any layer,
      including the video layer. */
  get selectedLayer() {
    return this.viewer.layers.find((layer) => layer.id === this.activeLayerId)
      ?? this.activeLayer;
  }

  setActiveLayer(layerId) {
    // A no-op re-selection must not dispatch: the tab bar rebuilds its DOM on
    // every 'layers-changed' event, and doing that on the first click of a
    // double-click (to rename a tab already selected) would detach the very
    // element the second click and dblclick are about to land on.
    if (layerId === this.activeLayerId) return;
    this.activeLayerId = layerId;
    this.dispatchEvent(new CustomEvent('layers-changed'));
  }

  /** The layer new items of this type would go into — the active layer if it
      matches, else the first layer of that type — or null when none exists.
      Never creates a layer, so it is safe to call on every pointer move. */
  findAnnotationLayerForType(type) {
    const active = this.activeLayer;
    if (active?.type === type) return active;
    return this.annotationLayers.find((layer) => layer.type === type) ?? null;
  }

  targetLayerForType(type) {
    return this.findAnnotationLayerForType(type) ?? this.addAnnotationLayer(type);
  }

  /** Reorder the document's layer list to match the viewer's stack order
      (called after layer tabs are dragged into a new order). */
  synchronizeDocumentLayerOrder() {
    const annotationOrderIds = this.annotationLayers.map((layer) => layer.id);
    const documentLayerById = new Map(
      this.annotationDocument.layers.map((documentLayer) => [documentLayer.id, documentLayer]));
    this.annotationDocument.layers = annotationOrderIds
      .map((id) => documentLayerById.get(id))
      .filter((documentLayer) => documentLayer !== undefined);
    this.markDocumentChanged();
  }

  /**
   * Add an annotation layer of the given type. With a pluginId, the layer is
   * that plugin's: same storage type, but built by the plugin so it carries
   * the plugin's annotation logic and settings.
   */
  addAnnotationLayer(type, { pluginId = null } = {}) {
    const plugin = pluginId === null ? null : findPlugin(pluginId);
    const documentLayer = {
      id: newId(), type,
      name: plugin
        ? `${plugin.name} ${this.annotationLayers.filter((layer) => layer.plugin?.id === plugin.id).length + 1}`
        : `${type[0].toUpperCase()}${type.slice(1)} ${this.annotationLayers.filter((layer) => layer.type === type).length + 1}`,
      visible: true, opacity: 1,
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
      items: [],
    };
    if (plugin) documentLayer.plugin = { id: plugin.id, options: {} };
    const viewLayer = this.#createViewLayer(documentLayer);
    this.undoHistory.execute({
      label: 'Add layer',
      apply: () => {
        this.annotationDocument.layers.push(documentLayer);
        this.viewer.addLayer(viewLayer);
        this.dispatchEvent(new CustomEvent('layers-changed'));
      },
      revert: () => {
        this.annotationDocument.layers = this.annotationDocument.layers
          .filter((layer) => layer.id !== documentLayer.id);
        this.viewer.removeLayer(viewLayer);
        this.dispatchEvent(new CustomEvent('layers-changed'));
      },
    });
    return viewLayer;
  }

  removeAnnotationLayer(layerId) {
    const viewLayer = this.annotationLayers.find((layer) => layer.id === layerId);
    const documentLayer = this.annotationDocument.layers.find((layer) => layer.id === layerId);
    if (!viewLayer || !documentLayer) return;
    const documentIndex = this.annotationDocument.layers.indexOf(documentLayer);
    const viewerIndex = this.viewer.layers.indexOf(viewLayer);
    this.undoHistory.execute({
      label: 'Delete layer',
      apply: () => {
        this.annotationDocument.layers.splice(this.annotationDocument.layers.indexOf(documentLayer), 1);
        this.viewer.removeLayer(viewLayer);
        if (this.activeLayerId === layerId) this.activeLayerId = null;
        if (this.selection?.layerId === layerId) this.setSelection(null);
        this.dispatchEvent(new CustomEvent('layers-changed'));
      },
      revert: () => {
        this.annotationDocument.layers.splice(documentIndex, 0, documentLayer);
        this.viewer.addLayer(viewLayer, viewerIndex);
        this.dispatchEvent(new CustomEvent('layers-changed'));
      },
    });
  }

  #createViewLayer(documentLayer) {
    const pluginId = documentLayer.plugin?.id ?? null;
    const plugin = pluginId === null ? null : findPlugin(pluginId);
    if (pluginId !== null && !plugin) {
      // A document written by a build that had this plugin. Its annotations are
      // ordinary items, so open them on a plain layer of the storage type and
      // keep the plugin field so re-exporting does not drop it.
      this.showToast(`Layer "${documentLayer.name}" was made by the "${pluginId}" plugin, `
        + 'which is not available here — opening it as a plain layer.', { kind: 'warning' });
    }
    // The extra `this` (app) argument is only read by CoordinatesLayer (to look
    // up the document's integer-coordinate convention); the other constructors,
    // and every plugin built on one of them, take it and silently ignore it.
    const viewLayer = plugin
      ? plugin.createViewLayer(documentLayer, this)
      : new ANNOTATION_LAYER_CONSTRUCTORS[documentLayer.type](documentLayer, this);
    // Panel edits (name/visibility/opacity/transform, plugin options) flow back
    // to the document.
    viewLayer.addEventListener('layer-changed', () => {
      documentLayer.name = viewLayer.name;
      documentLayer.visible = viewLayer.visible;
      documentLayer.opacity = viewLayer.opacity;
      documentLayer.transform = { ...viewLayer.transform };
      if (documentLayer.type === 'coordinates') {
        documentLayer.allowFractionalCoordinates = viewLayer.allowFractionalCoordinates;
      }
      if (viewLayer.plugin) {
        documentLayer.plugin = { id: viewLayer.plugin.id, options: { ...viewLayer.options } };
      }
      this.markDocumentChanged();
    });
    return viewLayer;
  }

  /** Drop all annotation view layers and rebuild them from the document. */
  rebuildAnnotationLayersFromDocument() {
    for (const layer of [...this.annotationLayers]) this.viewer.removeLayer(layer);
    for (const documentLayer of this.annotationDocument.layers) {
      this.viewer.addLayer(this.#createViewLayer(documentLayer));
    }
    this.activeLayerId = null;
    this.setSelection(null);
    this.dispatchEvent(new CustomEvent('layers-changed'));
  }

  /* ---------- Tools ---------- */

  toolRegistry = Object.fromEntries(
    [panTool, pointTool, polylineTool, lineTool].map((tool) => [tool.id, tool]));

  setActiveTool(toolId) {
    // A null toolId means "no tool selected" — a canvas drag then pans the view.
    const tool = toolId === null ? null : this.toolRegistry[toolId];
    if (toolId !== null && !tool) return;   // unknown tool id
    if (tool === this.activeTool) return;   // already in this state
    this.activeTool?.deactivate?.(this);
    this.activeTool = tool;
    tool?.activate?.(this);
    this.viewer.stageCanvas.style.cursor = tool ? (tool.cursor ?? 'default') : 'grab';
    this.dispatchEvent(new CustomEvent('tool-changed'));
    this.viewer.requestRender();
  }

  /* ---------- Document lifecycle ---------- */

  markDocumentChanged() {
    this.dispatchEvent(new CustomEvent('document-changed'));
    this.viewer.requestRender();
    if (!this.videoInformation) return;
    clearTimeout(this.#autosaveTimer);
    this.#autosaveTimer = setTimeout(() => {
      // The primary video (whose name + size key the autosave) can be closed
      // between scheduling and firing.
      if (!this.videoInformation) return;
      saveAutosave(autosaveKey(this.videoInformation), this.annotationDocument, this.videoInformation);
    }, AUTOSAVE_DEBOUNCE_MILLISECONDS);
  }

  replaceDocument(annotationDocument) {
    this.annotationDocument = annotationDocument;
    this.undoHistory.clear();
    this.rebuildAnnotationLayersFromDocument();
    this.markDocumentChanged();
  }

  /* ---------- Keyboard plumbing ---------- */

  addKeyHandler(handler) { this.#keyHandlers.push(handler); }

  runKeyHandlers(event) {
    return this.#keyHandlers.some((handler) => handler(event));
  }

  isTypingTarget(event) {
    const element = event.target;
    return element instanceof HTMLInputElement
      || element instanceof HTMLTextAreaElement
      || element instanceof HTMLSelectElement
      || (element instanceof HTMLElement && element.isContentEditable);
  }

  showToast(message, options = {}) {
    // Replaced by initializeToasts; fallback for very early errors.
    console.log(`[toast:${options.kind ?? 'info'}] ${message}`);
  }
}

/* ================== Bootstrap ================== */

const app = new Application();
window.exactVideoAnnotator = app;   // console access for debugging

const stageCanvas = document.getElementById('stage-canvas');
const stageContainer = document.getElementById('stage-container');
const videoHost = document.getElementById('video-host');
const dropHint = document.getElementById('drop-hint');
const indexingStatus = document.getElementById('indexing-status');
const hoveredPixelLabel = document.getElementById('hovered-pixel-label');

app.viewer = new Viewer(stageCanvas);

/** Which world pixel the cursor is over — a property of the canvas itself,
    not of whatever media layer happens to be loaded, so it shows regardless
    of whether a video is open. Cleared on pointerleave, below. */
function updateHoveredPixelLabel(worldPoint) {
  const pixelX = Math.floor(worldPoint.x);
  const pixelY = Math.floor(worldPoint.y);
  hoveredPixelLabel.textContent = `x=${pixelX}, y=${pixelY}`;
}
stageCanvas.addEventListener('pointerleave', () => { hoveredPixelLabel.textContent = ''; });

app.viewer.toolDelegate = {
  onPointerDown: (worldPoint, event) => {
    // No tool selected: a canvas drag pans the view (the viewer takes over the
    // move/up of this pointer once panning has begun).
    if (!app.activeTool) { app.viewer.beginPanFromPointerEvent(event); return; }
    app.activeTool.onPointerDown?.(app, worldPoint, event);
  },
  onPointerMove: (worldPoint, event) => {
    updateHoveredPixelLabel(worldPoint);
    app.activeTool?.onPointerMove?.(app, worldPoint, event);
  },
  onPointerUp: (worldPoint, event) => app.activeTool?.onPointerUp?.(app, worldPoint, event),
  onDoubleClick: (worldPoint, event) => app.activeTool?.onDoubleClick?.(app, worldPoint, event),
};
app.viewer.setOverlayPainter((context, renderState) => {
  drawPixelGrid(context, renderState);
  app.activeTool?.drawOverlay?.(context, renderState);
});

initializeToasts(app, document.getElementById('toast-container'));
initializeTransport(app, document.getElementById('transport-container'));
initializeLayerTabs(app, document.getElementById('layer-tabs-container'));
initializeLayerDetail(app, document.getElementById('layer-detail-container'));
initializeClassManager(app, document.getElementById('class-manager-container'));
initializeAnnotationsTable(app, document.getElementById('annotations-table-container'));
initializeSettingsModal(app, document.getElementById('settings-button'));
initializeEventHotkeys(app);

// `r` re-fits the selected annotation on a plugin layer that can fit (the line
// fitter). Registered after the event hotkeys so a user-defined event key named
// `r` keeps winning; it also does nothing unless a fittable item is selected.
app.addKeyHandler((event) => {
  if (event.key !== 'r' && event.key !== 'R') return false;
  return refitSelectedItem(app);
});

app.rebuildAnnotationLayersFromDocument();
app.setActiveTool('pan');

/* ---------- Video loading ---------- */

/** Whether the drop hint invites a first video: shown only while none is open. */
function updateDropHint() {
  dropHint.classList.toggle('hidden', app.videoLayers.length > 0);
}

/** Each engine presents into its own canvas + <video> pair, held by a
    per-video host <div> inside the offscreen #video-host container (the
    engine sizes its canvas backing store from its parent, so each host gets
    a real size — set by VideoLayer to the video's native resolution). */
function createEngineHost() {
  const hostElement = document.createElement('div');
  hostElement.className = 'video-engine-host';
  const engineCanvas = document.createElement('canvas');
  const engineVideoElement = document.createElement('video');
  engineVideoElement.muted = true;
  engineVideoElement.playsInline = true;
  hostElement.append(engineCanvas, engineVideoElement);
  videoHost.appendChild(hostElement);
  return { hostElement, engineCanvas, engineVideoElement };
}

/** Load a video as a NEW layer on top of any videos already open. The first
    video loaded becomes the primary (drives the transport and the meaning of
    annotation frame indices); later ones become followers seeked to match it.
    Re-dropping a clip that is already open simply opens another layer of it —
    two copies of one clip at different temporal offsets is a legitimate way
    to compare moments. */
async function loadVideoSource(source, { name, sizeBytes, replaceVideoLayer = null }) {
  // Ties this load's indexing progress to its own status line, and lets a
  // video closed mid-index silence the pass still reading its file
  // (destroying an engine does not stop an index pass already underway).
  const loadIdentifier = ++mostRecentLoadIdentifier;
  activeLoadIdentifiers.add(loadIdentifier);
  const { hostElement, engineCanvas, engineVideoElement } = createEngineHost();
  try {
    showIndexingStatus(loadIdentifier, name, { fraction: 0, framesFound: 0, etaMs: 0 });
    const engine = await createBestEngine(source, {
      canvas: engineCanvas, video: engineVideoElement,
      // We read and display exact source-pixel values for annotation, never a
      // smoothed approximation of them — the engine defaults to smoothing on
      // (right for a typical video player, wrong for us).
      imageSmoothingEnabled: false,
      // Hand back a playable engine as soon as the opening frames have been
      // certified, and keep indexing the rest underneath it, rather than making
      // someone wait for the last byte of a long clip before they can annotate
      // its first second. Every frame number reported is still exact and
      // permanent — only the SET of nameable frames grows — so an annotation
      // written now against frame 412 keeps meaning that picture. See the
      // engine README's "Playing while the index is still being built".
      playWhileIndexing: true,
      onProgress: (progress) => {
        if (activeLoadIdentifiers.has(loadIdentifier)) {
          showIndexingStatus(loadIdentifier, name, progress);
        }
      },
    });
    attachEngine(engine, { name, sizeBytes, source, hostElement, loadIdentifier, replaceVideoLayer });
  } catch (error) {
    activeLoadIdentifiers.delete(loadIdentifier);
    clearIndexingStatus(loadIdentifier);
    hostElement.remove();
    reportVideoLoadFailure(error, { introduction: `Could not open ${name}:` });
  }
}

/** Decide how a video the user just dropped or opened should join the
    workspace, then load it. With no video open it is simply the first video.
    With two or more already open, a new video always makes a new layer — there
    is no single video to replace. With exactly one open, the "Second video"
    setting decides: 'new-layer' (stack it), 'replace' (swap out that one
    video), or 'prompt' (ask each time, offering to remember the answer). A
    canceled prompt loads nothing. */
async function loadVideoIntoWorkspace(source, meta) {
  const openVideoLayers = app.videoLayers;
  if (openVideoLayers.length !== 1) {
    loadVideoSource(source, meta);
    return;
  }
  let behavior = getSecondVideoBehavior();
  if (behavior === 'prompt') {
    const answer = await promptForSecondVideoChoice();
    if (!answer) return;
    behavior = answer.choice;
    if (answer.save) setSecondVideoBehavior(behavior);
  }
  loadVideoSource(source, behavior === 'replace'
    ? { ...meta, replaceVideoLayer: openVideoLayers[0] }
    : meta);
}

/** A load refusal arrives from the engine (v2.4+) as an UnplayableClipError: a
    message composed to be shown to a person, plus structured fields — reason,
    codec, nativeErrorMessage and friends — meant for the program and the
    console, not the toast (see the engine README). The message explains itself
    and runs a few sentences; for an undecodable codec it ends with the ffmpeg
    re-encode command that fixes it. So it gets a sticky toast the user
    dismisses when done reading, rather than one racing an eight-second timer.
    Anything else thrown (including everything from pre-2.4 engines) still has
    only a message never written for users, which keeps the old lead-in. */
function reportVideoLoadFailure(error, { introduction } = {}) {
  console.error('Video failed to load.', error);
  if (error?.name !== 'UnplayableClipError') {
    app.showToast(`${introduction ?? 'Could not open the video:'} ${error?.message ?? error}`,
      { kind: 'error' });
    return;
  }
  // The engine prefixes messages with the throwing function's name
  // ("createBestEngine: this clip…") for console readers; a toast reads better
  // without it, recapitalized.
  const composedMessage = String(error.message).replace(/^\w+: /, '');
  const displayMessage = composedMessage.charAt(0).toUpperCase() + composedMessage.slice(1);
  app.showToast(introduction ? `${introduction} ${displayMessage}` : displayMessage,
    { kind: 'error', sticky: true });
}

/* ---------- Indexing progress ---------- */

// Numbers loads, so each video's indexing progress writes its own status line
// and a video closed mid-index can silence the pass still reading its file.
let mostRecentLoadIdentifier = 0;
const activeLoadIdentifiers = new Set();

// One status line per video whose index pass is still running, keyed by load
// identifier — two clips indexing at once would otherwise fight over a single
// line. Each is attributed to its video by name.
const indexingStatusLines = new Map();

function formatIndexingEta(milliseconds) {
  // etaMs is 0 at the very start and at the end, where it means "no estimate"
  // rather than "no time left".
  if (!milliseconds) return '';
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return ` (~${seconds} s left)`;
  return ` (~${Math.round(seconds / 60)} min left)`;
}

function showIndexingStatus(loadIdentifier, name, progress) {
  let line = indexingStatusLines.get(loadIdentifier);
  if (!line) {
    line = document.createElement('div');
    indexingStatusLines.set(loadIdentifier, line);
    indexingStatus.appendChild(line);
    indexingStatus.hidden = false;
  }
  const percent = Math.round((progress.fraction ?? 0) * 100);
  const frames = progress.framesFound ?? 0;
  line.textContent =
    `${name}: indexing… ${percent}% · ${frames.toLocaleString()} frames so far${formatIndexingEta(progress.etaMs)}`;
}

function clearIndexingStatus(loadIdentifier) {
  const line = indexingStatusLines.get(loadIdentifier);
  if (!line) return;
  indexingStatusLines.delete(loadIdentifier);
  line.remove();
  if (indexingStatusLines.size === 0) indexingStatus.hidden = true;
}

/** Forget a closed video's load: its indexing status line comes down and any
    index pass still reading its file loses the right to write one. */
function releaseVideoLoad(videoLayer) {
  if (videoLayer.loadIdentifier === null) return;
  activeLoadIdentifiers.delete(videoLayer.loadIdentifier);
  clearIndexingStatus(videoLayer.loadIdentifier);
}

/** The video's facts as the engine currently knows them. While the index is
    still growing these describe the certified prefix, not the whole clip —
    numberOfFrames is a floor and durationSeconds is the time indexed so far —
    which is why `frameIndexState` travels with them into the export instead of
    letting a partial count pass for a total. Rebuilt on every index event, so
    an export taken after the pass finishes carries the finished numbers. */
function videoInformationFromEngine(engine, { name, sizeBytes }) {
  return {
    name,
    sizeBytes: sizeBytes ?? null,
    numberOfFrames: engine.numFrames,
    // Mean rate, provenance only — frame indices are the source of truth.
    frameRate: engine.duration ? Number((engine.numFrames / engine.duration).toFixed(3)) : null,
    frameIndexIsExact: engine.frameIndexIsExact,
    // 'complete' | 'growing' | 'truncated'. The native tier reports none, and
    // only ever hands back a finished index.
    frameIndexState: engine.frameIndexState ?? 'complete',
    durationSeconds: engine.duration,
    declaredDurationSeconds: engine.expectedDuration || null,
    width: engine.videoWidth,
    height: engine.videoHeight,
  };
}

/** Whether this engine still speaks for this layer: the layer is still open
    (in the viewer) and the engine has not been replaced by decode recovery.
    Every listener wired by wireEngineEvents guards on it, since a destroyed
    engine's index pass and throttled dispatches can outlive both. */
function engineIsCurrent(videoLayer, engine) {
  return videoLayer.engine === engine && app.viewer.layers.includes(videoLayer);
}

/** Wire one engine's index and error events to its video layer. Called for a
    freshly loaded engine and again for a replacement engine after decode
    recovery. */
function wireEngineEvents(videoLayer, engine) {
  // The index publishes certified prefixes as it goes; each one moves the frame
  // count, the duration and the scrubber's geometry, so refresh the facts and
  // tell the panels. Publishes can arrive faster than a DOM rebuild is worth,
  // hence the throttle — but a settled index is dispatched immediately, since
  // that is the edge the readout changes color on.
  let lastIndexDispatchMilliseconds = 0;
  let pendingIndexDispatch = null;
  const refreshIndexFacts = ({ immediate }) => {
    if (!engineIsCurrent(videoLayer, engine)) return;
    videoLayer.videoInformation = videoInformationFromEngine(engine, videoLayer.videoInformation);
    clearTimeout(pendingIndexDispatch);
    const sinceLast = performance.now() - lastIndexDispatchMilliseconds;
    if (!immediate && sinceLast < INDEX_EVENT_THROTTLE_MILLISECONDS) {
      pendingIndexDispatch = setTimeout(() => refreshIndexFacts({ immediate: true }),
        INDEX_EVENT_THROTTLE_MILLISECONDS - sinceLast);
      return;
    }
    lastIndexDispatchMilliseconds = performance.now();
    // A follower pinned at the end of its growing index may be able to reach
    // its target frame now that more of its clip is indexed.
    if (videoLayer !== app.primaryVideoLayer) app.synchronizeFollowerVideos();
    app.dispatchEvent(new CustomEvent('index-changed'));
  };

  // Complete and truncated are both ends of the pass: nothing more is coming,
  // so the progress line goes away and the panels get the final numbers now
  // rather than at the end of a throttle window.
  const settleIndex = () => {
    if (!engineIsCurrent(videoLayer, engine)) return;
    clearIndexingStatus(videoLayer.loadIdentifier);
    refreshIndexFacts({ immediate: true });
  };

  engine.addEventListener('indexextended', () => refreshIndexFacts({ immediate: false }));
  engine.addEventListener('indexcomplete', settleIndex);
  engine.addEventListener('indextruncated', settleIndex);

  engine.addEventListener('errormessage', (event) => {
    if (!engineIsCurrent(videoLayer, engine)) return;
    const detail = event.detail ?? {};
    if (!detail.message) return;
    const videoName = videoLayer.videoInformation?.name ?? videoLayer.name;
    // An index that stopped early is flagged fatal too, but it is not a dead
    // decoder: the frames already published stay exact and keep playing, and
    // rebuilding on the native tier would only re-scan the same container —
    // which that tier refuses a partial result from anyway. Say so and keep
    // the engine we have.
    if (detail.incomplete) {
      app.showToast(`${videoName}: ${detail.message}`, { kind: 'warning' });
      return;
    }
    if (detail.fatal) recoverFromFatalDecode(videoLayer);
    else app.showToast(`${videoName}: ${detail.message}`, { kind: 'warning' });
  });
}

function attachEngine(engine, { name, sizeBytes, source, hostElement, loadIdentifier, replaceVideoLayer = null }) {
  const videoLayer = new VideoLayer(engine, hostElement, { name });
  videoLayer.videoSource = source;
  videoLayer.loadIdentifier = loadIdentifier;
  videoLayer.videoInformation = videoInformationFromEngine(engine, { name, sizeBytes });
  if (engine.frameIndexState !== 'growing') clearIndexingStatus(loadIdentifier);

  // The new video stacks directly above the topmost video already open —
  // videos sit together beneath the annotation layers — and the first one
  // starts the stack at the bottom.
  const videoLayerIndexes = app.viewer.layers
    .map((layer, index) => (layer.type === 'video' ? index : -1))
    .filter((index) => index !== -1);
  const insertionIndex = videoLayerIndexes.length > 0
    ? videoLayerIndexes[videoLayerIndexes.length - 1] + 1 : 0;
  app.viewer.addLayer(videoLayer, insertionIndex);
  wireEngineEvents(videoLayer, engine);
  // A change to this video's visibility or opacity can change which playback mode
  // fits (showing a hidden second video should turn solo play into synced, and
  // vice versa), so re-evaluate on every change to the layer while it is playing.
  videoLayer.addEventListener('layer-changed', () => app.reconcilePlaybackMode());

  const becomesPrimary = app.primaryVideoLayer === null;
  if (becomesPrimary) {
    app.primaryVideoLayer = videoLayer;
    app.viewer.fitToContent();

    // Offer any autosaved annotations for this exact video (name + size).
    // Only the primary: the document is keyed to its timeline, and a follower
    // arriving later must not replace annotations already in progress.
    const key = autosaveKey(app.videoInformation);
    const autosaved = loadAutosave(key);
    if (autosaved && autosaved.document.layers.some((layer) => layer.items.length > 0)) {
      app.replaceDocument(autosaved.document);
      app.showToast(`Restored autosaved annotations (${autosaved.savedAt ?? 'unknown time'}). Import a file to replace them.`);
    }
  } else {
    // A new video stacked over one or more already open — a genuine "new
    // layer", not the transient follower a replace stages (that one is about
    // to become the sole primary, so its opacity is left alone). Dim it to 75%
    // so the videos beneath show through it, and the first time a second video
    // joins, drop the primary from a full 100% to 75% too so neither wholly
    // hides the other. A primary the user has already dialed to some other
    // opacity is left as they set it; a third-or-later video only dims itself.
    if (!replaceVideoLayer) {
      videoLayer.setOpacity(0.75);
      if (app.videoLayers.length === 2 && app.primaryVideoLayer.opacity === 1) {
        app.primaryVideoLayer.setOpacity(0.75);
      }
    }
    // A follower starts out on the frame matching the primary's playhead.
    app.synchronizeFollowerVideos();
  }
  updateDropHint();

  if (engine.frameIndexIsExact === false) {
    app.showToast(`${name}: this clip could not be indexed — frame numbers are approximate.`,
      { kind: 'warning' });
  }

  // A freshly loaded video starts out as the selected layer, so its tab
  // highlights and its facts appear in the detail panel. (Set after any
  // autosave restore, which resets the selected layer.)
  app.setActiveLayer(videoLayer.id);

  app.dispatchEvent(new CustomEvent('video-loaded'));
  app.dispatchEvent(new CustomEvent('frame-changed'));

  // "Replace" was chosen: the new video arrived as a follower stacked above the
  // one it replaces (becomesPrimary was false while that one was still open, so
  // the current annotations were deliberately left untouched — no autosave
  // restore ran). Closing the replaced video now promotes this one to primary
  // (see closeVideoLayer) and refits the view to it. Done last, and only after
  // loadVideoSource has certified the new engine, so a failed load never tears
  // down the existing video.
  if (replaceVideoLayer && replaceVideoLayer !== videoLayer
      && app.videoLayers.includes(replaceVideoLayer)) {
    app.closeVideoLayer(replaceVideoLayer.id);
    app.setActiveLayer(videoLayer.id);
    app.viewer.fitToContent();
  }
}

/** WebKit can pass load-time checks then kill the decoder mid-stream (see the
    engine README): rebuild that one video on the native tier at the same
    playhead, keeping the layer itself (id, tab, transform, link settings). */
async function recoverFromFatalDecode(videoLayer) {
  const frameBeforeFailure = videoLayer.engine.currentFrame;
  const videoName = videoLayer.videoInformation?.name ?? videoLayer.name;
  app.showToast(`${videoName}: the video decoder failed mid-stream; switching to the fallback player…`,
    { kind: 'warning' });
  try {
    videoLayer.engine.destroy();
    const engine = await createBestEngine(videoLayer.videoSource, {
      canvas: videoLayer.hostElement.querySelector('canvas'),
      video: videoLayer.hostElement.querySelector('video'),
      prefer: 'native',
      imageSmoothingEnabled: false,
    });
    if (!app.viewer.layers.includes(videoLayer)) {   // closed while rebuilding
      engine.destroy();
      return;
    }
    videoLayer.replaceEngine(engine);
    videoLayer.videoInformation = videoInformationFromEngine(engine, videoLayer.videoInformation);
    wireEngineEvents(videoLayer, engine);
    engine.seekToFrame(frameBeforeFailure);
    if (videoLayer === app.primaryVideoLayer) {
      app.dispatchEvent(new CustomEvent('video-loaded'));
      app.dispatchEvent(new CustomEvent('frame-changed'));
      app.dispatchEvent(new CustomEvent('index-changed'));
    }
  } catch (error) {
    reportVideoLoadFailure(error, { introduction: `${videoName}: the fallback player also failed.` });
  }
}

/* ---------- Animation loop ---------- */

let lastReportedFrame = -1;
let lastReportedSeekPending = false;
let lastReportedPaused = true;

function animationTick(now) {
  const engine = app.engine;
  for (const videoLayer of app.videoLayers) {
    videoLayer.engine.update(now);
    // The frame actually painted on screen can lag behind currentFrame: on the
    // WebCodecs tier currentFrame lands the instant a seek is requested, before
    // the target frame is necessarily decoded. Repaint off presentedFrame too,
    // so a seek that stalls mid-decode — the primary's or a follower's still
    // catching up — gets its canvas caught up once the stall clears, instead
    // of sitting on the previous frame until some unrelated action (a pan, a
    // hotkey) requests a render for its own reasons.
    if (videoLayer.engine.presentedFrame !== videoLayer.lastReportedPresentedFrame) {
      videoLayer.lastReportedPresentedFrame = videoLayer.engine.presentedFrame;
      // During synchronized playback the composite must reach the canvas only
      // once EVERY engine has its target frame; a single follower's seek landing
      // must not paint a half-updated frame. driveSyncedPlayback owns that
      // barrier-gated repaint, so suppress the per-engine one while it runs.
      if (!app.isSyncedPlaying) app.viewer.requestRender();
    }
    // Playback pinned at the last indexed frame is the one state nothing else
    // announces: the frame stops changing, so 'frame-changed' goes quiet, and
    // the engine is neither paused nor at the end of the clip. (Watched per
    // engine: the transport chip reads the primary's flag off this event.)
    if (!!videoLayer.engine.waitingForIndex !== !!videoLayer.lastReportedWaitingForIndex) {
      videoLayer.lastReportedWaitingForIndex = !!videoLayer.engine.waitingForIndex;
      app.dispatchEvent(new CustomEvent('index-changed'));
    }
  }
  if (app.isSyncedPlaying) {
    // The app-driven master clock owns seeking every engine, the barrier, the
    // gated repaint, and the frame-changed/playback-changed it dispatches — so
    // the single-engine bookkeeping below is skipped while it runs.
    app.driveSyncedPlayback(now);
  } else if (engine) {
    if (engine.currentFrame !== lastReportedFrame) {
      lastReportedFrame = engine.currentFrame;
      app.dispatchEvent(new CustomEvent('frame-changed'));
      app.viewer.requestRender();
    }
    if (!engine.paused) app.invalidateSeekTarget();
    if (app.isSeekPending !== lastReportedSeekPending) {
      lastReportedSeekPending = app.isSeekPending;
      app.updateSeekPendingDisplay();
    }
    // Playback that ends on its own — the playhead reaching the end of the
    // clip — pauses the engine without anyone calling togglePlayback, so the
    // pause would otherwise go unannounced (the play button would stay in its
    // playing state, and follower videos would never take their catch-up
    // seek). Announcing a pause twice is harmless; missing one is not.
    if (engine.paused !== lastReportedPaused) {
      lastReportedPaused = engine.paused;
      app.dispatchEvent(new CustomEvent('playback-changed'));
    }
    if (!engine.paused) app.viewer.requestRender();
  }
  app.viewer.renderIfNeeded({
    // While synced playback runs, the primary is seeked to the in-flight target
    // (ahead of the painted composite under load), so align overlays/annotations
    // to the frame actually on screen — see app.syncedPaintedFrame.
    frame: app.isSyncedPlaying ? app.syncedPaintedFrame : app.currentFrame,
    frameFloat: app.isSyncedPlaying ? app.syncedPaintedFrame : (engine?.currentFrameFloat ?? 0),
    selection: app.selection,
    hover: app.hover,
    document: app.annotationDocument,
    isSeekPendingDisplay: app.isSeekPendingDisplay,
    primaryVideoLayer: app.primaryVideoLayer,
  });
  requestAnimationFrame(animationTick);
}
requestAnimationFrame(animationTick);

/* ---------- Follower videos trail the primary's playhead ----------
   On each discrete frame change while nothing is playing (a step, a scrub tick,
   a table-row jump) and on every pause, each follower is seeked to its matching
   frame. Synchronized playback (more than one VISIBLE WebCodecs video) instead
   drives every follower itself, tick by tick, from driveSyncedPlayback — so
   these catch-up seeks stay out of its way while it runs. The single-video fast
   path plays just the one visible engine; the resync is gated on !isPlaying (not
   on the primary being paused) so that playing a lone visible follower does not
   trip this and yank it back to the hidden primary's frame. */

app.addEventListener('frame-changed', () => {
  if (app.engine && !app.isPlaying) app.synchronizeFollowerVideos();
});
app.addEventListener('playback-changed', () => {
  if (app.engine && !app.isPlaying) app.synchronizeFollowerVideos();
});

/* ---------- Undo/redo buttons ---------- */

const undoButton = document.getElementById('undo-button');
const redoButton = document.getElementById('redo-button');
app.undoHistory.addEventListener('history-changed', () => {
  undoButton.disabled = !app.undoHistory.canUndo;
  redoButton.disabled = !app.undoHistory.canRedo;
  undoButton.title = app.undoHistory.nextUndoLabel
    ? `Undo ${app.undoHistory.nextUndoLabel} (Cmd/Ctrl+Z)` : 'Undo (Cmd/Ctrl+Z)';
  app.markDocumentChanged();
});
undoButton.addEventListener('click', () => app.undoHistory.undo());
redoButton.addEventListener('click', () => app.undoHistory.redo());

/* ---------- Toolbar ---------- */

const toolButtons = [...document.querySelectorAll('#tool-rail button[data-tool]')];
// Number keys are assigned by position in the tool rail — '1' for the first
// button (pan, at the top), increasing going down — rather than written
// statically per tool, so the assignment always follows the rail's actual
// order. '0' is reserved for the scroll-to-details button further down the
// rail (see reflectScrollToggle); a tool rail with more than this many tools
// simply leaves the rest without a number key.
const MAXIMUM_NUMBERED_TOOLS = 9;
const toolHotkeys = new Map();
toolButtons.forEach((button, index) => {
  if (index >= MAXIMUM_NUMBERED_TOOLS) return;
  const hotkey = String(index + 1);
  toolHotkeys.set(button.dataset.tool, hotkey);
  button.dataset.hotkey = hotkey;
  button.title = `${button.title} (${hotkey})`;
});
// Preserved so an unavailable button's hotkey tooltip can be restored once a
// matching layer exists again.
for (const button of toolButtons) button.dataset.baseTitle = button.title;

function toolIsAvailable(toolId) {
  const requiredType = TOOL_REQUIRED_LAYER_TYPE[toolId];
  return !requiredType || app.annotationLayers.some((layer) => layer.type === requiredType);
}

// Pressing (or holding) the already-active tool's button or hotkey used to
// fall back to pan; now that every tool pans on its own (an empty-space drag
// always pans, regardless of active tool), there is nothing useful to fall
// back to. It just blinks the button's background instead, acknowledging the
// press without changing anything — starting the instant the mouse/key goes
// down and lasting exactly as long as it's held, with a floor so even the
// briefest tap still reads as a visible blink.
const TOOL_BLINK_MINIMUM_DURATION_MILLISECONDS = 50;

// Each button tracks its own blink start time (or none), so a mouse blink and
// a keyboard blink on two different buttons never interfere with each other.
function beginToolBlink(button) {
  if (button.toolBlinkStartTime !== undefined) return;   // already blinking
  button.toolBlinkStartTime = Date.now();
  button.classList.add('tool-blink');
}

function endToolBlink(button) {
  const startTime = button.toolBlinkStartTime;
  if (startTime === undefined) return;
  button.toolBlinkStartTime = undefined;
  const remaining = TOOL_BLINK_MINIMUM_DURATION_MILLISECONDS - (Date.now() - startTime);
  if (remaining <= 0) button.classList.remove('tool-blink');
  else setTimeout(() => button.classList.remove('tool-blink'), remaining);
}

for (const button of toolButtons) {
  const toolId = button.dataset.tool;
  const requiredType = TOOL_REQUIRED_LAYER_TYPE[toolId];

  // The blink itself starts on mousedown and ends on mouseup or on the
  // cursor leaving the button — not on 'click', which only fires once the
  // press is already fully over.
  button.addEventListener('mousedown', () => {
    if (toolIsAvailable(toolId) && app.activeTool?.id === toolId) beginToolBlink(button);
  });
  button.addEventListener('mouseup', () => endToolBlink(button));
  button.addEventListener('mouseleave', () => endToolBlink(button));

  button.addEventListener('click', () => {
    if (!toolIsAvailable(toolId)) {
      app.showToast(
        `Requires a ${layerTypeDisplayName(requiredType)} layer: Right-click to create one`,
        { kind: 'warning' });
      return;
    }
    if (app.activeTool?.id === toolId) return;   // already blinking, nothing else to do
    // Switch to a matching layer first, if the active one isn't already of the
    // required type, so the tool draws into the layer it just switched to.
    if (requiredType) {
      const targetLayer = app.findAnnotationLayerForType(requiredType);
      if (targetLayer && app.activeLayer?.id !== targetLayer.id) app.setActiveLayer(targetLayer.id);
    }
    app.setActiveTool(toolId);
  });

  if (requiredType) {
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (toolIsAvailable(toolId)) return;
      const layer = app.addAnnotationLayer(requiredType);
      app.setActiveLayer(layer.id);
      app.setActiveTool(toolId);
    });
  }
}

function reflectActiveTool() {
  for (const button of toolButtons) {
    button.classList.toggle('active-tool', button.dataset.tool === app.activeTool?.id);
  }
}
app.addEventListener('tool-changed', reflectActiveTool);
// The initial tool is set during bootstrap, before this listener exists, so sync
// the button highlight once now (otherwise 'pan' stays unhighlighted at load).
reflectActiveTool();

function reflectToolAvailability() {
  for (const button of toolButtons) {
    const toolId = button.dataset.tool;
    const requiredType = TOOL_REQUIRED_LAYER_TYPE[toolId];
    if (!requiredType) continue;
    const available = toolIsAvailable(toolId);
    button.classList.toggle('rail-button-unavailable', !available);
    button.title = available
      ? button.dataset.baseTitle
      : `Requires a ${layerTypeDisplayName(requiredType)} layer: Right-click to create one`;
  }
}
app.addEventListener('layers-changed', reflectToolAvailability);
reflectToolAvailability();

/* The paintbrush (segmentation) button has no backing tool yet — pixel-wise
   painting is not implemented, regardless of whether a Segmentation layer
   exists, so it always shows the same message rather than participating in
   the generic tool-availability machinery above. */
const paintToolButton = document.getElementById('paint-tool-button');
paintToolButton.classList.add('rail-button-unavailable');
function announcePaintNotImplemented() {
  app.showToast("Pixel painting isn't implemented yet.", { kind: 'warning' });
}
paintToolButton.addEventListener('click', announcePaintNotImplemented);
paintToolButton.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  announcePaintNotImplemented();
});

document.getElementById('fit-view-button').addEventListener('click', () => app.viewer.fitToContent());

/* ---------- Annotation-mode toggle (frame-anchored vs frame-agnostic) ---------- */

const frameAgnosticToggle = document.getElementById('frame-agnostic-toggle');
frameAgnosticToggle.addEventListener('click', () => {
  app.setAnnotationMode(app.annotationMode === 'agnostic' ? 'anchored' : 'agnostic');
});
function reflectAnnotationMode() {
  const agnostic = app.annotationMode === 'agnostic';
  frameAgnosticToggle.classList.toggle('mode-active', agnostic);
  frameAgnosticToggle.title = agnostic
    ? 'Frame-agnostic mode on: new annotations apply across all frames (a)'
    : 'Frame-agnostic mode off: new annotations anchor to the current frame (a)';
}
app.addEventListener('annotation-mode-changed', reflectAnnotationMode);
reflectAnnotationMode();

/* ---------- Scroll-to-details toggle (bottom of the tool rail) ---------- */

const scrollToggleButton = document.getElementById('scroll-toggle-button');
// Treat anything within a few pixels of the top as "fully scrolled up".
const SCROLL_TOP_THRESHOLD_PIXELS = 4;

function isScrolledToTop() {
  return window.scrollY <= SCROLL_TOP_THRESHOLD_PIXELS;
}

function reflectScrollToggle() {
  const atTop = isScrolledToTop();
  // The arrow SVG points down by default; rotate it 180° to point up.
  scrollToggleButton.classList.toggle('pointing-up', !atTop);
  scrollToggleButton.title = atTop ? 'Scroll down to the details (0)' : 'Scroll back to the top (0)';
}

scrollToggleButton.addEventListener('click', () => {
  if (isScrolledToTop()) {
    // Reveal the details section, leaving it just below the sticky toolbar.
    const details = document.getElementById('details-section');
    const toolbarHeight = document.getElementById('toolbar').offsetHeight;
    const target = details.getBoundingClientRect().top + window.scrollY - toolbarHeight;
    window.scrollTo({ top: target, behavior: 'smooth' });
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});
window.addEventListener('scroll', reflectScrollToggle, { passive: true });
reflectScrollToggle();

const videoFileInput = document.getElementById('video-file-input');
document.getElementById('open-video-button').addEventListener('click', () => videoFileInput.click());
videoFileInput.addEventListener('change', () => {
  const file = videoFileInput.files?.[0];
  if (file) loadVideoIntoWorkspace(file, { name: file.name, sizeBytes: file.size });
  videoFileInput.value = '';
});

const annotationsFileInput = document.getElementById('annotations-file-input');
document.getElementById('import-annotations-button').addEventListener('click', () => annotationsFileInput.click());
annotationsFileInput.addEventListener('change', async () => {
  const file = annotationsFileInput.files?.[0];
  annotationsFileInput.value = '';
  if (file) await importAnnotationsFile(file);
});

async function importAnnotationsFile(file) {
  try {
    const parsed = documentFromJson(JSON.parse(await file.text()));
    const hasExistingItems = app.annotationDocument.layers.some((layer) => layer.items.length > 0);
    if (hasExistingItems
        && !window.confirm('Importing replaces the current annotations. Continue?')) {
      return;
    }
    app.replaceDocument(parsed);
    app.showToast(`Imported annotations from ${file.name}.`);
  } catch (error) {
    app.showToast(`Could not import ${file.name}: ${error.message ?? error}`, { kind: 'error' });
  }
}

document.getElementById('export-annotations-button').addEventListener('click', () => {
  const json = documentToJson(app.annotationDocument, app.videoInformation);
  const baseName = (app.videoInformation?.name ?? 'annotations').replace(/\.[^.]+$/, '');
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `${baseName}.annotations.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
});

/* ---------- Drag and drop ---------- */

stageContainer.addEventListener('dragover', (event) => {
  event.preventDefault();
  stageContainer.classList.add('drag-over');
});
stageContainer.addEventListener('dragleave', () => stageContainer.classList.remove('drag-over'));
stageContainer.addEventListener('drop', async (event) => {
  event.preventDefault();
  stageContainer.classList.remove('drag-over');
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  if (file.name.toLowerCase().endsWith('.json')) await importAnnotationsFile(file);
  else loadVideoIntoWorkspace(file, { name: file.name, sizeBytes: file.size });
});

/* ---------- Buttons: no lingering focus ring after a mouse click ----------
   A button that keeps DOM focus after a click shows the browser's focus ring
   again the moment any key is pressed (pressing a hotkey flips the page into
   "keyboard modality", which re-triggers :focus-visible even though the key
   had nothing to do with that button). Stopping the mousedown default keeps
   buttons out of focus on click entirely, while Tab-driven keyboard focus
   (and its outline) is untouched, since this only fires on mousedown. */
document.addEventListener('mousedown', (event) => {
  if (event.target.closest('button')) event.preventDefault();
});

/* ---------- Global keyboard ---------- */

window.addEventListener('keydown', (event) => {
  if (app.isTypingTarget(event)) return;

  const commandOrControl = event.metaKey || event.ctrlKey;
  if (commandOrControl && (event.key === 'z' || event.key === 'Z')) {
    event.preventDefault();
    if (event.shiftKey) app.undoHistory.redo();
    else app.undoHistory.undo();
    return;
  }
  if (commandOrControl) return;   // leave other browser shortcuts alone

  if (event.code === 'Space') {
    event.preventDefault();
    app.togglePlayback();
    return;
  }
  if (event.key === 'ArrowLeft' || event.key === ',') { event.preventDefault(); app.stepFrame(-1); return; }
  if (event.key === 'ArrowRight' || event.key === '.') { event.preventDefault(); app.stepFrame(1); return; }
  if (event.key === 'f') { app.viewer.fitToContent(); return; }
  if (event.key === 'a' || event.key === 'A') {
    app.setAnnotationMode(app.annotationMode === 'agnostic' ? 'anchored' : 'agnostic');
    return;
  }
  if (event.key === 'v') {
    const layer = app.selectedLayer;
    if (layer) layer.setVisible(!layer.visible);
    return;
  }

  if (event.key === '0') { scrollToggleButton.click(); return; }

  for (const [toolId, hotkey] of toolHotkeys) {
    if (hotkey === event.key) {
      if (app.activeTool?.id === toolId) {
        // Held down, the blink lasts exactly as long as the key does — ended
        // by the matching keyup below, not a fixed timer.
        const button = toolButtons.find((candidate) => candidate.dataset.tool === toolId);
        if (button) beginToolBlink(button);
      } else {
        app.setActiveTool(toolId);
      }
      return;
    }
  }

  if (app.activeTool?.onKeyDown?.(app, event)) { event.preventDefault(); return; }

  // Escape clears the selection when no tool claimed it (a tool claims it to
  // commit an in-progress line/polyline as an open shape, or to cancel outright
  // when there are too few vertices to be one).
  if (event.key === 'Escape' && app.selection) {
    app.setSelection(null);
    return;
  }

  // Delete/Backspace removes the selection regardless of the active tool (the
  // active tool got first refusal above, e.g. Backspace while drawing a shape).
  if ((event.key === 'Delete' || event.key === 'Backspace') && app.deleteSelection()) {
    event.preventDefault();
    return;
  }

  if (app.runKeyHandlers(event)) event.preventDefault();
});

// Ends a tool hotkey's blink exactly when the key is released, matching a
// held mousedown's mouseup/mouseleave. Harmless if that tool's button was
// never blinking (typing in an input, or the key belongs to no tool).
window.addEventListener('keyup', (event) => {
  const toolId = [...toolHotkeys].find(([, hotkey]) => hotkey === event.key)?.[0];
  if (!toolId) return;
  const button = toolButtons.find((candidate) => candidate.dataset.tool === toolId);
  if (button) endToolBlink(button);
});

/* ---------- Optional ?video= URL parameter ---------- */

const videoUrlParameter = new URLSearchParams(window.location.search).get('video');
if (videoUrlParameter) {
  const nameFromUrl = videoUrlParameter.split('/').pop() || videoUrlParameter;
  loadVideoSource(videoUrlParameter, { name: nameFromUrl, sizeBytes: null });
}
