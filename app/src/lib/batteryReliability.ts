// Android background-location reliability. The foreground service already runs
// tracking when the app isn't focused, but the OS can still throttle or kill it
// under battery optimization / Doze. Requesting an exemption is the single most
// effective way to keep updates flowing while the phone is locked in a pocket.
import { Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import { kvGet, kvSet } from './outbox';

const PKG = 'ie.timetable.app'; // must match android.package in app.json

/**
 * Ask Android to exempt the app from battery optimization (system dialog).
 * No-op on iOS. Safe to call more than once.
 */
export async function requestIgnoreBatteryOptimizations(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    // ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS — shows the "Allow" dialog
    await IntentLauncher.startActivityAsync(
      'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS' as unknown as IntentLauncher.ActivityAction,
      { data: `package:${PKG}` },
    );
  } catch {
    // some OEMs block the direct dialog — fall back to the app's settings page
    try {
      await IntentLauncher.startActivityAsync(
        IntentLauncher.ActivityAction.APPLICATION_DETAILS_SETTINGS,
        { data: `package:${PKG}` },
      );
    } catch {
      /* nothing more we can do from here */
    }
  }
}

/** Prompt the exemption once, the first time a worker starts a shift. */
export async function requestBatteryExemptionOnce(): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (await kvGet('battery_exemption_asked')) return;
  await kvSet('battery_exemption_asked', '1');
  await requestIgnoreBatteryOptimizations();
}

/** Open the OEM-specific battery settings page for manual setup. */
export async function openAppSettings(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await IntentLauncher.startActivityAsync(
      IntentLauncher.ActivityAction.APPLICATION_DETAILS_SETTINGS,
      { data: `package:${PKG}` },
    );
  } catch {
    /* ignore */
  }
}
