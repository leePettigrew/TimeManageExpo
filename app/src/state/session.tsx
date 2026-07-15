// Session state machine:
//   loading → signedOut → (OTP) → needsInvite | needsAck | ready
// Profile + acknowledgment are cached locally so a worker with no signal in
// the morning still lands on the clock screen.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, rpcErrorCode, isNetworkError } from '../lib/supabase';
import { NOTICE_VERSION } from '../lib/config';
import { kvGet, kvSet, resetOutbox } from '../lib/outbox';
import { stopBreadcrumbs } from '../lib/breadcrumbs';
import { ensureNotificationSetup, cancelClockOutReminder } from '../lib/reminders';

export interface Profile {
  id: string;
  company_id: string;
  role: 'manager' | 'worker';
  full_name: string;
  phone_e164: string;
}

export type SessionPhase =
  | 'loading'
  | 'signedOut'
  | 'needsInvite'
  | 'needsAck'
  | 'ready'
  | 'error';

interface SessionContextValue {
  phase: SessionPhase;
  session: Session | null;
  profile: Profile | null;
  errorMessage: string | null;
  acknowledge: () => Promise<void>;
  claimWithCode: (phone: string, code: string) => Promise<void>;
  retry: () => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const KV_PROFILE = 'profile';
const KV_ACK_VERSION = 'ack_version';

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<SessionPhase>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const evaluate = useCallback(async (s: Session | null) => {
    if (!s) {
      // remote session loss (deactivation, token revocation) mid-shift must
      // stop the tracker too — never record location for a signed-out user
      await stopBreadcrumbs();
      setProfile(null);
      setPhase('signedOut');
      return;
    }

    // cached profile → instant start, even offline
    const cached = await kvGet(KV_PROFILE);
    if (cached) {
      const p = JSON.parse(cached) as Profile;
      setProfile(p);
      const ack = await kvGet(KV_ACK_VERSION);
      setPhase(ack === NOTICE_VERSION ? 'ready' : 'needsAck');
      return;
    }

    // first run on this device: bind to the inviting company
    const { data, error } = await supabase.rpc('claim_invite');
    if (error) {
      const code = rpcErrorCode(error);
      if (code === 'no_invite' || code === 'invite_expired') {
        setPhase('needsInvite');
      } else if (isNetworkError(error)) {
        setErrorMessage('No connection — connect to the internet once to finish setup.');
        setPhase('error');
      } else {
        setErrorMessage(error.message);
        setPhase('error');
      }
      return;
    }
    const p = (Array.isArray(data) ? data[0] : data) as Profile;
    await kvSet(KV_PROFILE, JSON.stringify(p));
    setProfile(p);

    const { data: acks } = await supabase
      .from('acknowledgments')
      .select('notice_version')
      .eq('notice_version', NOTICE_VERSION)
      .limit(1);
    if (acks && acks.length > 0) {
      await kvSet(KV_ACK_VERSION, NOTICE_VERSION);
      setPhase('ready');
    } else {
      setPhase('needsAck');
    }
  }, []);

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      void evaluate(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      void evaluate(s);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [evaluate, nonce]);

  const acknowledge = useCallback(async () => {
    const { error } = await supabase.rpc('record_acknowledgment', {
      p_notice_version: NOTICE_VERSION,
    });
    if (error && !isNetworkError(error)) throw error;
    if (!error) await kvSet('ack_synced', NOTICE_VERSION);
    // on network failure the sync engine delivers it on the next flush —
    // the disclosure itself has been shown, which is what matters today
    await kvSet(KV_ACK_VERSION, NOTICE_VERSION);
    setPhase('ready');
  }, []);

  // SMS-free onboarding: anonymous sign-in + invite code. Throws a
  // human-readable message on failure so the screen can show it.
  const claimWithCode = useCallback(
    async (phone: string, code: string) => {
      let current = (await supabase.auth.getSession()).data.session;
      if (!current) {
        const { error } = await supabase.auth.signInAnonymously();
        if (error) throw new Error('No connection — get online to finish joining.');
        current = (await supabase.auth.getSession()).data.session;
      }
      const { data, error } = await supabase.rpc('claim_invite_with_code', {
        p_phone: phone,
        p_code: code,
      });
      if (error) {
        const c = rpcErrorCode(error);
        if (c === 'no_invite') throw new Error('No invite for that number — ask your boss to add you.');
        if (c === 'invite_expired') throw new Error('That invite has expired — ask for a new one.');
        if (isNetworkError(error)) throw new Error('No connection — try again when you have signal.');
        throw new Error("Something went wrong — check your number and code.");
      }
      const p = (Array.isArray(data) ? data[0] : data) as Profile | null;
      if (!p) throw new Error("That code isn't right — check it and try again.");
      await kvSet(KV_PROFILE, JSON.stringify(p));
      setProfile(p);
      setPhase('needsAck');
    },
    [],
  );

  const retry = useCallback(() => {
    setPhase('loading');
    setErrorMessage(null);
    setNonce((n) => n + 1);
  }, []);

  const signOut = useCallback(async () => {
    await stopBreadcrumbs();
    await cancelClockOutReminder();
    await supabase.auth.signOut();
    await resetOutbox();
    setProfile(null);
    setPhase('signedOut');
  }, []);

  // ask for notification permission once the worker is in (used for the
  // forgot-to-clock-out reminder)
  useEffect(() => {
    if (phase === 'ready') void ensureNotificationSetup();
  }, [phase]);

  const value = useMemo(
    () => ({ phase, session, profile, errorMessage, acknowledge, claimWithCode, retry, signOut }),
    [phase, session, profile, errorMessage, acknowledge, claimWithCode, retry, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
