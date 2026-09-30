import { createEffAtlasLayer } from '../../layers/effAtlas/index.js';
import { overlayHost } from './overlayHost.js';
import * as picking from '../../data/pickRegistry.js';
import { governorRequestRender } from '../../renderGovernor.js';

/** Keep technology toggles separate while one Atlas selection owns the card. */
export function createApplicationEffAtlasLayers({ categories, source }) {
  let layers;
  layers = categories.map((category) =>
    createEffAtlasLayer({
      category,
      source,
      overlayHost,
      picking,
      requestRender: governorRequestRender,
      onSelect(selectedLayerId) {
        for (const layer of layers) {
          if (layer.id !== selectedLayerId) layer.clearSelection();
        }
      },
    }),
  );
  return layers;
}
