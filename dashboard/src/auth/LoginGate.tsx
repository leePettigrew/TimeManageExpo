// Manager sign-in: phone OTP, then profile check. Workers who sign in here are
// pointed at the mobile app — the dashboard is a manager tool.
import { useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Profile } from '../lib/types';

type Phase = 'loading' | 'phone' | 'otp' | 'invite' | 'checking' | 'notManager' | 'noInvite' | 'ready';

export function LoginGate({ children }: { children: (profile: Profile) => ReactNode }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  const evaluate = async (session: Session | null) => {
    if (!session) {
      setPhase('phone');
      return;
    }
    setPhase('checking');
    const { data, error: err } = await supabase.rpc('claim_invite');
    if (err) {
      if (
        err.message.includes('no_invite') ||
        err.message.includes('invite_expired') ||
        err.message.includes('no_phone_on_account')
      ) {
        setPhase('noInvite');
      } else {
        setError(err.message);
        setPhase('phone');
      }
      return;
    }
    const p = (Array.isArray(data) ? data[0] : data) as Profile;
    if (p.role !== 'manager' && !p.is_operator) {
      setPhase('notManager');
      return;
    }
    setProfile(p);
    setPhase('ready');
  };

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => evaluate(data.session));
  }, []);

  const normalise = (input: string): string | null => {
    const digits = input.replace(/[^\d+]/g, '');
    if (/^\+353\d{9}$/.test(digits)) return digits;
    if (/^353\d{9}$/.test(digits)) return `+${digits}`;
    if (/^08\d{8}$/.test(digits)) return `+353${digits.slice(1)}`;
    return null;
  };

  const sendCode = async () => {
    const p = normalise(phone);
    if (!p) {
      setError('Enter an Irish mobile, e.g. 087 123 4567');
      return;
    }
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({ phone: p });
    if (err) {
      setError(err.message);
      return;
    }
    setPhone(p);
    setPhase('otp');
  };

  const verify = async () => {
    setError(null);
    const { data, error: err } = await supabase.auth.verifyOtp({
      phone,
      token: code.trim(),
      type: 'sms',
    });
    if (err) {
      setError('Wrong or expired code');
      return;
    }
    await evaluate(data.session);
  };

  // SMS-free path: anonymous session + invite code from the operator/manager
  const joinWithCode = async () => {
    const p = normalise(phone);
    if (!p) {
      setError('Enter an Irish mobile, e.g. 087 123 4567');
      return;
    }
    if (inviteCode.trim().length !== 6) {
      setError('Enter the 6-digit invite code');
      return;
    }
    setError(null);
    let { data: sess } = await supabase.auth.getSession();
    if (!sess.session) {
      const { error: anonErr } = await supabase.auth.signInAnonymously();
      if (anonErr) {
        setError(anonErr.message);
        return;
      }
      sess = (await supabase.auth.getSession()).data;
    }
    const { data, error: err } = await supabase.rpc('claim_invite_with_code', {
      p_phone: p,
      p_code: inviteCode.trim(),
    });
    if (err) {
      if (err.message.includes('no_invite')) setError('No invite found for that number — check with the operator.');
      else if (err.message.includes('invite_expired')) setError('That invite has expired — ask for a new one.');
      else setError(err.message);
      return;
    }
    const prof = (Array.isArray(data) ? data[0] : data) as Profile | null;
    if (!prof) {
      setError("That code isn't right — check it and try again.");
      return;
    }
    await evaluate(sess.session);
  };

  if (phase === 'loading' || phase === 'checking') {
    return <div className="center-page">Loading…</div>;
  }

  if (phase === 'ready' && profile) return <>{children(profile)}</>;

  return (
    <div className="center-page">
      <div className="auth-card">
        <h1>
          <svg className="auth-mark" viewBox="0 0 64 64">
            <rect width="64" height="64" rx="14" fill="#0B1220" />
            <circle cx="32" cy="32" r="20" fill="none" stroke="#4ADE80" strokeWidth="4.5" />
            <polyline
              points="23,33 29,39 42,25"
              fill="none"
              stroke="#F2F6FC"
              strokeWidth="5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          TimeTable
        </h1>
        <p className="dim">Manager dashboard</p>

        {phase === 'phone' && (
          <>
            <label>Mobile number</label>
            <input
              autoFocus
              placeholder="087 123 4567"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void sendCode()}
            />
            <button onClick={() => void sendCode()}>Text me a code</button>
            <button className="ghost" onClick={() => setPhase('invite')}>
              I have an invite code
            </button>
          </>
        )}

        {phase === 'invite' && (
          <>
            <label>Mobile number</label>
            <input
              autoFocus
              placeholder="087 123 4567"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <label>Invite code</label>
            <input
              placeholder="6-digit code"
              maxLength={6}
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void joinWithCode()}
            />
            <button onClick={() => void joinWithCode()}>Join</button>
            <button className="ghost" onClick={() => setPhase('phone')}>
              Back
            </button>
          </>
        )}

        {phase === 'otp' && (
          <>
            <label>Code sent to {phone}</label>
            <input
              autoFocus
              placeholder="123456"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void verify()}
            />
            <button onClick={() => void verify()}>Verify</button>
            <button className="ghost" onClick={() => setPhase('phone')}>
              Different number
            </button>
          </>
        )}

        {phase === 'notManager' && (
          <>
            <p>This dashboard is for managers. Workers clock in with the phone app.</p>
            <button className="ghost" onClick={() => void supabase.auth.signOut().then(() => setPhase('phone'))}>
              Sign out
            </button>
          </>
        )}

        {phase === 'noInvite' && (
          <>
            <p>
              This number isn&apos;t registered as a company yet. Company accounts are created by
              the operator — get in touch to set one up.
            </p>
            <button className="ghost" onClick={() => void supabase.auth.signOut().then(() => setPhase('phone'))}>
              Sign out
            </button>
          </>
        )}

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
