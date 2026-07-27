// The line tool draws a single straight segment: exactly two vertices, always
// open, finished automatically the instant the second point is down — never a
// multi-segment polyline (see the polyline tool for that). It reuses the
// shared drawing-tool factory from the polyline tool; the only differences are
// the vertex-count cap and that a line cannot be closed by clicking its first
// vertex. See ARCHITECTURE.md for the tool contract.

import { createDrawingTool } from './polyline-tool.js';

export const lineTool = createDrawingTool({
  id: 'line',
  name: 'Draw lines',
  kind: 'line',
  commandLabel: 'Add line',
  minimumVertexCount: 2,
  maximumVertexCount: 2,
  canClickToClose: false,
});
