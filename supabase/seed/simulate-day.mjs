#!/usr/bin/env node
// End-to-end smoke test against a RUNNING stack (Unraid or local compose):
// creates a demo company, a manager and a worker, then replays a full working
// day — clock in, breadcrumbs across three houses, clock out — through the
// exact same RPCs the mobile app uses, and prints the resulting timesheet.
//
// Usage:
//   SUPABASE_URL=http://<host>:8000 \
//   SERVICE_ROLE_KEY=... JWT_SECRET=... \
//   node simulate-day.mjs
//
// Zero dependencies (Node 18+). Idempotent: safe to re-run.
import crypto from 'node:crypto';

const URL_BASE = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SERVICE_KEY = process.env.SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
if (!URL_BASE || !SERVICE_KEY || !JWT_SECRET) {
  console.error('Set SUPABASE_URL, SERVICE_ROLE_KEY and JWT_SECRET (see supabase/docker/.env)');
  process.exit(1);
}

const MANAGER_PHONE = '+353899000001';
const WORKER_PHONE = '+353899000002';
const COMPANY = 'Demo Builders';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
function signJwt(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}
const userToken = (sub) =>
  signJwt({
    sub,
    role: 'authenticated',
    aud: 'authenticated',
    iss: `${URL_BASE}/auth/v1`,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

async function api(path, { method = 'GET', token = SERVICE_KEY, body, headers = {} } = {}) {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

const rpc = (name, args, token) =>
  api(`/rest/v1/rpc/${name}`, { method: 'POST', body: args, token });

async function ensureUser(phone) {
  const create = await api('/auth/v1/admin/users', {
    method: 'POST',
    body: { phone: phone.replace('+', ''), phone_confirm: true },
  });
  if (create.status === 200 || create.status === 201) return create.json.id;
  // already exists → find it
  const list = await api('/auth/v1/admin/users?per_page=1000');
  const digits = phone.replace(/\D/g, '');
  const found = (list.json?.users ?? []).find((u) => (u.phone ?? '').replace(/\D/g, '') === digits);
  if (!found) throw new Error(`could not create or find user ${phone}: ${JSON.stringify(create.json)}`);
  return found.id;
}

function fail(step, res) {
  throw new Error(`${step} failed (${res.status}): ${JSON.stringify(res.json)}`);
}

const HOUSES = [
  { lat: 53.3382, lng: -6.2591 },
  { lat: 53.3527, lng: -6.2603 },
  { lat: 53.3441, lng: -6.2489 },
];

async function main() {
  console.log('→ ensuring auth users exist');
  const managerId = await ensureUser(MANAGER_PHONE);
  const workerId = await ensureUser(WORKER_PHONE);
  const managerJwt = userToken(managerId);
  const workerJwt = userToken(workerId);

  console.log('→ ensuring demo company + manager invite');
  const companies = await api(`/rest/v1/companies?name=eq.${encodeURIComponent(COMPANY)}&select=id`);
  if ((companies.json ?? []).length === 0) {
    const created = await rpc('create_company_with_manager_invite', {
      p_company_name: COMPANY,
      p_manager_phone: MANAGER_PHONE,
      p_manager_name: 'Demo Manager',
    });
    if (created.status >= 300) fail('create_company', created);
  }

  console.log('→ manager claims invite');
  const managerProfile = await rpc('claim_invite', {}, managerJwt);
  if (managerProfile.status >= 300) fail('manager claim_invite', managerProfile);

  console.log('→ manager invites the worker');
  const invite = await api('/rest/v1/invites', {
    method: 'POST',
    token: managerJwt,
    body: {
      company_id: managerProfile.json.company_id,
      phone_e164: WORKER_PHONE,
      role: 'worker',
      full_name: 'Demo Worker',
      created_by: managerProfile.json.id,
    },
    headers: { Prefer: 'return=minimal' },
  });
  if (invite.status >= 300 && !JSON.stringify(invite.json).includes('invites_pending_phone_uq')) {
    // duplicate pending invite or already-claimed is fine on re-runs
    if (invite.status !== 409) fail('invite worker', invite);
  }

  console.log('→ worker claims invite + acknowledges the privacy notice');
  const workerProfile = await rpc('claim_invite', {}, workerJwt);
  if (workerProfile.status >= 300) fail('worker claim_invite', workerProfile);
  await rpc('record_acknowledgment', { p_notice_version: 'sim-v1' }, workerJwt);

  console.log('→ clock in (4 hours ago, house 1)');
  const dayStart = Date.now() - 4 * 3600_000;
  const clockIn = await rpc(
    'clock_in',
    {
      p_client_event_id: crypto.randomUUID(),
      p_device_at: new Date(dayStart).toISOString(),
      p_lat: HOUSES[0].lat,
      p_lng: HOUSES[0].lng,
      p_accuracy_m: 9,
      p_mocked: false,
      p_device_info: { model: 'simulator' },
    },
    workerJwt,
  );
  if (clockIn.status >= 300) {
    if (JSON.stringify(clockIn.json).includes('shift_already_open')) {
      console.log('  (a previous sim left a shift open — clocking it out first)');
      await rpc('clock_out', { p_client_event_id: crypto.randomUUID(), p_device_at: new Date().toISOString() }, workerJwt);
      return main();
    }
    fail('clock_in', clockIn);
  }
  const shiftId = clockIn.json.id;

  console.log('→ syncing breadcrumbs (3-min pings across 3 houses, sent twice to prove idempotency)');
  let seq = 0;
  const points = [];
  for (let t = dayStart + 3 * 60_000; t < Date.now() - 5 * 60_000; t += 3 * 60_000) {
    const house = HOUSES[Math.floor((t - dayStart) / 3600_000) % HOUSES.length];
    points.push({
      id: crypto.randomUUID(),
      seq: ++seq,
      device_at: new Date(t).toISOString(),
      lat: house.lat + (Math.random() - 0.5) * 4e-4,
      lng: house.lng + (Math.random() - 0.5) * 4e-4,
      accuracy_m: Math.round(8 + Math.random() * 25),
      speed_mps: 0.4,
      mocked: false,
      battery_pct: 90 - Math.floor((t - dayStart) / 3600_000) * 7,
    });
  }
  let accepted = 0;
  for (const pass of [1, 2]) {
    for (let i = 0; i < points.length; i += 100) {
      const res = await rpc('sync_location_batch', { p_shift_id: shiftId, p_points: points.slice(i, i + 100) }, workerJwt);
      if (res.status >= 300) fail('sync_location_batch', res);
      if (pass === 1) accepted += res.json.accepted;
      if (pass === 2 && res.json.accepted !== 0) throw new Error('idempotency broken: re-sent batch was accepted again');
    }
  }
  console.log(`  ${accepted} pings accepted, replay produced 0 duplicates ✓`);

  console.log('→ clock out (now, house 3)');
  const clockOut = await rpc(
    'clock_out',
    {
      p_client_event_id: crypto.randomUUID(),
      p_device_at: new Date().toISOString(),
      p_lat: HOUSES[2].lat,
      p_lng: HOUSES[2].lng,
      p_accuracy_m: 11,
      p_mocked: false,
    },
    workerJwt,
  );
  if (clockOut.status >= 300) fail('clock_out', clockOut);

  console.log("→ manager's view:");
  const sheet = await api(
    `/rest/v1/v_timesheet_daily?worker_id=eq.${workerId}&select=*`,
    { token: managerJwt },
  );
  for (const row of sheet.json ?? []) {
    console.log(`  ${row.work_date}  ${row.full_name}: ${row.worked_hours}h over ${row.shift_count} shift(s), flags: ${row.flagged_shifts}`);
  }
  const shift = await api(`/rest/v1/v_shift_effective?id=eq.${shiftId}&select=worked_seconds,anomaly_flags`, { token: managerJwt });
  console.log(`  shift total: ${(shift.json[0].worked_seconds / 3600).toFixed(2)}h, flags: [${shift.json[0].anomaly_flags}]`);
  console.log('\n✓ full day simulated through the real stack — open the dashboard to see it.');
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
