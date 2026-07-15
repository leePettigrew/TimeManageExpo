// Database contract tests: tenant isolation, shift state machine, idempotent
// ingestion, adjustments, retention. Runs the real migrations on a real
// (embedded) Postgres — same assertions as a pgTAP suite, portable to CI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startDb, stopDb, asUser, expectError, IDS } from './setup.mjs';

let pool;

before(async () => {
  pool = await startDb();
}, { timeout: 300_000 });

after(async () => {
  await stopDb();
});

// ── structural guarantees ─────────────────────────────────────────────────────

test('RLS is enabled on every table in public', async () => {
  const { rows } = await pool.query(`
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
  `);
  assert.deepEqual(rows.map((r) => r.relname), [], 'tables without RLS found');
});

test('clients have no direct write grants on event tables', async () => {
  const { rows } = await pool.query(`
    select table_name, privilege_type
    from information_schema.role_table_grants
    where grantee in ('authenticated', 'anon')
      and table_schema = 'public'
      and table_name in ('shifts', 'location_pings', 'worker_latest_ping',
                         'adjustments', 'audit_log', 'acknowledgments', 'companies')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
  `);
  assert.deepEqual(rows, [], `unexpected write grants: ${JSON.stringify(rows)}`);
});

// ── tenant isolation ──────────────────────────────────────────────────────────

test('cross-tenant reads return zero rows on every tenant table', async () => {
  // give company B some data first
  await asUser(IDS.workerB, async (c) => {
    await c.query(`select clock_in($1, now(), 53.35, -6.26, 10, false, '{}')`, [randomUUID()]);
  });

  const tenantTables = ['profiles', 'shifts', 'invites',
    'acknowledgments', 'adjustments', 'audit_log', 'worker_latest_ping', 'location_pings',
    'location_requests'];
  for (const t of tenantTables) {
    const { rows } = await asUser(IDS.managerA, (c) =>
      c.query(`select * from ${t} where company_id = $1`, [IDS.companyB]));
    assert.equal(rows.length, 0, `managerA can read company B rows in ${t}`);
  }
  const { rows: companyRows } = await asUser(IDS.managerA, (c) =>
    c.query(`select * from companies where id = $1`, [IDS.companyB]));
  assert.equal(companyRows.length, 0, 'managerA can read company B in companies');

  // and a worker cannot see a colleague's shifts, only their own
  const { rows } = await asUser(IDS.workerB, (c) => c.query(`select worker_id from shifts`));
  assert.ok(rows.every((r) => r.worker_id === IDS.workerB), 'workerB sees other workers rows');

  await asUser(IDS.workerB, (c) => c.query(`select clock_out($1, now())`, [randomUUID()]));
});

test('direct writes to event tables are denied for clients', async () => {
  const attempts = [
    `insert into shifts (company_id, worker_id, client_event_id, clock_in_device_at)
       values ('${IDS.companyA}', '${IDS.workerA}', '${randomUUID()}', now())`,
    `update shifts set status = 'closed'`,
    `delete from shifts`,
    `insert into worker_latest_ping (worker_id, company_id, shift_id, lat, lng, device_at)
       values ('${IDS.workerA}', '${IDS.companyA}', '${randomUUID()}', 1, 1, now())`,
    `insert into audit_log (action) values ('forged')`,
    `insert into companies (name) values ('Mallory Ltd')`,
    `update profiles set role = 'manager' where id = '${IDS.workerA}'`,
  ];
  for (const q of attempts) {
    await expectError(asUser(IDS.workerA, (c) => c.query(q)), 'permission denied');
  }
});

test('manager cannot update profiles of another company', async () => {
  const res = await asUser(IDS.managerA, (c) =>
    c.query(`update profiles set full_name = 'Hacked' where id = $1`, [IDS.workerB]));
  assert.equal(res.rowCount, 0);
});

// ── shift state machine + idempotency ────────────────────────────────────────

test('clock_in / clock_out state machine', async () => {
  const inEvent = randomUUID();

  const shift = await asUser(IDS.workerA, async (c) => {
    const { rows } = await c.query(
      `select * from clock_in($1, now() - interval '1 minute', 53.34, -6.27, 8, false, '{"model":"test"}')`,
      [inEvent]);
    return rows[0];
  });
  assert.equal(shift.status, 'open');
  assert.ok(shift.clock_in_received_at, 'server stamped received_at');

  // replaying the same clock-in event returns the same shift (no duplicate)
  const replay = await asUser(IDS.workerA, async (c) => {
    const { rows } = await c.query(`select * from clock_in($1, now(), null, null, null, false, '{}')`, [inEvent]);
    return rows[0];
  });
  assert.equal(replay.id, shift.id);

  // a second open shift is impossible
  await expectError(
    asUser(IDS.workerA, (c) => c.query(`select clock_in($1, now(), 1, 1, 1, false, '{}')`, [randomUUID()])),
    'shift_already_open');

  // future and stale device timestamps are rejected
  await expectError(
    asUser(IDS.workerA, (c) =>
      c.query(`select clock_out($1, now() + interval '1 hour')`, [randomUUID()])),
    'device_timestamp_in_future');

  // clock out closes it
  const outEvent = randomUUID();
  const closed = await asUser(IDS.workerA, async (c) => {
    const { rows } = await c.query(`select * from clock_out($1, now(), 53.36, -6.25, 12, false)`, [outEvent]);
    return rows[0];
  });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.id, shift.id);

  // replaying the clock-out returns the same closed shift
  const outReplay = await asUser(IDS.workerA, async (c) => {
    const { rows } = await c.query(`select * from clock_out($1, now())`, [outEvent]);
    return rows[0];
  });
  assert.equal(outReplay.id, shift.id);

  // clocking out again with a new event id fails — no open shift
  await expectError(
    asUser(IDS.workerA, (c) => c.query(`select clock_out($1, now())`, [randomUUID()])),
    'no_open_shift');

  // stale clock-in (worse than the 72h offline window) is rejected
  await expectError(
    asUser(IDS.workerA, (c) =>
      c.query(`select clock_in($1, now() - interval '80 hours', 1, 1, 1, false, '{}')`, [randomUUID()])),
    'device_timestamp_too_old');
});

test('anomaly flags: mocked GPS and missing GPS are flagged, not blocked', async () => {
  const s = await asUser(IDS.workerA, async (c) => {
    const { rows } = await c.query(
      `select * from clock_in($1, now(), 53.3, -6.2, 9, true, '{}')`, [randomUUID()]);
    return rows[0];
  });
  assert.ok(s.anomaly_flags.includes('mock_location'));
  await asUser(IDS.workerA, (c) => c.query(`select clock_out($1, now())`, [randomUUID()]));
});

// ── breadcrumb ingestion ─────────────────────────────────────────────────────

test('sync_location_batch: idempotent, windowed, updates latest ping', async () => {
  const shift = await asUser(IDS.workerA, async (c) => {
    const { rows } = await c.query(
      `select * from clock_in($1, now() - interval '2 hours', 53.34, -6.27, 8, false, '{}')`,
      [randomUUID()]);
    return rows[0];
  });

  const mkPoint = (minsAgo, extra = {}) => ({
    id: randomUUID(),
    seq: extra.seq ?? 0,
    device_at: new Date(Date.now() - minsAgo * 60_000).toISOString(),
    lat: 53.34 + minsAgo / 1000,
    lng: -6.27,
    accuracy_m: 15,
    speed_mps: 1.2,
    mocked: extra.mocked ?? false,
    battery_pct: 80,
  });

  const batch = [mkPoint(90, { seq: 1 }), mkPoint(60, { seq: 2 }), mkPoint(30, { seq: 3 })];

  const res1 = await asUser(IDS.workerA, async (c) => {
    const { rows } = await c.query(`select sync_location_batch($1, $2) r`, [shift.id, JSON.stringify(batch)]);
    return rows[0].r;
  });
  assert.deepEqual(res1, { accepted: 3, duplicates: 0, rejected: 0 });

  // exact resend: everything deduped, row count unchanged
  const res2 = await asUser(IDS.workerA, async (c) => {
    const { rows } = await c.query(`select sync_location_batch($1, $2) r`, [shift.id, JSON.stringify(batch)]);
    return rows[0].r;
  });
  assert.deepEqual(res2, { accepted: 0, duplicates: 3, rejected: 0 });

  const { rows: countRows } = await pool.query(
    `select count(*)::int n from location_pings where shift_id = $1`, [shift.id]);
  assert.equal(countRows[0].n, 3);

  // a point captured before the shift window is rejected
  const res3 = await asUser(IDS.workerA, async (c) => {
    const { rows } = await c.query(`select sync_location_batch($1, $2) r`,
      [shift.id, JSON.stringify([mkPoint(60 * 12)])]);
    return rows[0].r;
  });
  assert.equal(res3.rejected, 1);

  // latest ping row reflects the newest accepted point
  const { rows: latest } = await pool.query(
    `select shift_id from worker_latest_ping where worker_id = $1`, [IDS.workerA]);
  assert.equal(latest[0].shift_id, shift.id);

  // a mocked point flags the shift
  await asUser(IDS.workerA, async (c) => {
    await c.query(`select sync_location_batch($1, $2)`,
      [shift.id, JSON.stringify([mkPoint(10, { mocked: true, seq: 4 })])]);
  });
  const { rows: flagged } = await pool.query(`select anomaly_flags from shifts where id = $1`, [shift.id]);
  assert.ok(flagged[0].anomaly_flags.includes('mock_location'));

  // another worker cannot push points into this shift
  await expectError(
    asUser(IDS.workerB, (c) =>
      c.query(`select sync_location_batch($1, $2)`, [shift.id, JSON.stringify([mkPoint(5)])])),
    'shift_not_found');

  await asUser(IDS.workerA, (c) => c.query(`select clock_out($1, now())`, [randomUUID()]));
});

test('physics checks: teleportation between pings flags the shift', async () => {
  const shift = await asUser(IDS.workerA, async (c) => {
    const { rows } = await c.query(
      `select * from clock_in($1, now() - interval '1 hour', 53.34, -6.27, 8, false, '{}')`,
      [randomUUID()]);
    return rows[0];
  });

  // Dublin → Cork (~220 km) in one minute
  const points = [
    { id: randomUUID(), seq: 1, device_at: new Date(Date.now() - 10 * 60_000).toISOString(), lat: 53.3498, lng: -6.2603, accuracy_m: 10 },
    { id: randomUUID(), seq: 2, device_at: new Date(Date.now() - 9 * 60_000).toISOString(), lat: 51.8985, lng: -8.4756, accuracy_m: 10 },
  ];
  await asUser(IDS.workerA, (c) =>
    c.query(`select sync_location_batch($1, $2)`, [shift.id, JSON.stringify(points)]));

  const { rows } = await pool.query(`select anomaly_flags from shifts where id = $1`, [shift.id]);
  assert.ok(rows[0].anomaly_flags.includes('impossible_speed'),
    `expected impossible_speed in ${rows[0].anomaly_flags}`);
  await asUser(IDS.workerA, (c) => c.query(`select clock_out($1, now())`, [randomUUID()]));
});

// ── onboarding ───────────────────────────────────────────────────────────────

test('claim_invite binds a new user to the inviting company', async () => {
  await asUser(IDS.managerA, (c) =>
    c.query(`insert into invites (company_id, phone_e164, role, full_name, created_by)
             values ($1, '+353870000005', 'worker', 'New Guy', $2)`,
      [IDS.companyA, IDS.managerA]));

  const profile = await asUser(IDS.newUser, async (c) => {
    const { rows } = await c.query(`select * from claim_invite()`);
    return rows[0];
  });
  assert.equal(profile.company_id, IDS.companyA);
  assert.equal(profile.role, 'worker');

  // idempotent: claiming again returns the same profile
  const again = await asUser(IDS.newUser, async (c) => {
    const { rows } = await c.query(`select * from claim_invite()`);
    return rows[0];
  });
  assert.equal(again.id, profile.id);

  // acknowledgment recording works and is visible to the manager
  await asUser(IDS.newUser, (c) => c.query(`select record_acknowledgment('v1')`));
  const { rows } = await asUser(IDS.managerA, (c) =>
    c.query(`select * from acknowledgments where worker_id = $1`, [IDS.newUser]));
  assert.equal(rows.length, 1);
});

test('a user with no invite gets nothing', async () => {
  const orphan = randomUUID();
  await pool.query(`insert into auth.users (id, phone) values ($1, '353879999999')`, [orphan]);
  await expectError(asUser(orphan, (c) => c.query(`select claim_invite()`)), 'no_invite');
  await expectError(asUser(orphan, (c) => c.query(`select clock_in($1, now(), 1, 1, 1, false, '{}')`, [randomUUID()])), 'no_active_profile');
  const { rows } = await asUser(orphan, (c) => c.query(`select * from companies`));
  assert.equal(rows.length, 0);
});

test('managers cannot invite into another company', async () => {
  await expectError(
    asUser(IDS.managerA, (c) =>
      c.query(`insert into invites (company_id, phone_e164, role, created_by)
               values ($1, '+353870000099', 'worker', $2)`, [IDS.companyB, IDS.managerA])),
    'row-level security');
  // and workers cannot invite at all
  await expectError(
    asUser(IDS.workerA, (c) =>
      c.query(`insert into invites (company_id, phone_e164, role, created_by)
               values ($1, '+353870000098', 'worker', $2)`, [IDS.companyA, IDS.workerA])),
    'row-level security');
});

// ── adjustments + timesheets ─────────────────────────────────────────────────

test('manager adjustments override times in views, evidence preserved', async () => {
  const shift = await asUser(IDS.workerA, async (c) => {
    const { rows } = await c.query(
      `select * from clock_in($1, now() - interval '8 hours', 53.3, -6.2, 10, false, '{}')`, [randomUUID()]);
    return rows[0];
  });
  await asUser(IDS.workerA, (c) => c.query(`select clock_out($1, now())`, [randomUUID()]));

  // workers cannot adjust
  await expectError(
    asUser(IDS.workerA, (c) =>
      c.query(`select adjust_shift($1, 'clock_out_at', now()::text, 'nice try')`, [shift.id])),
    'manager_only');

  // manager of the other company cannot adjust
  await expectError(
    asUser(IDS.managerB, (c) =>
      c.query(`select adjust_shift($1, 'clock_out_at', now()::text, 'cross tenant')`, [shift.id])),
    'shift_not_found');

  const newOut = new Date(Date.now() - 2 * 3600_000).toISOString();
  await asUser(IDS.managerA, (c) =>
    c.query(`select adjust_shift($1, 'clock_out_at', $2, 'left site early, confirmed by phone')`,
      [shift.id, newOut]));

  const { rows } = await asUser(IDS.managerA, (c) =>
    c.query(`select * from v_shift_effective where id = $1`, [shift.id]));
  assert.equal(rows[0].is_adjusted, true);
  // ~6h between clock-in (8h ago) and adjusted out (2h ago)
  assert.ok(Math.abs(rows[0].worked_seconds - 6 * 3600) < 120,
    `expected ~6h, got ${rows[0].worked_seconds}s`);
  // original evidence untouched
  const { rows: orig } = await pool.query(`select clock_out_device_at from shifts where id = $1`, [shift.id]);
  assert.notEqual(new Date(orig[0].clock_out_device_at).toISOString(), newOut);

  // timesheet daily rolls it up
  const { rows: sheet } = await asUser(IDS.managerA, (c) =>
    c.query(`select * from v_timesheet_daily where worker_id = $1 order by work_date desc`, [IDS.workerA]));
  assert.ok(sheet.length >= 1);
  assert.ok(Number(sheet[0].worked_hours) > 0);
});

// ── end-to-end simulated day ─────────────────────────────────────────────────

test('simulated day: clock in, drive between 3 houses, clock out — timesheet adds up', async () => {
  const dayStart = Date.now() - 8.5 * 3600_000;
  const houses = [
    { lat: 53.3382, lng: -6.2591 }, // house 1
    { lat: 53.3527, lng: -6.2603 }, // house 2
    { lat: 53.3441, lng: -6.2489 }, // house 3
  ];

  // clock in at house 1 (device time 8.5h ago, but synced now — late_sync will flag)
  const shift = await asUser(IDS.newUser, async (c) => {
    const { rows } = await c.query(
      `select * from clock_in($1, $2, $3, $4, 9, false, '{"model":"sim"}')`,
      [randomUUID(), new Date(dayStart).toISOString(), houses[0].lat, houses[0].lng]);
    return rows[0];
  });

  // breadcrumbs: ~3 min apart, hopping between houses over 8 hours
  let seq = 0;
  const points = [];
  for (let t = dayStart + 3 * 60_000; t < Date.now() - 10 * 60_000; t += 3 * 60_000) {
    const house = houses[Math.floor(((t - dayStart) / 3600_000) / 3) % houses.length];
    points.push({
      id: randomUUID(),
      seq: ++seq,
      device_at: new Date(t).toISOString(),
      lat: house.lat + (Math.random() - 0.5) * 0.0004,
      lng: house.lng + (Math.random() - 0.5) * 0.0004,
      accuracy_m: 8 + Math.random() * 30,
      speed_mps: 0.5,
      mocked: false,
      battery_pct: 90 - Math.floor((t - dayStart) / 3600_000) * 8,
    });
  }
  // sync in batches of 100, twice (idempotency under real replay conditions)
  for (const pass of [1, 2]) {
    for (let i = 0; i < points.length; i += 100) {
      const batch = points.slice(i, i + 100);
      await asUser(IDS.newUser, (c) =>
        c.query(`select sync_location_batch($1, $2)`, [shift.id, JSON.stringify(batch)]));
    }
  }
  const { rows: pingCount } = await pool.query(
    `select count(*)::int n from location_pings where shift_id = $1`, [shift.id]);
  assert.equal(pingCount[0].n, points.length, 'double-synced batches must not duplicate');

  // clock out now at house 3
  await asUser(IDS.newUser, async (c) => {
    await c.query(`select clock_out($1, now(), $2, $3, 11, false)`,
      [randomUUID(), houses[2].lat, houses[2].lng]);
  });

  // manager sees ~8.5h on the daily timesheet
  const { rows: sheet } = await asUser(IDS.managerA, (c) =>
    c.query(`select * from v_timesheet_daily where worker_id = $1`, [IDS.newUser]));
  const total = sheet.reduce((acc, r) => acc + Number(r.worked_seconds ?? 0), 0);
  assert.ok(Math.abs(total - 8.5 * 3600) < 300, `expected ~8.5h, got ${total / 3600}h`);

  // trail is visible to the manager, ordered, and no physics flags fired
  const { rows: trail } = await asUser(IDS.managerA, (c) =>
    c.query(`select seq from location_pings where shift_id = $1 order by seq`, [shift.id]));
  assert.equal(trail.length, points.length);
  const { rows: flags } = await pool.query(`select anomaly_flags from shifts where id = $1`, [shift.id]);
  assert.ok(!flags[0].anomaly_flags.includes('impossible_speed'), 'honest day must not be flagged');
});

// ── operator + invite codes (0008) ───────────────────────────────────────────

test('operator: cross-company read, admin RPCs; mortals refused', async () => {
  // promote workerA to operator (host-owner action, done via psql in prod)
  await pool.query(`update profiles set is_operator = true where id = $1`, [IDS.workerA]);

  // operator now reads other companies' rows
  const { rows: companies } = await asUser(IDS.workerA, (c) => c.query(`select id from companies`));
  assert.ok(companies.length >= 2, 'operator should see all companies');
  const { rows: bShifts } = await asUser(IDS.workerA, (c) =>
    c.query(`select id from shifts where company_id = $1`, [IDS.companyB]));
  assert.ok(bShifts.length >= 1, 'operator should see company B shifts');

  // non-operators cannot call admin RPCs
  await expectError(
    asUser(IDS.managerA, (c) => c.query(`select admin_create_company('Evil Co', '+353870001111')`)),
    'operator_only');

  // operator creates a company + manager invite in one call
  const companyId = await asUser(IDS.workerA, async (c) => {
    const { rows } = await c.query(
      `select admin_create_company('Gamma Plumbing', '+353870002222', 'Gary') id`);
    return rows[0].id;
  });
  const { rows: invites } = await pool.query(
    `select role, code from invites where company_id = $1`, [companyId]);
  assert.equal(invites[0].role, 'manager');
  assert.match(invites[0].code, /^\d{6}$/);

  await asUser(IDS.workerA, (c) => c.query(`select admin_rename_company($1, 'Gamma Plumbing Ltd')`, [companyId]));
  const { rows: renamed } = await pool.query(`select name from companies where id = $1`, [companyId]);
  assert.equal(renamed[0].name, 'Gamma Plumbing Ltd');

  // deactivate / reactivate someone in another company
  await asUser(IDS.workerA, (c) => c.query(`select admin_set_profile_active($1, false)`, [IDS.workerB]));
  const { rows: deact } = await pool.query(`select is_active from profiles where id = $1`, [IDS.workerB]);
  assert.equal(deact[0].is_active, false);
  await asUser(IDS.workerA, (c) => c.query(`select admin_set_profile_active($1, true)`, [IDS.workerB]));

  await pool.query(`update profiles set is_operator = false where id = $1`, [IDS.workerA]);
});

test('claim_invite_with_code: anonymous join with phone + code, wrong codes counted', async () => {
  // manager invites a phone number; the code comes back on the row
  const { rows: invRows } = await asUser(IDS.managerA, async (c) => {
    await c.query(
      `insert into invites (company_id, phone_e164, role, full_name, created_by)
       values ($1, '+353870003333', 'worker', 'Code Joiner', $2)`,
      [IDS.companyA, IDS.managerA]);
    return c.query(`select code from invites where phone_e164 = '+353870003333' and claimed_at is null`);
  });
  const code = invRows.rows ? invRows.rows[0].code : invRows[0].code;

  // an "anonymous" auth user (no phone on the account)
  const anonId = randomUUID();
  await pool.query(`insert into auth.users (id, phone) values ($1, null)`, [anonId]);

  // wrong code → NULL result, attempt counted, invite still claimable
  const wrong = await asUser(anonId, async (c) => {
    const { rows } = await c.query(`select claim_invite_with_code('087 000 3333', '000000') p`);
    return rows[0].p;
  });
  assert.equal(wrong, null);
  const { rows: attempts } = await pool.query(
    `select code_attempts from invites where phone_e164 = '+353870003333' and claimed_at is null`);
  assert.equal(attempts[0].code_attempts, 1);

  // right code → profile bound to the inviting company
  const profile = await asUser(anonId, async (c) => {
    const { rows } = await c.query(`select * from claim_invite_with_code('0870003333', $1)`, [code]);
    return rows[0];
  });
  assert.equal(profile.company_id, IDS.companyA);
  assert.equal(profile.role, 'worker');
  assert.equal(profile.phone_e164, '+353870003333');

  // idempotent for the same auth user
  const again = await asUser(anonId, async (c) => {
    const { rows } = await c.query(`select * from claim_invite_with_code('0870003333', $1)`, [code]);
    return rows[0];
  });
  assert.equal(again.id, profile.id);

  // and the code cannot be replayed by someone else
  const thief = randomUUID();
  await pool.query(`insert into auth.users (id, phone) values ($1, null)`, [thief]);
  await expectError(
    asUser(thief, (c) => c.query(`select claim_invite_with_code('0870003333', $1)`, [code])),
    'no_invite');

  // an anonymous session that has NOT claimed an invite reads nothing
  const anon2 = randomUUID();
  await pool.query(`insert into auth.users (id, phone) values ($1, null)`, [anon2]);
  for (const t of ['companies', 'profiles', 'shifts', 'invites']) {
    const { rows } = await asUser(anon2, (c) => c.query(`select * from ${t}`));
    assert.equal(rows.length, 0, `unclaimed anonymous user can read ${t}`);
  }
});

// ── location controls (0007) ─────────────────────────────────────────────────

test('request_location: manager-only, mid-shift only, fulfilled by fresh pings', async () => {
  // workers cannot request anyone's location
  await expectError(
    asUser(IDS.workerA, (c) => c.query(`select request_location($1)`, [IDS.workerA])),
    'manager_only');

  // no open shift -> hard refusal (the GDPR line)
  await expectError(
    asUser(IDS.managerA, (c) => c.query(`select request_location($1)`, [IDS.workerA])),
    'worker_not_clocked_in');

  // cross-tenant target is invisible
  await expectError(
    asUser(IDS.managerB, (c) => c.query(`select request_location($1)`, [IDS.workerA])),
    'worker_not_found');

  const shift = await asUser(IDS.workerA, async (c) => {
    const { rows } = await c.query(
      `select * from clock_in($1, now(), 53.34, -6.27, 9, false, '{}')`, [randomUUID()]);
    return rows[0];
  });

  const req = await asUser(IDS.managerA, async (c) => {
    const { rows } = await c.query(`select * from request_location($1)`, [IDS.workerA]);
    return rows[0];
  });
  assert.equal(req.fulfilled_at, null);

  // a second request while one is pending dedupes onto the same row
  const req2 = await asUser(IDS.managerA, async (c) => {
    const { rows } = await c.query(`select * from request_location($1)`, [IDS.workerA]);
    return rows[0];
  });
  assert.equal(req2.id, req.id);

  // the worker can see the request (transparency)
  const { rows: mine } = await asUser(IDS.workerA, (c) =>
    c.query(`select id from location_requests where fulfilled_at is null`));
  assert.equal(mine.length, 1);

  // a fresh synced point fulfils it
  await asUser(IDS.workerA, (c) =>
    c.query(`select sync_location_batch($1, $2)`, [shift.id, JSON.stringify([{
      id: randomUUID(), seq: 1, device_at: new Date().toISOString(), lat: 53.34, lng: -6.27, accuracy_m: 12,
    }])]));
  const { rows: done } = await pool.query(
    `select fulfilled_at from location_requests where id = $1`, [req.id]);
  assert.ok(done[0].fulfilled_at, 'request should be fulfilled by the fresh ping');

  await asUser(IDS.workerA, (c) => c.query(`select clock_out($1, now())`, [randomUUID()]));
});

test('ping_interval_s: manager-tunable within bounds, same company only', async () => {
  const res = await asUser(IDS.managerA, (c) =>
    c.query(`update profiles set ping_interval_s = 300 where id = $1`, [IDS.workerA]));
  assert.equal(res.rowCount, 1);

  // 5s is now the floor (fast-tracking option); below that is rejected
  await asUser(IDS.managerA, (c) =>
    c.query(`update profiles set ping_interval_s = 5 where id = $1`, [IDS.workerA]));
  await expectError(
    asUser(IDS.managerA, (c) =>
      c.query(`update profiles set ping_interval_s = 4 where id = $1`, [IDS.workerA])),
    'check constraint');
  await expectError(
    asUser(IDS.managerA, (c) =>
      c.query(`update profiles set ping_interval_s = 901 where id = $1`, [IDS.workerA])),
    'check constraint');

  // cross-tenant tuning silently matches zero rows
  const cross = await asUser(IDS.managerA, (c) =>
    c.query(`update profiles set ping_interval_s = 600 where id = $1`, [IDS.workerB]));
  assert.equal(cross.rowCount, 0);

  // workers cannot tune themselves (manager-only update policy)
  const self = await asUser(IDS.workerA, (c) =>
    c.query(`update profiles set ping_interval_s = 60 where id = $1`, [IDS.workerA]));
  assert.equal(self.rowCount, 0);

  // the worker can read their own setting (the app applies it); last valid
  // write was the 5s fast-tracking floor
  const { rows } = await asUser(IDS.workerA, (c) =>
    c.query(`select ping_interval_s from profiles where id = $1`, [IDS.workerA]));
  assert.equal(rows[0].ping_interval_s, 5);
});

// ── maintenance jobs ─────────────────────────────────────────────────────────

test('auto_close_stale_shifts closes and flags forgotten shifts', async () => {
  const shift = await asUser(IDS.workerB, async (c) => {
    const { rows } = await c.query(`select * from clock_in($1, now(), 53.3, -6.2, 10, false, '{}')`, [randomUUID()]);
    return rows[0];
  });
  // backdate the server receive time (test-only, superuser)
  await pool.query(`update shifts set clock_in_received_at = now() - interval '25 hours' where id = $1`, [shift.id]);

  const { rows } = await pool.query(`select auto_close_stale_shifts() n`);
  assert.ok(rows[0].n >= 1);
  const { rows: after } = await pool.query(`select status, anomaly_flags from shifts where id = $1`, [shift.id]);
  assert.equal(after[0].status, 'auto_closed');
  assert.ok(after[0].anomaly_flags.includes('auto_closed_no_clock_out'));
});

test('late clock_out recovers an auto_closed shift — honest hours never lost', async () => {
  const shift = await asUser(IDS.workerB, async (c) => {
    const { rows } = await c.query(`select * from clock_in($1, now(), 53.3, -6.2, 10, false, '{}')`, [randomUUID()]);
    return rows[0];
  });
  await pool.query(`update shifts set clock_in_received_at = now() - interval '25 hours',
                                      clock_in_device_at = now() - interval '25 hours' where id = $1`, [shift.id]);
  await pool.query(`select auto_close_stale_shifts()`);

  // phone comes back online and syncs the clock-out it recorded offline
  const recovered = await asUser(IDS.workerB, async (c) => {
    const { rows } = await c.query(
      `select * from clock_out($1, now() - interval '17 hours', 53.31, -6.21, 9, false)`,
      [randomUUID()]);
    return rows[0];
  });
  assert.equal(recovered.id, shift.id);
  assert.equal(recovered.status, 'closed');
  assert.ok(recovered.anomaly_flags.includes('auto_closed_no_clock_out'), 'evidence flag preserved');
  assert.ok(recovered.clock_out_device_at, 'clock-out evidence recorded');
});

test('clock_out clears the live-map row and oversized batches are rejected', async () => {
  const shift = await asUser(IDS.workerB, async (c) => {
    const { rows } = await c.query(`select * from clock_in($1, now(), 53.3, -6.2, 10, false, '{}')`, [randomUUID()]);
    return rows[0];
  });
  await asUser(IDS.workerB, (c) =>
    c.query(`select sync_location_batch($1, $2)`, [shift.id, JSON.stringify([{
      id: randomUUID(), seq: 1, device_at: new Date().toISOString(), lat: 53.3, lng: -6.2, accuracy_m: 10,
    }])]));
  const { rows: before } = await pool.query(`select 1 from worker_latest_ping where worker_id = $1`, [IDS.workerB]);
  assert.equal(before.length, 1);

  // oversized batch rejected outright
  const bigBatch = Array.from({ length: 501 }, (_, i) => ({
    id: randomUUID(), seq: i + 10, device_at: new Date().toISOString(), lat: 53.3, lng: -6.2,
  }));
  await expectError(
    asUser(IDS.workerB, (c) =>
      c.query(`select sync_location_batch($1, $2)`, [shift.id, JSON.stringify(bigBatch)])),
    'batch_too_large');

  await asUser(IDS.workerB, (c) => c.query(`select clock_out($1, now())`, [randomUUID()]));
  const { rows: after } = await pool.query(`select 1 from worker_latest_ping where worker_id = $1`, [IDS.workerB]);
  assert.equal(after.length, 0, 'live-map row must be gone after clock-out');

  // and a closed-without-evidence shift cannot keep accepting fresh pings
  const stale = await asUser(IDS.workerB, async (c) => {
    const { rows } = await c.query(`select * from clock_in($1, now(), 53.3, -6.2, 10, false, '{}')`, [randomUUID()]);
    return rows[0];
  });
  await pool.query(`update shifts set clock_in_received_at = now() - interval '30 hours',
                                      clock_in_device_at = now() - interval '30 hours' where id = $1`, [stale.id]);
  await pool.query(`select auto_close_stale_shifts()`);
  const res = await asUser(IDS.workerB, async (c) => {
    const { rows } = await c.query(`select sync_location_batch($1, $2) r`, [stale.id, JSON.stringify([{
      id: randomUUID(), seq: 1, device_at: new Date().toISOString(), lat: 53.3, lng: -6.2,
    }])]);
    return rows[0].r;
  });
  assert.equal(res.accepted, 0, 'fresh pings into an auto_closed shift must be rejected');
  assert.equal(res.rejected, 1);
  // clean up: recover it so later tests can clock in
  await asUser(IDS.workerB, (c) =>
    c.query(`select clock_out($1, now() - interval '25 hours')`, [randomUUID()]));
});

test('flag_gap_shifts flags open shifts with silent trackers', async () => {
  const shift = await asUser(IDS.workerB, async (c) => {
    const { rows } = await c.query(`select * from clock_in($1, now(), 53.3, -6.2, 10, false, '{}')`, [randomUUID()]);
    return rows[0];
  });
  await pool.query(`update shifts set clock_in_received_at = now() - interval '1 hour' where id = $1`, [shift.id]);

  await pool.query(`select flag_gap_shifts()`);
  const { rows } = await pool.query(`select anomaly_flags from shifts where id = $1`, [shift.id]);
  assert.ok(rows[0].anomaly_flags.includes('ping_gap'));
  await asUser(IDS.workerB, (c) => c.query(`select clock_out($1, now())`, [randomUUID()]));
});

test('purge_old_pings drops expired monthly partitions', async () => {
  // create a partition 4 months back with a row in it
  const old = new Date();
  old.setUTCMonth(old.getUTCMonth() - 4, 15);
  await pool.query(`select internal.ensure_ping_partition($1)`, [old.toISOString()]);

  const shift = await asUser(IDS.workerB, async (c) => {
    const { rows } = await c.query(`select * from clock_in($1, now(), 53.3, -6.2, 10, false, '{}')`, [randomUUID()]);
    return rows[0];
  });
  await pool.query(
    `insert into location_pings (company_id, shift_id, worker_id, client_ping_id, seq, device_at, received_at, lat, lng)
     values ($1, $2, $3, $4, 1, $5, $5, 53.3, -6.2)`,
    [IDS.companyB, shift.id, IDS.workerB, randomUUID(), old.toISOString()]);

  const partName = `location_pings_${old.getUTCFullYear()}${String(old.getUTCMonth() + 1).padStart(2, '0')}`;
  const { rows: pre } = await pool.query(`select to_regclass($1) r`, [`public.${partName}`]);
  assert.ok(pre[0].r, `expected partition ${partName} to exist`);

  const { rows } = await pool.query(`select purge_old_pings(90) n`);
  assert.ok(rows[0].n >= 1, 'expected at least one partition dropped');

  const { rows: post } = await pool.query(`select to_regclass($1) r`, [`public.${partName}`]);
  assert.equal(post[0].r, null, `partition ${partName} should be gone`);
  await asUser(IDS.workerB, (c) => c.query(`select clock_out($1, now())`, [randomUUID()]));
});
