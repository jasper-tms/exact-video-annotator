// The line tool draws open polylines. It reuses the shared drawing-tool factory
// from the polygon tool; the only differences are the minimum vertex count and
// that a line cannot be finished by clicking its first vertex (Enter or a
// double-click finishes it). See ARCHITECTURE.md for the tool contract.

import { createDrawingTool } from './polygon-tool.js';

export const lineTool = createDrawingTool({
  id: 'line',
  name: 'Draw lines',
  hotkey: 'l',
  kind: 'line',
  commandLabel: 'Add line',
  minimumVertexCount: 2,
  canClickToClose: false,
});
