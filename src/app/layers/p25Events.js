import { createP25EventsLayer } from '../../layers/p25Events/index.js';
import { overlayHost } from './overlayHost.js';
import * as picking from '../../data/pickRegistry.js';
import { governorRequestRender } from '../../renderGovernor.js';

export function createApplicationP25Events({ source }) {
  return createP25EventsLayer({
    source,
    overlayHost,
    picking,
    requestRender: governorRequestRender,
  });
}
