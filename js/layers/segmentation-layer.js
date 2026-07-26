// The segmentation layer is a stub: pixel-wise segmentation is not built yet.
// It exists so the layer type is creatable and shows up in the document and
// tab bar like any other annotation layer, but nothing produces items for it
// yet, so — like the frames layer's non-spatial stub — it never draws on the
// canvas and is never hit-tested or edited by the drawing tools.

import { Layer } from './layer.js';

export class SegmentationLayer extends Layer {
  /** @param {object} documentLayer  The `type: 'segmentation'` layer in the document. */
  constructor(documentLayer) {
    super({ id: documentLayer.id, type: 'segmentation', name: documentLayer.name });
    this.visible = documentLayer.visible;
    this.opacity = documentLayer.opacity;
    this.transform = { ...documentLayer.transform };
    this.documentLayer = documentLayer;
    this.items = documentLayer.items;
  }

  draw(context, renderState) {}                 // eslint-disable-line no-unused-vars
  contentBounds() { return null; }
  hitTest(localPoint, renderState) { return null; }  // eslint-disable-line no-unused-vars
  get isEditable() { return false; }

  getItem(itemId) {
    return this.items.find((item) => item.id === itemId) ?? null;
  }
}
