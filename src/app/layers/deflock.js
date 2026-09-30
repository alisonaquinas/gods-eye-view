import { createDeflockLayer } from '../../layers/deflock/index.js';
import { overlayHost } from './overlayHost.js';
import * as picking from '../../data/pickRegistry.js';
import { governorRequestRender } from '../../renderGovernor.js';

export const DEFLOCK_CATEGORY = Object.freeze({
  id: 'deflock-cameras',
  label: 'DeFlock ALPR Cameras',
  icon: '▣',
  color: '#f6b653',
});

export function createApplicationDeflock({ source }) {
  return createDeflockLayer({
    category: DEFLOCK_CATEGORY,
    source,
    overlayHost,
    picking,
    requestRender: governorRequestRender,
  });
}
