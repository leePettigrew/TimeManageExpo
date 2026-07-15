// TimeTable push-worker — sends Expo push notifications for the push_outbox
// queue. Wakes on Postgres NOTIFY (instant) and polls every 10s (fallback /
// catch-up after downtime). Sends data-only "locate" pushes so the app's
// background task captures a fresh fix without any user tap.
//
// No FCM key needed here — Expo's push service handles delivery; the FCM
// credentials live in the EAS project (set up once). This worker only needs a
// Postgres connection.
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const POLL_MS = 10_000;
const MAX_ATTEMPTS = 5;

if (!DATABASE_URL) {
  console.error('push-worker: DATABASE_URL is required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
let draining = false;

async function sendExpo(messages) {
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(messages),
  });
  if (!res.ok) throw new Error(`Expo push HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.data ?? [];
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    // jobs for workers with no registered device can never send — retire them
    await pool.query(`
      update push_outbox set attempts = $1, last_error = 'no device token'
      where sent_at is null and attempts < $1
        and worker_id not in (select worker_id from device_tokens)
    `, [MAX_ATTEMPTS]);

    // pull a batch of unsent jobs joined to the worker's device tokens
    const { rows } = await pool.query(`
      select o.id, o.kind, o.payload, o.attempts, t.token
      from push_outbox o
      join device_tokens t on t.worker_id = o.worker_id
      where o.sent_at is null and o.attempts < $1
      order by o.created_at
      limit 100
    `, [MAX_ATTEMPTS]);

    if (rows.length === 0) return;

    const messages = rows.map((r) => ({
      to: r.token,
      // data-only: no title/body → the OS delivers it silently to the
      // background task rather than showing a banner
      data: { kind: r.kind, ...r.payload },
      _contentAvailable: true,
      priority: 'high',
      channelId: 'tracking',
    }));

    const tickets = await sendExpo(messages);

    // mark sent / record errors per ticket
    for (let i = 0; i < rows.length; i++) {
      const t = tickets[i];
      if (t && t.status === 'ok') {
        await pool.query(`update push_outbox set sent_at = now() where id = $1`, [rows[i].id]);
      } else {
        const err = t?.message ?? 'unknown';
        await pool.query(
          `update push_outbox set attempts = attempts + 1, last_error = $2 where id = $1`,
          [rows[i].id, String(err).slice(0, 200)],
        );
        // Expo tells us when a token is dead — prune it
        if (t?.details?.error === 'DeviceNotRegistered') {
          await pool.query(`delete from device_tokens where token = $1`, [rows[i].token]);
        }
      }
    }
    console.log(`push-worker: processed ${rows.length} job(s)`);
  } catch (e) {
    console.error('push-worker drain error:', e.message);
  } finally {
    draining = false;
  }
}

async function listen() {
  // dedicated client for LISTEN (kept open)
  const client = await pool.connect();
  client.on('notification', () => void drain());
  client.on('error', (e) => console.error('listen client error:', e.message));
  await client.query('LISTEN push_wake');
  console.log('push-worker: listening on push_wake');
}

async function main() {
  // wait for the db to be reachable
  for (;;) {
    try {
      await pool.query('select 1');
      break;
    } catch {
      console.log('push-worker: waiting for database…');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  await listen();
  setInterval(() => void drain(), POLL_MS);
  void drain();
}

main().catch((e) => {
  console.error('push-worker fatal:', e);
  process.exit(1);
});
