import { createMetroPlacesLayer } from '../../layers/metroPlaces/index.js';
import { overlayHost } from './overlayHost.js';
import * as picking from '../../data/pickRegistry.js';
import { governorRequestRender } from '../../renderGovernor.js';

export function createApplicationMetroPlaces({ source }) {
  return createMetroPlacesLayer({
    source,
    overlayHost,
    picking,
    requestRender: governorRequestRender,
  });
}
