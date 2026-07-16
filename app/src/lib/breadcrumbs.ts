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
import { insertPings, kvGet, kvSet, nextPingSeq, NewPing } from './outbox';
import { batteryPct } from './location';
import { flush } from './sync';

export const BREADCRUMB_TASK = 'timetable-breadcrumbs';

interface TaskData {
  locations: Location.LocationObject[];
}

TaskManager.defineTask(BREADCRUMB_TASK, async ({ data, error }) => {
  // Heartbeat: record every time the OS invokes this task, even on error/empty.
  // The diagnostics screen shows this so we can SEE the background task firing
  // (or not) while the app is backgrounded.
  await kvSet('last_task_tick', new Date().toISOString()).catch(() => {});
  if (error) {
    await kvSet('last_task_error', String(error.message ?? error)).catch(() => {});
    return;
  }
  if (!data) return;
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

  // Capture-first: persist points to SQLite BEFORE any network/interval work,
  // and guard the tail so a bridgeless-teardown mid-callback can't lose points
  // that were already gathered. Worst case they capture locally and flush when
  // the app next foregrounds.
  try {
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
    await kvSet('last_capture_tick', new Date().toISOString()).catch(() => {});

    // manager may have changed the ping cadence since the task started
    await applyIntervalSetting();
  } catch {
    /* points already inserted or unrecoverable — never throw from the task */
  }

  // opportunistic near-real-time sync; harmless offline (flush backs off)
  void flush();
});

export type BreadcrumbState = 'on' | 'off' | 'denied';

const DEFAULT_INTERVAL_S = 90;
const MIN_INTERVAL_S = 5; // fast-tracking floor (heavy battery)
const MAX_INTERVAL_S = 900;

/** Manager-set ping interval (seconds), cached from the server by the sync engine. */
async function desiredIntervalS(): Promise<number> {
  const raw = await kvGet('ping_interval_s');
  const n = raw ? parseInt(raw, 10) : DEFAULT_INTERVAL_S;
  return Number.isFinite(n) ? Math.min(Math.max(n, MIN_INTERVAL_S), MAX_INTERVAL_S) : DEFAULT_INTERVAL_S;
}

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
  return startTaskWithInterval(await desiredIntervalS());
}

async function startTaskWithInterval(intervalS: number): Promise<BreadcrumbState> {
  const fast = intervalS < 60; // sub-minute = high-resolution mode
  // IMPORTANT: do NOT set deferredUpdatesInterval. On Android it batches
  // locations and holds them — often until the app returns to the foreground —
  // which manifests as "only works when focused" (expo/expo #13700, #9200).
  // We want each fix delivered immediately, backgrounded or not.
  //
  // distanceInterval = 0 so a fix arrives every timeInterval even when the
  // worker is standing still (a stationary phone with a movement gate emits
  // nothing). Slightly more points; guarantees a reliable background heartbeat.
  await Location.startLocationUpdatesAsync(BREADCRUMB_TASK, {
    accuracy: fast ? Location.Accuracy.High : Location.Accuracy.Balanced,
    timeInterval: intervalS * 1000, // ping cadence
    distanceInterval: 0,            // time-driven, works when stationary
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
  await kvSet('applied_interval_s', String(intervalS));
  return 'on';
}

/**
 * Apply a changed manager setting mid-shift: restart the task with the new
 * cadence. No-op when tracking isn't running or the setting is unchanged.
 */
export async function applyIntervalSetting(): Promise<void> {
  try {
    if (!(await breadcrumbsRunning())) return;
    const desired = await desiredIntervalS();
    const appliedRaw = await kvGet('applied_interval_s');
    const applied = appliedRaw ? parseInt(appliedRaw, 10) : DEFAULT_INTERVAL_S;
    if (desired === applied) return;
    await Location.stopLocationUpdatesAsync(BREADCRUMB_TASK);
    await startTaskWithInterval(desired);
  } catch {
    // best effort — the next tick retries
  }
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
