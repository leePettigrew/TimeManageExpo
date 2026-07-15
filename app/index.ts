import { registerRootComponent } from 'expo';

// TaskManager tasks must be defined at module load, before the background
// runtime can invoke them — keep these imports first.
import './src/lib/breadcrumbs';
import './src/lib/push';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
