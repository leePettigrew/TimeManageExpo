// Shift actions: outbox-first clock in/out plus reconciliation with the
// server. The local view is derived from the newest clock event; the server
// remains the authority whenever we can reach it.
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import { uuidv7 } from './ids';
import { getFix } from './location';
import {
  insertClockEvent,
  latestClockEvent,
  pendingClockEvents,
  kvGet,
  kvSet,
  kvDelete,
  markClockEventSynced,
} from './outbox';
import { flush } from './sync';
import { supabase } from './supabase';
import {
  startBreadcrumbs,
  stopBreadcrumbs,
  resumeBreadcrumbsIfGranted,
  BreadcrumbState,
} from './breadcrumbs';
import { scheduleClockOutReminder, cancelClockOutReminder } from './reminders';

export interface LocalShift {
  clockEventId: string;      // local handle; pings attach to this
  serverShiftId: string | null;
  startedAt: string;         // ISO, device time
  pendingSync: boolean;
}

const KV_OPEN_SHIFT = 'open_shift';

export async function getLocalShift(): Promise<LocalShift | null> {
  const raw = await kvGet(KV_OPEN_SHIFT);
  return raw ? (JSON.parse(raw) as LocalShift) : null;
}

function deviceInfo(): Record<string, unknown> {
  return {
    os: Platform.OS,
    os_version: String(Platform.Version),
    model: Device.modelName ?? 'unknown',
  };
}

/**
 * Clock in: capture a quick GPS fix (never blocks on it), write the event to
 * the outbox, update local state, then try to sync. Works fully offline.
 */
export async function clockIn(): Promise<LocalShift> {
  const existing = await getLocalShift();
  if (existing) return existing;

  const id = uuidv7();
  const fix = await getFix();
  await insertClockEvent({
    id,
    kind: 'in',
    deviceAt: new Date(),
    lat: fix?.lat ?? null,
    lng: fix?.lng ?? null,
    accuracyM: fix?.accuracyM ?? null,
    mocked: fix?.mocked ?? false,
    deviceInfo: deviceInfo(),
  });

  const shift: LocalShift = {
    clockEventId: id,
    serverShiftId: null,
    startedAt: new Date().toISOString(),
    pendingSync: true,
  };
  await kvSet(KV_OPEN_SHIFT, JSON.stringify(shift));

  // breadcrumbs begin the moment the shift does (permission prompt happens
  // here, always after the disclosure screen has been acknowledged)
  const trail: BreadcrumbState = await startBreadcrumbs().catch(() => 'off' as const);
  await kvSet('breadcrumbs_state', trail);
  await scheduleClockOutReminder();

  void flush().then(() => refreshLocalShiftFromOutbox());
  return shift;
}

/** Clock out: tracking hard-stops FIRST, then the event is recorded. */
export async function clockOut(): Promise<void> {
  await stopBreadcrumbs();
  await kvSet('breadcrumbs_state', 'off');
  await cancelClockOutReminder();
  const id = uuidv7();
  const fix = await getFix();
  await insertClockEvent({
    id,
    kind: 'out',
    deviceAt: new Date(),
    lat: fix?.lat ?? null,
    lng: fix?.lng ?? null,
    accuracyM: fix?.accuracyM ?? null,
    mocked: fix?.mocked ?? false,
  });
  await kvDelete(KV_OPEN_SHIFT);
  void flush();
}

/** Pull the server shift id into local state once the clock-in is acked. */
export async function refreshLocalShiftFromOutbox(): Promise<LocalShift | null> {
  const shift = await getLocalShift();
  if (!shift) return null;
  const latest = await latestClockEvent();
  if (latest && latest.id === shift.clockEventId) {
    const updated: LocalShift = {
      ...shift,
      serverShiftId: latest.server_shift_id,
      pendingSync: latest.synced === 0,
    };
    await kvSet(KV_OPEN_SHIFT, JSON.stringify(updated));
    return updated;
  }
  return shift;
}

/**
 * Server reconciliation, called when online after a full flush: the server's
 * view of "do I have an open shift" wins over any stale local state (e.g. a
 * manager adjustment, an auto-close overnight, or app reinstall mid-shift).
 */
export async function reconcileWithServer(): Promise<LocalShift | null> {
  // NEVER reconcile over unsynced clock events: the server's view is stale by
  // definition (e.g. a clock-out queued offline — trusting the server here
  // would resurrect the shift and RESTART tracking after the worker stopped
  // it, which must not happen). Flush first; reconcile when the outbox is clean.
  if ((await pendingClockEvents()).length > 0) {
    return getLocalShift();
  }

  const { data, error } = await supabase
    .from('shifts')
    .select('id, client_event_id, clock_in_device_at, status')
    .eq('status', 'open')
    .maybeSingle();
  if (error) return getLocalShift(); // offline or transient: keep local view

  const local = await getLocalShift();
  if (data) {
    const shift: LocalShift = {
      clockEventId: data.client_event_id,
      serverShiftId: data.id,
      startedAt: data.clock_in_device_at,
      pendingSync: false,
    };
    await kvSet(KV_OPEN_SHIFT, JSON.stringify(shift));
    // reinstall mid-shift: make sure the outbox knows the mapping too
    await markClockEventSynced(data.client_event_id, data.id).catch(() => {});
    // app relaunch mid-shift: resume the trail if permissions still allow it
    const trail = await resumeBreadcrumbsIfGranted().catch(() => 'off' as const);
    await kvSet('breadcrumbs_state', trail);
    return shift;
  }
  if (local && !local.pendingSync) {
    // server says closed (auto-close/manager action) and we have nothing queued
    await kvDelete(KV_OPEN_SHIFT);
    await stopBreadcrumbs();
    await kvSet('breadcrumbs_state', 'off');
    return null;
  }
  return local;
}
