// Base class for everything that lives on the shared canvas. See
// ARCHITECTURE.md ("Modules and contracts") for the full contract, including
// the editing contract annotation layers add on top of this.

let nextLayerNumber = 1;

export class Layer extends EventTarget {
  /** @param {{id?: string, type: string, name?: string}} options */
  constructor({ id, type, name }) {
    super();
    this.id = id ?? `layer-${nextLayerNumber++}`;
    this.type = type;
    this.name = name ?? type;
    this.visible = true;
    this.opacity = 1;
    // Maps layer-local coordinates to world: world = local × scale + offset.
    this.transform = { scale: 1, offsetX: 0, offsetY: 0 };
  }

  setName(name) { this.name = name; this.#changed(); }
  setVisible(visible) { this.visible = visible; this.#changed(); }
  setOpacity(opacity) { this.opacity = Math.min(1, Math.max(0, opacity)); this.#changed(); }
  setTransform(transform) { this.transform = { ...this.transform, ...transform }; this.#changed(); }

  #changed() { this.dispatchEvent(new CustomEvent('layer-changed')); }

  /* Subclasses override the members below. */

  /** Draw in layer-local coordinates; the canvas transform is already set. */
  draw(context, renderState) {}  // eslint-disable-line no-unused-vars

  /** Bounding box of the layer's content in local coordinates, or null. */
  contentBounds() { return null; }

  /** Annotation layers return hit results; media layers are not hit-testable. */
  hitTest(localPoint, renderState) { return null; }  // eslint-disable-line no-unused-vars

  /** Whether the select tool can interact with this layer's items. */
  get isEditable() { return false; }
}
