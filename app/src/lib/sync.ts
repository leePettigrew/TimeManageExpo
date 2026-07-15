// Sync engine: drains the outbox to the server in order — clock events first
// (they anchor shifts), then ping batches per shift. Rows are marked synced
// only on server ACK; the server dedupes on client UUIDs so retries and
// double-sends are harmless. Permanent rejections (state-machine or timestamp
// violations) stop retrying but keep the row as evidence.
import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';
import { supabase, rpcErrorCode, isNetworkError } from './supabase';
import {
  pendingClockEvents,
  markClockEventSynced,
  markClockEventFailed,
  markClockEventDead,
  clockEventIdsWithPendingPings,
  pendingPings,
  markPingsSynced,
  serverShiftIdFor,
  vacuumOutbox,
  insertPings,
  nextPingSeq,
  pendingCounts,
  kvGet,
  kvSet,
} from './outbox';
import { getFix } from './location';
import { uuidv7 } from './ids';

export interface SyncStatus {
  running: boolean;
  lastResult: 'idle' | 'ok' | 'offline' | 'error';
  lastSyncAt: Date | null;
  lastError: string | null;
}

type Listener = (s: SyncStatus) => void;

const PERMANENT_ERRORS = new Set([
  'shift_already_open',
  'no_open_shift',
  'device_timestamp_in_future',
  'device_timestamp_too_old',
  'no_active_profile',
  'shift_not_found',
]);

const status: SyncStatus = { running: false, lastResult: 'idle', lastSyncAt: null, lastError: null };
const listeners = new Set<Listener>();
let backoffMs = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let rerunRequested = false;

function notify() {
  for (const l of listeners) l({ ...status });
}

export function onSyncStatus(listener: Listener): () => void {
  listeners.add(listener);
  listener({ ...status });
  return () => listeners.delete(listener);
}

/** Wire up the triggers once per app run: connectivity regained, app foregrounded. */
export function startSyncTriggers(): void {
  if (started) return;
  started = true;
  NetInfo.addEventListener((state) => {
    if (state.isConnected) {
      backoffMs = 0;
      void flush();
    }
  });
  AppState.addEventListener('change', (next) => {
    if (next === 'active') {
      backoffMs = 0;
      void flush();
    }
  });
  // Always-on auto-sync: every 30s, if anything is queued or a shift is open,
  // drain it. Keeps the queue empty without the worker ever tapping "Send",
  // and picks up manager settings / locate requests near-real-time on-shift.
  setInterval(async () => {
    try {
      const counts = await pendingCounts();
      const shift = await kvGet('open_shift');
      if (counts.events + counts.pings > 0 || shift) void flush();
    } catch {
      /* ignore */
    }
  }, 30_000);
}

function scheduleRetry() {
  backoffMs = Math.min(backoffMs === 0 ? 5_000 : backoffMs * 2, 5 * 60_000);
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void flush(), backoffMs);
}

/**
 * Drain the outbox once. Safe to call from anywhere, any time; concurrent
 * calls coalesce into the in-flight run.
 */
export async function flush(): Promise<SyncStatus> {
  if (status.running) {
    // don't drop work enqueued mid-run (e.g. a clock-out during a ping flush):
    // remember it and go again as soon as the in-flight run finishes
    rerunRequested = true;
    return { ...status };
  }
  status.running = true;
  notify();

  try {
    // 1) clock events, strictly in insertion order — a transient failure must
    //    STOP the loop, or a later clock_out replays before its clock_in and
    //    is permanently rejected server-side
    const events = await pendingClockEvents();
    for (const e of events) {
      const args = {
        p_client_event_id: e.id,
        p_device_at: e.device_at,
        p_lat: e.lat,
        p_lng: e.lng,
        p_accuracy_m: e.accuracy_m,
        p_mocked: e.mocked === 1,
      };
      const { data, error } =
        e.kind === 'in'
          ? await supabase.rpc('clock_in', { ...args, p_device_info: JSON.parse(e.device_info || '{}') })
          : await supabase.rpc('clock_out', args);

      if (!error) {
        const shift = Array.isArray(data) ? data[0] : data;
        await markClockEventSynced(e.id, shift?.id ?? null);
        continue;
      }
      if (isNetworkError(error)) {
        await markClockEventFailed(e.id, error.message);
        throw new OfflineError();
      }
      const code = rpcErrorCode(error);
      if (PERMANENT_ERRORS.has(code)) {
        // e.g. replayed clock-in raced an existing open shift: keep the row as
        // evidence, stop retrying, let reconcile() fix the local view
        await markClockEventDead(e.id, code);
      } else if (e.attempts + 1 >= 6) {
        // an unrecognised server error that has failed 6 times is not a passing
        // hiccup — park it (kept as evidence, synced=2) so it stops blocking
        // everything queued behind it. reconcileWithServer repairs local state.
        await markClockEventDead(e.id, `stuck:${code}:${error.message}`.slice(0, 120));
      } else {
        // transient server error: retry, but stop the loop so later events keep
        // their order (a clock_out must never sync before its clock_in)
        await markClockEventFailed(e.id, error.message);
        throw error;
      }
    }

    // acknowledgment recorded offline: deliver it now (GDPR Art 13 evidence)
    const ackVersion = await kvGet('ack_version');
    const ackSynced = await kvGet('ack_synced');
    if (ackVersion && ackVersion !== ackSynced) {
      const { error } = await supabase.rpc('record_acknowledgment', {
        p_notice_version: ackVersion,
      });
      if (!error) await kvSet('ack_synced', ackVersion);
      else if (isNetworkError(error)) throw new OfflineError();
    }

    // manager controls: refresh the ping-interval setting, and answer any
    // pending "locate now" request with an immediate fix (only mid-shift —
    // the server refuses to create requests otherwise)
    await refreshLocationControls();

    // 2) ping batches, per shift, only once the shift's clock-in has a server id
    const shiftsWithPings = await clockEventIdsWithPendingPings();
    for (const clockEventId of shiftsWithPings) {
      const serverShiftId = await serverShiftIdFor(clockEventId);
      if (!serverShiftId) continue; // clock-in not acked yet; next flush picks it up

      // loop batches until this shift's queue is empty
      for (;;) {
        const batch = await pendingPings(clockEventId, 100);
        if (batch.length === 0) break;
        const { error } = await supabase.rpc('sync_location_batch', {
          p_shift_id: serverShiftId,
          p_points: batch.map((p) => ({
            id: p.id,
            seq: p.seq,
            device_at: p.device_at,
            lat: p.lat,
            lng: p.lng,
            accuracy_m: p.accuracy_m,
            speed_mps: p.speed_mps,
            mocked: p.mocked === 1,
            battery_pct: p.battery_pct,
          })),
        });
        if (error) {
          if (isNetworkError(error)) throw new OfflineError();
          // permanent rejection of the whole batch is unexpected; mark synced
          // to avoid a poison-pill loop — the server keeps its own counts
          if (rpcErrorCode(error) === 'shift_not_found') {
            await markPingsSynced(batch.map((p) => p.id));
            continue;
          }
          throw error;
        }
        await markPingsSynced(batch.map((p) => p.id));
      }
    }

    await vacuumOutbox();
    status.lastResult = 'ok';
    status.lastSyncAt = new Date();
    status.lastError = null;
    await kvSet('last_sync_at', status.lastSyncAt.toISOString());
    backoffMs = 0;
  } catch (e) {
    if (e instanceof OfflineError) {
      status.lastResult = 'offline';
    } else {
      status.lastResult = 'error';
      status.lastError = e instanceof Error ? e.message : String(e);
    }
    scheduleRetry();
  } finally {
    status.running = false;
    notify();
    if (rerunRequested) {
      rerunRequested = false;
      setTimeout(() => void flush(), 250);
    }
  }
  return { ...status };
}

class OfflineError extends Error {
  constructor() {
    super('offline');
  }
}

async function refreshLocationControls(): Promise<void> {
  try {
    const { data: session } = await supabase.auth.getSession();
    const uid = session.session?.user.id;
    if (!uid) return;

    // cache the manager-set cadence; the breadcrumb task applies it
    const { data: profile } = await supabase
      .from('profiles')
      .select('ping_interval_s')
      .eq('id', uid)
      .maybeSingle();
    if (profile?.ping_interval_s) {
      await kvSet('ping_interval_s', String(profile.ping_interval_s));
    }

    // pending "where are you now?" → take one immediate fix and queue it;
    // the ping-upload stage of this same flush delivers it
    const { data: requests } = await supabase
      .from('location_requests')
      .select('id')
      .is('fulfilled_at', null)
      .limit(1);
    if (!requests || requests.length === 0) return;

    const rawShift = await kvGet('open_shift');
    if (!rawShift) return; // no shift: nothing to answer (server shouldn't allow this state)
    const { clockEventId } = JSON.parse(rawShift) as { clockEventId: string };

    const fix = await getFix(15_000);
    if (!fix) return; // no GPS right now; the next breadcrumb answers it instead
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
  } catch {
    // best effort — never let a locate request break the sync loop
  }
}
