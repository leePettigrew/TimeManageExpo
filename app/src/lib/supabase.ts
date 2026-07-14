import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config';

// AsyncStorage is the Supabase-documented session store for Expo. Long-lived
// refresh tokens keep workers signed in for months — SMS OTP only at
// install/new device (field reality: no signal, no OTP, must still clock in).
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

/** Postgres RAISE messages come through as error.message; normalise them. */
export function rpcErrorCode(error: unknown): string {
  const msg =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error);
  for (const code of [
    'shift_already_open',
    'no_open_shift',
    'no_invite',
    'invite_expired',
    'no_active_profile',
    'no_phone_on_account',
    'device_timestamp_in_future',
    'device_timestamp_too_old',
    'shift_not_found',
    'manager_only',
  ]) {
    if (msg.includes(code)) return code;
  }
  return 'unknown';
}

/** True when the failure is connectivity, not a server-side rejection. */
export function isNetworkError(error: unknown): boolean {
  const msg =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error);
  return /network|fetch failed|failed to fetch|timeout|abort/i.test(msg);
}
