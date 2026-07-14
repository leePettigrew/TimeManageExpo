// Public runtime config. EXPO_PUBLIC_* vars are inlined at build time from
// app/.env (see .env.example). The anon key is safe to ship — all authority
// lives in RLS + RPCs server-side.
export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

// Bump when the worker-facing privacy notice text changes; workers must
// re-acknowledge before tracking can start again.
export const NOTICE_VERSION = '2026-07-v1';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn(
    'Supabase config missing: set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in app/.env',
  );
}
