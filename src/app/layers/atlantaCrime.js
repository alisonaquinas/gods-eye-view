import { createAtlantaCrimeLayer } from '../../layers/atlantaCrime/index.js';
import { overlayHost } from './overlayHost.js';
import * as picking from '../../data/pickRegistry.js';
import { governorRequestRender } from '../../renderGovernor.js';

export function createApplicationAtlantaCrime({ source, incidentMap }) {
  return createAtlantaCrimeLayer({
    source,
    incidentMap,
    overlayHost,
    picking,
    requestRender: governorRequestRender,
  });
}
