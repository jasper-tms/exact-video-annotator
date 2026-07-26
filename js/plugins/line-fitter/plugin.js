// The line-fitter plugin's descriptor — what the ＋ menu lists, what builds its
// layer, and what draws its settings. See js/plugins/registry.js for the shape
// every plugin descriptor has.

import { LineFitterLayer } from './line-fitter-layer.js';
import { buildLineFitterSettings } from './line-fitter-settings.js';

export const lineFitterPlugin = {
  id: 'line-fitter',
  name: 'Line fitter',
  description: 'Lines snap onto the edge — or the middle of the stripe — under them.',
  layerType: 'coordinates',
  // Drawing a line is what this layer is for, so selecting it selects that tool.
  preferredToolId: 'line',

  createViewLayer(documentLayer, app) {
    return new LineFitterLayer(documentLayer, this, app);
  },

  buildSettings(app, layer) {
    return buildLineFitterSettings(app, layer);
  },
};
