import { registerRootComponent } from 'expo';

// The breadcrumb TaskManager task must be defined at module load, before the
// background runtime can invoke it — keep this import first.
import './src/lib/breadcrumbs';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
