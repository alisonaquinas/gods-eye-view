import { createPlacesView } from '../ui/placesView.js';

const view = createPlacesView(document.getElementById('places-view'));
if (import.meta.hot) import.meta.hot.dispose(() => view.destroy());
