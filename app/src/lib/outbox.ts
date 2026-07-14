// Durable on-device outbox (expo-sqlite, WAL). Clock events and GPS pings are
// written here FIRST — the UI reflects local state instantly regardless of
// signal — then the sync engine drains them to the server. Rows are marked
// synced only after a server ACK; retries are harmless because every row
// carries a client-generated UUIDv7 the server deduplicates on.
import * as SQLite from 'expo-sqlite';

export type ClockKind = 'in' | 'out';

export interface ClockEventRow {
  id: string;
  kind: ClockKind;
  device_at: string; // ISO
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  mocked: number;
  device_info: string;
  synced: number;
  attempts: number;
  last_error: string | null;
  server_shift_id: string | null;
  created_at: string;
}

export interface PingRow {
  id: string;
  clock_event_id: string; // local clock-in event this ping belongs to
  seq: number;
  device_at: string;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  speed_mps: number | null;
  mocked: number;
  battery_pct: number | null;
  synced: number;
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function open(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('outbox.db');
      await db.execAsync(`
        pragma journal_mode = WAL;
        create table if not exists kv (
          key text primary key,
          value text not null
        );
        create table if not exists clock_events (
          id text primary key,
          kind text not null check (kind in ('in','out')),
          device_at text not null,
          lat real, lng real, accuracy_m real,
          mocked integer not null default 0,
          device_info text not null default '{}',
          synced integer not null default 0,
          attempts integer not null default 0,
          last_error text,
          server_shift_id text,
          created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        create index if not exists clock_events_pending on clock_events (synced, created_at);
        create table if not exists pings (
          id text primary key,
          clock_event_id text not null,
          seq integer not null,
          device_at text not null,
          lat real not null,
          lng real not null,
          accuracy_m real,
          speed_mps real,
          mocked integer not null default 0,
          battery_pct integer,
          synced integer not null default 0
        );
        create index if not exists pings_pending on pings (synced, clock_event_id, seq);
      `);
      return db;
    })();
  }
  return dbPromise;
}

// ── kv ───────────────────────────────────────────────────────────────────────

export async function kvGet(key: string): Promise<string | null> {
  const db = await open();
  const row = await db.getFirstAsync<{ value: string }>('select value from kv where key = ?', [key]);
  return row?.value ?? null;
}

export async function kvSet(key: string, value: string): Promise<void> {
  const db = await open();
  await db.runAsync(
    'insert into kv (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
    [key, value],
  );
}

export async function kvDelete(key: string): Promise<void> {
  const db = await open();
  await db.runAsync('delete from kv where key = ?', [key]);
}

// ── clock events ─────────────────────────────────────────────────────────────

export interface NewClockEvent {
  id: string;
  kind: ClockKind;
  deviceAt: Date;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  mocked: boolean;
  deviceInfo?: Record<string, unknown>;
}

export async function insertClockEvent(e: NewClockEvent): Promise<void> {
  const db = await open();
  await db.runAsync(
    `insert or ignore into clock_events (id, kind, device_at, lat, lng, accuracy_m, mocked, device_info)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      e.id,
      e.kind,
      e.deviceAt.toISOString(),
      e.lat,
      e.lng,
      e.accuracyM,
      e.mocked ? 1 : 0,
      JSON.stringify(e.deviceInfo ?? {}),
    ],
  );
}

export async function pendingClockEvents(): Promise<ClockEventRow[]> {
  const db = await open();
  // rowid is the monotonic insertion order — immune to device clock steps,
  // which matters because a clock_out replayed before its clock_in dies
  return db.getAllAsync<ClockEventRow>(
    `select * from clock_events where synced = 0 order by rowid asc`,
  );
}

export async function markClockEventSynced(id: string, serverShiftId: string | null): Promise<void> {
  const db = await open();
  await db.runAsync(
    `update clock_events set synced = 1, last_error = null, server_shift_id = ? where id = ?`,
    [serverShiftId, id],
  );
}

export async function markClockEventFailed(id: string, error: string): Promise<void> {
  const db = await open();
  await db.runAsync(
    `update clock_events set attempts = attempts + 1, last_error = ? where id = ?`,
    [error, id],
  );
}

/** Permanent server rejection: keep the row for evidence but stop retrying. */
export async function markClockEventDead(id: string, error: string): Promise<void> {
  const db = await open();
  await db.runAsync(
    `update clock_events set synced = 2, attempts = attempts + 1, last_error = ? where id = ?`,
    [error, id],
  );
}

export async function latestClockEvent(): Promise<ClockEventRow | null> {
  const db = await open();
  const row = await db.getFirstAsync<ClockEventRow>(
    `select * from clock_events where synced in (0, 1) order by rowid desc limit 1`,
  );
  return row ?? null;
}

export async function serverShiftIdFor(clockEventId: string): Promise<string | null> {
  const db = await open();
  const row = await db.getFirstAsync<{ server_shift_id: string | null }>(
    `select server_shift_id from clock_events where id = ?`,
    [clockEventId],
  );
  return row?.server_shift_id ?? null;
}

// ── pings ────────────────────────────────────────────────────────────────────

export interface NewPing {
  id: string;
  clockEventId: string;
  seq: number;
  deviceAt: Date;
  lat: number;
  lng: number;
  accuracyM: number | null;
  speedMps: number | null;
  mocked: boolean;
  batteryPct: number | null;
}

export async function insertPings(points: NewPing[]): Promise<void> {
  if (points.length === 0) return;
  const db = await open();
  await db.withTransactionAsync(async () => {
    for (const p of points) {
      await db.runAsync(
        `insert or ignore into pings (id, clock_event_id, seq, device_at, lat, lng, accuracy_m, speed_mps, mocked, battery_pct)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.id,
          p.clockEventId,
          p.seq,
          p.deviceAt.toISOString(),
          p.lat,
          p.lng,
          p.accuracyM,
          p.speedMps,
          p.mocked ? 1 : 0,
          p.batteryPct,
        ],
      );
    }
  });
}

/** Pending pings for one local shift (clock-in event), oldest first. */
export async function pendingPings(clockEventId: string, limit = 100): Promise<PingRow[]> {
  const db = await open();
  return db.getAllAsync<PingRow>(
    `select * from pings where synced = 0 and clock_event_id = ? order by seq asc limit ?`,
    [clockEventId, limit],
  );
}

export async function clockEventIdsWithPendingPings(): Promise<string[]> {
  const db = await open();
  const rows = await db.getAllAsync<{ clock_event_id: string }>(
    `select distinct clock_event_id from pings where synced = 0`,
  );
  return rows.map((r) => r.clock_event_id);
}

export async function markPingsSynced(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await open();
  const placeholders = ids.map(() => '?').join(',');
  await db.runAsync(`update pings set synced = 1 where id in (${placeholders})`, ids);
}

export async function nextPingSeq(clockEventId: string): Promise<number> {
  const db = await open();
  const row = await db.getFirstAsync<{ m: number | null }>(
    `select max(seq) m from pings where clock_event_id = ?`,
    [clockEventId],
  );
  return (row?.m ?? 0) + 1;
}

// ── status + hygiene ─────────────────────────────────────────────────────────

export async function pendingCounts(): Promise<{ events: number; pings: number }> {
  const db = await open();
  const e = await db.getFirstAsync<{ n: number }>(`select count(*) n from clock_events where synced = 0`);
  const p = await db.getFirstAsync<{ n: number }>(`select count(*) n from pings where synced = 0`);
  return { events: e?.n ?? 0, pings: p?.n ?? 0 };
}

/** Trim old rows so the device DB never grows unbounded (device-side GDPR). */
export async function vacuumOutbox(): Promise<void> {
  const db = await open();
  await db.runAsync(`delete from pings where synced = 1 and device_at < datetime('now', '-7 days')`);
  // pings whose clock-in was permanently rejected can never upload — drop them
  await db.runAsync(
    `delete from pings where clock_event_id in (select id from clock_events where synced = 2)`,
  );
  // absolute cap: no location data lingers on the device past 30 days, synced or not
  await db.runAsync(`delete from pings where device_at < datetime('now', '-30 days')`);
  await db.runAsync(
    `delete from clock_events where synced in (1, 2) and device_at < datetime('now', '-30 days')`,
  );
}

/** Wipe everything (sign-out of a shared device). */
export async function resetOutbox(): Promise<void> {
  const db = await open();
  await db.execAsync(`delete from pings; delete from clock_events; delete from kv;`);
}
