#!/usr/bin/env node
// generate-keys.mjs — mint all secrets for the TimeTable Supabase stack.
//
// Zero dependencies (node:crypto only). Node 16+.
//
//   node generate-keys.mjs
//
// No Node on the Unraid host? Run it in a throwaway container from this
// directory:
//
//   docker run --rm -v "$PWD":/w -w /w node:22-alpine node generate-keys.mjs
//
// Prints a block ready to paste into .env. Nothing is written to disk.
//
// ANON_KEY / SERVICE_ROLE_KEY are HS256 JWTs signed with JWT_SECRET, with
// the exact payload shape the official self-hosting tooling uses
// (docker/utils/generate-keys.sh in supabase/supabase):
//   { role: "anon" | "service_role", iss: "supabase", iat, exp }
// NOTE: the official script uses a 5-year expiry; we use 10 years so field
// devices don't hit a surprise key expiry mid-life.

import { randomBytes, createHmac } from "node:crypto";

const b64url = (input) =>
  Buffer.from(input).toString("base64url");

function signHS256(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

// --- secrets ---------------------------------------------------------------

// base64url => safe charset for .env files (no '+', '/', '=', spaces)
const jwtSecret = randomBytes(32).toString("base64url"); // 43 chars (min 32 required)

const iat = Math.floor(Date.now() / 1000);
const exp = iat + 10 * 365 * 24 * 60 * 60; // ~10 years

const anonKey = signHS256({ role: "anon", iss: "supabase", iat, exp }, jwtSecret);
const serviceRoleKey = signHS256({ role: "service_role", iss: "supabase", iat, exp }, jwtSecret);

const postgresPassword = randomBytes(16).toString("hex");      // 32 chars
const dashboardPassword = randomBytes(16).toString("hex");     // 32 chars
const secretKeyBase = randomBytes(48).toString("base64url");   // 64 chars (min 64 required)
const realtimeDbEncKey = randomBytes(8).toString("hex");       // EXACTLY 16 chars required
const pgMetaCryptoKey = randomBytes(24).toString("base64url"); // 32 chars (min 32 required)

// --- self-check: verify the tokens against the secret before printing ------

const verify = (token, role) => {
  const [h, p, s] = token.split(".");
  const expected = createHmac("sha256", jwtSecret).update(`${h}.${p}`).digest("base64url");
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  if (s !== expected || payload.role !== role || payload.iss !== "supabase") {
    throw new Error(`self-check failed for ${role} key`);
  }
};
verify(anonKey, "anon");
verify(serviceRoleKey, "service_role");

// --- output ----------------------------------------------------------------

console.log(`# Paste into .env — generated ${new Date().toISOString()}
# (keys expire ${new Date(exp * 1000).toISOString().slice(0, 10)})

POSTGRES_PASSWORD=${postgresPassword}

JWT_SECRET=${jwtSecret}
ANON_KEY=${anonKey}
SERVICE_ROLE_KEY=${serviceRoleKey}

DASHBOARD_PASSWORD=${dashboardPassword}

SECRET_KEY_BASE=${secretKeyBase}
REALTIME_DB_ENC_KEY=${realtimeDbEncKey}
PG_META_CRYPTO_KEY=${pgMetaCryptoKey}
`);

console.error(
  "Reminder: POSTGRES_PASSWORD and JWT_SECRET are baked into the database on FIRST boot.\n" +
  "Set them before 'docker compose up'; changing them later requires a db reset."
);
