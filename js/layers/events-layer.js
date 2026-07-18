// The events layer holds temporal-event items: point events (a single frame)
// and range events (a span of frames). Events have no spatial presence, so
// unlike the points and shapes layers this one never draws on the canvas and
// is never hit-tested or edited by the select tool. It exists so that events
// live in the same layer list as the other annotations (visibility, z-order,
// serialization) and so the annotations table can list and delete them.
//
// Like every annotation view layer, this is a view OVER the document: its
// `items` array is the very same array object held by the document layer, so
// mutating it mutates the document. See ARCHITECTURE.md.

import { Layer } from './layer.js';

export class EventsLayer extends Layer {
  /**
   * @param {object} documentLayer  The events layer from the annotation
   *   document ({ id, type: 'events', name, visible, opacity, transform,
   *   items }). Its `items` array is adopted by reference.
   */
  constructor(documentLayer) {
    super({ id: documentLayer.id, type: 'events', name: documentLayer.name });
    this.visible = documentLayer.visible;
    this.opacity = documentLayer.opacity;
    this.transform = { ...documentLayer.transform };
    this.documentLayer = documentLayer;
    this.items = documentLayer.items;
  }

  /* Events have no spatial presence. */

  draw(context, renderState) {}                 // eslint-disable-line no-unused-vars
  contentBounds() { return null; }
  hitTest(localPoint, renderState) { return null; }  // eslint-disable-line no-unused-vars
  get isEditable() { return false; }

  /** The live event item with this id, or null. Read-only use by the table. */
  getItem(itemId) {
    return this.items.find((item) => item.id === itemId) ?? null;
  }

  /**
   * A command that deletes the event with this id, restoring it at its original
   * index on revert. Returns null when no such event exists. The annotations
   * table passes the result to `app.undoHistory.execute`.
   */
  commandDeleteItem(itemId) {
    const originalIndex = this.items.findIndex((item) => item.id === itemId);
    if (originalIndex === -1) return null;
    const item = this.items[originalIndex];
    return {
      label: 'Delete event',
      apply: () => {
        const currentIndex = this.items.indexOf(item);
        if (currentIndex !== -1) this.items.splice(currentIndex, 1);
      },
      revert: () => {
        this.items.splice(originalIndex, 0, item);
      },
    };
  }
}
