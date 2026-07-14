// Manager sign-in: phone OTP, then profile check. Workers who sign in here are
// pointed at the mobile app — the dashboard is a manager tool.
import { useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Profile } from '../lib/types';

type Phase = 'loading' | 'phone' | 'otp' | 'checking' | 'notManager' | 'noInvite' | 'ready';

export function LoginGate({ children }: { children: (profile: Profile) => ReactNode }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
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
      if (err.message.includes('no_invite') || err.message.includes('invite_expired')) {
        setPhase('noInvite');
      } else {
        setError(err.message);
        setPhase('phone');
      }
      return;
    }
    const p = (Array.isArray(data) ? data[0] : data) as Profile;
    if (p.role !== 'manager') {
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

  if (phase === 'loading' || phase === 'checking') {
    return <div className="center-page">Loading…</div>;
  }

  if (phase === 'ready' && profile) return <>{children(profile)}</>;

  return (
    <div className="center-page">
      <div className="auth-card">
        <h1>TimeTable</h1>
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
