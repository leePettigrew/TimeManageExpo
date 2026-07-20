// Test bootstrap: embedded Postgres + Supabase-compat shim + migrations + seed.
// The shim recreates just enough of the Supabase runtime (auth schema,
// auth.uid(), auth.users) for the migrations to run on vanilla Postgres.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, '..', 'migrations');
const DATA_DIR = path.join(here, '.pgdata');
const PORT = 55437;

export const IDS = {
  companyA: '11111111-1111-4111-8111-111111111111',
  companyB: '22222222-2222-4222-8222-222222222222',
  managerA: 'aaaaaaa1-0000-4000-8000-00000000000a',
  workerA: 'aaaaaaa2-0000-4000-8000-00000000000b',
  managerB: 'bbbbbbb1-0000-4000-8000-00000000000a',
  workerB: 'bbbbbbb2-0000-4000-8000-00000000000b',
  newUser: 'ccccccc1-0000-4000-8000-00000000000c',
};

const SHIM_SQL = `
  create schema if not exists auth;
  create table if not exists auth.users (
    id uuid primary key,
    phone text,
    email text,
    created_at timestamptz not null default now()
  );
  create or replace function auth.uid() returns uuid
  language sql stable
  as $$
    select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
  $$;
`;

const SEED_SQL = `
  insert into auth.users (id, phone) values
    ('${IDS.managerA}', '353870000001'),
    ('${IDS.workerA}',  '353870000002'),
    ('${IDS.managerB}', '353870000003'),
    ('${IDS.workerB}',  '353870000004'),
    ('${IDS.newUser}',  '353870000005');

  insert into companies (id, name) values
    ('${IDS.companyA}', 'Alpha Builders'),
    ('${IDS.companyB}', 'Beta Roofing');

  insert into profiles (id, company_id, role, full_name, phone_e164) values
    ('${IDS.managerA}', '${IDS.companyA}', 'manager', 'Manager A', '+353870000001'),
    ('${IDS.workerA}',  '${IDS.companyA}', 'worker',  'Worker A',  '+353870000002'),
    ('${IDS.managerB}', '${IDS.companyB}', 'manager', 'Manager B', '+353870000003'),
    ('${IDS.workerB}',  '${IDS.companyB}', 'worker',  'Worker B',  '+353870000004');
`;

let embedded;
let pool;

export async function startDb() {
  await rm(DATA_DIR, { recursive: true, force: true });
  embedded = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
    // match production (Supabase is always UTF-8); Windows would default to WIN1252
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await embedded.initialise();
  await embedded.start();
  await embedded.createDatabase('app');

  pool = new pg.Pool({
    host: 'localhost',
    port: PORT,
    user: 'postgres',
    password: 'postgres',
    database: 'app',
    max: 4,
  });

  await pool.query(SHIM_SQL);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, f), 'utf8');
    try {
      await pool.query(sql);
    } catch (e) {
      throw new Error(`migration ${f} failed: ${e.message}`);
    }
  }

  await pool.query(SEED_SQL);
  return pool;
}

export async function stopDb() {
  await pool?.end();
  await embedded?.stop();
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
}

// Run fn as an authenticated user inside one transaction (its own RLS context).
// Each call is a fresh transaction, so an expected failure never poisons the
// next statement.
export async function asUser(uid, fn, { role = 'authenticated' } = {}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: uid, role }),
    ]);
    await client.query(`set local role ${role}`);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export function sql(client) {
  return (text, params) => client.query(text, params);
}

// expect an error whose message contains `needle`
export async function expectError(promise, needle) {
  try {
    await promise;
  } catch (e) {
    if (String(e.message).includes(needle)) return e;
    throw new Error(`expected error containing "${needle}", got: ${e.message}`);
  }
  throw new Error(`expected error containing "${needle}", but call succeeded`);
}
