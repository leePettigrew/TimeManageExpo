// Background breadcrumb capture. Config follows the researched battery/store
// guidance: Balanced accuracy (~block level — proves site presence), 90s/30m
// intervals, ~5-min deferred batching, an Android foreground-service
// notification (required for reliability, doubles as transparency), and a
// HARD STOP at clock-out — non-negotiable for GDPR and store review.
//
// This module must be imported from the app entry point so the task is
// defined before the background runtime invokes it.
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { uuidv7 } from './ids';
import { insertPings, kvGet, nextPingSeq, NewPing } from './outbox';
import { batteryPct } from './location';
import { flush } from './sync';

export const BREADCRUMB_TASK = 'timetable-breadcrumbs';

interface TaskData {
  locations: Location.LocationObject[];
}

TaskManager.defineTask(BREADCRUMB_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const { locations } = data as TaskData;
  if (!locations?.length) return;

  // pings attach to the local clock-in event; if there is no open shift the
  // task is a zombie (e.g. crash between stop and clock-out) — kill it
  const raw = await kvGet('open_shift');
  if (!raw) {
    await stopBreadcrumbs();
    return;
  }
  const { clockEventId, startedAt } = JSON.parse(raw) as {
    clockEventId: string;
    startedAt: string;
  };

  // deferred batches can deliver fixes captured before a fast clock-out →
  // clock-in cycle; only attribute points captured during THIS shift
  const shiftStartMs = new Date(startedAt).getTime() - 5 * 60_000;
  const fresh = locations.filter((loc) => loc.timestamp >= shiftStartMs);
  if (fresh.length === 0) return;

  const battery = await batteryPct();
  let seq = await nextPingSeq(clockEventId);
  const points: NewPing[] = fresh.map((loc) => ({
    id: uuidv7(),
    clockEventId,
    seq: seq++,
    deviceAt: new Date(loc.timestamp),
    lat: loc.coords.latitude,
    lng: loc.coords.longitude,
    accuracyM: loc.coords.accuracy ?? null,
    speedMps: loc.coords.speed ?? null,
    mocked: loc.mocked ?? false,
    batteryPct: battery,
  }));
  await insertPings(points);

  // opportunistic near-real-time sync; harmless offline (flush backs off)
  void flush();
});

export type BreadcrumbState = 'on' | 'off' | 'denied';

/**
 * Start tracking for the current shift. Requires the disclosure screen to have
 * been acknowledged (Play prominent-disclosure rules: in-app disclosure BEFORE
 * the OS permission prompt). Returns 'denied' when background permission is
 * refused — the shift still works, degraded to clock-in/out points only.
 */
export async function startBreadcrumbs(): Promise<BreadcrumbState> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return 'denied';
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted') return 'denied';

  if (await Location.hasStartedLocationUpdatesAsync(BREADCRUMB_TASK).catch(() => false)) {
    return 'on';
  }

  await Location.startLocationUpdatesAsync(BREADCRUMB_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 90_000,          // Android: ping every ~90s while moving
    distanceInterval: 30,          // suppress redundant points inside a house
    deferredUpdatesInterval: 300_000, // batch delivery ~5 min — big battery win
    pausesUpdatesAutomatically: false, // iOS may otherwise pause and never resume
    activityType: Location.ActivityType.Other,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'TimeTable is recording your location',
      notificationBody: 'Only while you are clocked in. Clock out to stop.',
      notificationColor: '#22c55e',
      killServiceOnDestroy: false, // survive app swipe-away; clock-out still kills it
    },
  });
  return 'on';
}

/** Hard stop. Called at clock-out, sign-out, and on zombie detection. */
export async function stopBreadcrumbs(): Promise<void> {
  // verify the stop took and retry once — a silently-failed stop here would
  // keep recording after clock-out, which must never happen
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!(await Location.hasStartedLocationUpdatesAsync(BREADCRUMB_TASK))) return;
      await Location.stopLocationUpdatesAsync(BREADCRUMB_TASK);
    } catch {
      return; // task not registered — already stopped
    }
  }
}

export async function breadcrumbsRunning(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(BREADCRUMB_TASK);
  } catch {
    return false;
  }
}

/**
 * Restart tracking after an app relaunch mid-shift — but NEVER prompt from
 * here: only resume when both permissions are already granted.
 */
export async function resumeBreadcrumbsIfGranted(): Promise<BreadcrumbState> {
  const fg = await Location.getForegroundPermissionsAsync();
  const bg = await Location.getBackgroundPermissionsAsync();
  if (fg.status !== 'granted' || bg.status !== 'granted') return 'denied';
  return startBreadcrumbs();
}
