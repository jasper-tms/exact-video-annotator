// Floating windows: small panels that float over the canvas, for plugins.
//
// A floating window lives in world coordinates, like an annotation: its top-left
// corner is a world point and its width a world length, so panning moves it
// with the footage and zooming scales it, keeping it where it was placed (say,
// beside the table it is about). The whole window, title bar included, is
// drawn at a fixed design size and scaled as one, so its content looks the same
// at any zoom. Like the footage, it is clipped to the canvas.
//
// The user moves it by dragging its title bar and resizes it by dragging the
// grip in its bottom-right corner; resizing keeps the window's aspect ratio and
// its top-left corner fixed. Wheel and pinch gestures over the window zoom the canvas as they
// would anywhere else.
//
// createFloatingWindow(app, options) → handle
//   options:
//     title          text in the title bar
//     content        an HTMLElement shown below the title bar, laid out at
//                    `designWidth` × `designWidth / aspectRatio` CSS pixels
//     aspectRatio    width ÷ height of the content area (default 1)
//     designWidth    the content's layout width in CSS pixels (default 240)
//     worldRect      { x, y, width }: where to put it, in world units; omitted,
//                    it starts at the right of the current view
//     onWorldRectChanged(worldRect)  called after the user moves or resizes it,
//                    e.g. to save the placement in the layer's plugin options
//   handle: { element, worldRect, setVisible(visible), setTitle(text), destroy() }

const TITLE_BAR_HEIGHT = 22;
const MINIMUM_STAGE_WIDTH = 60;

export function createFloatingWindow(app, {
  title = '', content, aspectRatio = 1, designWidth = 240,
  worldRect = null, onWorldRectChanged = null,
} = {}) {
  const viewer = app.viewer;
  const container = viewer.stageCanvas.parentElement;
  const designHeight = TITLE_BAR_HEIGHT + designWidth / aspectRatio;

  const element = document.createElement('div');
  element.className = 'floating-window';
  element.style.width = `${designWidth}px`;
  element.style.height = `${designHeight}px`;
  const titleBar = document.createElement('div');
  titleBar.className = 'floating-window-title';
  titleBar.style.height = `${TITLE_BAR_HEIGHT}px`;
  titleBar.textContent = title;
  const body = document.createElement('div');
  body.className = 'floating-window-body';
  if (content) body.appendChild(content);
  element.append(titleBar, body);
  const resizeGrip = document.createElement('div');
  resizeGrip.className = 'floating-window-resize-grip';
  element.appendChild(resizeGrip);
  container.appendChild(element);

  // World units per stage pixel differ horizontally and vertically when world
  // pixels are not square on screen, so convert through the viewer.
  const horizontalStageScale = () => viewer.viewTransform.scale * viewer.pixelAspectRatio;

  if (!worldRect) {
    const topLeft = viewer.worldFromStagePoint({ x: container.clientWidth * 0.72, y: 12 });
    worldRect = { x: topLeft.x, y: topLeft.y, width: (container.clientWidth * 0.25) / horizontalStageScale() };
  }
  const handleObject = { element, worldRect: { ...worldRect } };

  function stageRect() {
    const topLeft = viewer.stageFromWorldPoint(handleObject.worldRect);
    const width = handleObject.worldRect.width * horizontalStageScale();
    return { x: topLeft.x, y: topLeft.y, width, height: width * designHeight / designWidth };
  }

  function place() {
    const rectangle = stageRect();
    element.style.transform =
      `translate(${rectangle.x}px, ${rectangle.y}px) scale(${rectangle.width / designWidth})`;
  }

  function setWorldRectFromStage(x, y, width) {
    const topLeft = viewer.worldFromStagePoint({ x, y });
    handleObject.worldRect = { x: topLeft.x, y: topLeft.y, width: width / horizontalStageScale() };
    place();
  }

  // One drag at a time: moving (title bar) or resizing (the grip).
  let drag = null;

  function stagePoint(event) {
    const bounds = container.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  element.addEventListener('pointerdown', (event) => {
    const resizing = event.target === resizeGrip;
    if (!resizing && event.target !== titleBar) return;
    event.preventDefault();
    event.stopPropagation();
    element.setPointerCapture(event.pointerId);
    const start = stagePoint(event);
    const rectangle = stageRect();
    drag = {
      resizing, start, rectangle, pointerId: event.pointerId,
      // Where in the window the grip was grabbed, as fractions of its width
      // and height, so that spot (not the corner) follows the pointer.
      grabbed: { x: (start.x - rectangle.x) / rectangle.width, y: (start.y - rectangle.y) / rectangle.height },
    };
  });

  element.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const point = stagePoint(event);
    const { rectangle } = drag;
    if (!drag.resizing) {
      setWorldRectFromStage(rectangle.x + point.x - drag.start.x,
        rectangle.y + point.y - drag.start.y, rectangle.width);
      return;
    }
    // The top-left corner stays put. The grabbed spot sits at (a, b) × width
    // from it, with a and b fixed, so it can only move along that direction:
    // choose the width putting it nearest the pointer (the pointer's offset
    // projected onto that direction). At the start, that is the old width.
    const a = drag.grabbed.x;
    const b = drag.grabbed.y * designHeight / designWidth;
    const reachX = point.x - rectangle.x;
    const reachY = point.y - rectangle.y;
    const width = Math.max(MINIMUM_STAGE_WIDTH, (a * reachX + b * reachY) / (a * a + b * b));
    setWorldRectFromStage(rectangle.x, rectangle.y, width);
  });

  function endDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    onWorldRectChanged?.({ ...handleObject.worldRect });
  }
  element.addEventListener('pointerup', endDrag);
  element.addEventListener('pointercancel', endDrag);

  // Zoom the canvas from over the window too, as if the window weren't there.
  element.addEventListener('wheel', (event) => {
    event.preventDefault();
    viewer.stageCanvas.dispatchEvent(new WheelEvent('wheel', event));
  }, { passive: false });

  viewer.addEventListener('view-changed', place);
  const resizeObserver = new ResizeObserver(place);
  resizeObserver.observe(container);
  place();

  handleObject.setVisible = (visible) => { element.hidden = !visible; };
  handleObject.setTitle = (text) => { titleBar.textContent = text; };
  handleObject.destroy = () => {
    viewer.removeEventListener('view-changed', place);
    resizeObserver.disconnect();
    element.remove();
  };
  return handleObject;
}
