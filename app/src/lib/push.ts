// Push notifications: registers this device's Expo push token with the server
// and handles incoming "locate" pushes by capturing a fresh fix immediately —
// so a manager's "locate now" resolves in seconds instead of waiting for the
// 30s sync poll. Push is an accelerator; everything still works without it.
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { supabase } from './supabase';
import { uuidv7 } from './ids';
import { getBackgroundFix } from './location';
import { insertPings, kvGet, kvSet, nextPingSeq } from './outbox';
import { flush } from './sync';

const EAS_PROJECT_ID = '48a1e50a-ab94-4019-a1ad-818a56dd610f';
export const PUSH_TASK = 'timetable-push';

// Background task: fires when a data-only push arrives while the app is
// backgrounded/terminated. On a "locate" push, grab a fix and sync it.
TaskManager.defineTask(PUSH_TASK, async ({ data, error }) => {
  // first-line heartbeat: proves the headless task actually ran, before any
  // permission/GPS/network step that might silently fail in the background
  await kvSet('last_push_tick', new Date().toISOString()).catch(() => {});
  if (error) return;
  try {
    const payload = (data as { data?: { kind?: string } })?.data ?? (data as { kind?: string });
    if (payload?.kind !== 'locate') return;

    const raw = await kvGet('open_shift');
    if (!raw) return; // not on shift → nothing to locate (server shouldn't ask)
    const { clockEventId } = JSON.parse(raw) as { clockEventId: string };

    // last-known position resolves in the background; a live one-shot usually won't
    const fix = await getBackgroundFix();
    if (!fix) return;
    await insertPings([
      {
        id: uuidv7(),
        clockEventId,
        seq: await nextPingSeq(clockEventId),
        deviceAt: fix.deviceAt,
        lat: fix.lat,
        lng: fix.lng,
        accuracyM: fix.accuracyM,
        speedMps: null,
        mocked: fix.mocked,
        batteryPct: fix.batteryPct,
      },
    ]);
    await flush();
  } catch {
    /* best effort */
  }
});

/**
 * Register for push: permission, Android channel, get the Expo token, store it
 * server-side. Safe to call repeatedly; silently no-ops if push isn't
 * available (e.g. FCM not configured, or a simulator).
 */
export async function registerForPush(): Promise<void> {
  try {
    const perm = await Notifications.getPermissionsAsync();
    let granted = perm.granted;
    if (!granted) {
      const req = await Notifications.requestPermissionsAsync();
      granted = req.granted;
    }
    if (!granted) return;

    if (Platform.OS === 'android') {
      // channel must exist before requesting the token on Android 13+
      await Notifications.setNotificationChannelAsync('tracking', {
        name: 'Location checks',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }

    const token = (await Notifications.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID })).data;
    if (!token) return;

    await Notifications.registerTaskAsync(PUSH_TASK);

    await supabase.rpc('register_push_token', {
      p_token: token,
      p_platform: Platform.OS === 'ios' ? 'ios' : 'android',
    });
  } catch {
    // no push (FCM unset / offline / simulator) — the 30s poll covers locate
  }
}
