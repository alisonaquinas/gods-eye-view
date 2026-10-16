import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createEcccAirQualitySource } from '../layers/airQuality/source.js';
import { createWfigsPerimeterSource } from '../layers/perimeters/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import { createEffAtlasSource } from '../layers/effAtlas/source.js';
import { createDeflockSource } from '../layers/deflock/source.js';
import { createAdsbGnssSource } from '../layers/gnss/source.js';

/** Construct the existing reference feeds independently of application setup. */
export function createReferenceSources() {
  return {
    earthquakes: createUsgsEarthquakeSource(),
    'air-quality': createEcccAirQualitySource(),
    'fire-perimeters': createWfigsPerimeterSource(),
    cables: createBundledCableSource(),
    'eff-atlas': createEffAtlasSource(),
    deflock: createDeflockSource(),
    'gnss-integrity': createAdsbGnssSource(),
  };
}
