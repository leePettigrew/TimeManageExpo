// Billing client: talks to the self-hosted billing service (Stripe) with the
// manager's Supabase access token. The service verifies the token and does all
// Stripe work server-side — no secret keys in the browser.
import { supabase } from '../lib/supabase';

const BILLING_URL = (import.meta.env.VITE_BILLING_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export interface MyCompany {
  id: string;
  name: string;
  subscription_status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete';
  trial_ends_at: string;
  current_period_end: string | null;
  seats: number;
  has_customer: boolean;
  is_active: boolean;
  active_workers: number;
}

export async function fetchMyCompany(): Promise<MyCompany | null> {
  const { data, error } = await supabase.from('v_my_company').select('*').maybeSingle();
  if (error) throw error;
  return (data as MyCompany) ?? null;
}

async function post(path: string): Promise<{ url?: string; error?: string; [k: string]: unknown }> {
  if (!BILLING_URL) throw new Error('Billing is not configured (VITE_BILLING_URL).');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(`${BILLING_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Billing error (${res.status})`);
  return json;
}

/** Start a subscription → returns to Stripe Checkout. */
export async function startCheckout(): Promise<void> {
  const { url } = await post('/create-checkout');
  if (url) window.location.href = url;
}

/** Open the Stripe billing portal (manage/cancel/update card). */
export async function openPortal(): Promise<void> {
  const { url } = await post('/portal');
  if (url) window.location.href = url;
}

/** Push the current active-worker count to Stripe as the billed quantity. */
export async function syncSeats(): Promise<void> {
  await post('/sync-seats').catch(() => {
    /* best effort — not fatal in the UI */
  });
}

export function trialDaysLeft(c: MyCompany): number {
  return Math.max(0, Math.ceil((new Date(c.trial_ends_at).getTime() - Date.now()) / 86400_000));
}
