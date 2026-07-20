// Manager auth for the dashboard. Primary: email/password + Google. Secondary:
// phone-OTP + invite code (for managers onboarded via the operator/invite
// flow). New managers self-serve: sign up → create their company → 14-day
// trial. Also handles the password-recovery deep link.
import { useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Profile } from '../lib/types';

type Phase =
  | 'loading'
  | 'auth' // email/google
  | 'phone'
  | 'otp'
  | 'invite'
  | 'onboarding' // create company
  | 'recovery' // set new password
  | 'checking'
  | 'notManager'
  | 'ready';

export function LoginGate({ children }: { children: (profile: Profile) => ReactNode }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [fullName, setFullName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  const evaluate = async (session: Session | null) => {
    if (!session) {
      setPhase('auth');
      return;
    }
    setPhase('checking');
    // returning user → do they already have a profile? (claim_invite is
    // idempotent and returns the existing profile)
    const { data, error: err } = await supabase.rpc('claim_invite');
    if (err) {
      const m = err.message;
      if (m.includes('no_invite') || m.includes('no_phone_on_account') || m.includes('invite_expired')) {
        // brand-new manager, no company yet → self-serve onboarding
        setPhase('onboarding');
      } else {
        setError(m);
        setPhase('auth');
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
    supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        setPhase('recovery');
        return;
      }
      if (event === 'SIGNED_IN') void evaluate(session);
      if (event === 'SIGNED_OUT') setPhase('auth');
    });
    void supabase.auth.getSession().then(({ data }) => evaluate(data.session));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const signInGoogle = () =>
    wrap(async () => {
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      });
      if (err) throw err;
    });

  const signInEmail = () =>
    wrap(async () => {
      const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
      if (err) throw err;
      await evaluate(data.session);
    });

  const signUpEmail = () =>
    wrap(async () => {
      if (password.length < 8) throw new Error('Password must be at least 8 characters.');
      const { data, error: err } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.origin },
      });
      if (err) throw err;
      if (data.session) await evaluate(data.session);
      else setInfo('Check your email to confirm your account, then sign in.');
    });

  const resetPassword = () =>
    wrap(async () => {
      if (!email) throw new Error('Enter your email first.');
      const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (err) throw err;
      setInfo('If that email has an account, a reset link is on its way.');
    });

  const setNewPassword = () =>
    wrap(async () => {
      if (password.length < 8) throw new Error('Password must be at least 8 characters.');
      const { error: err } = await supabase.auth.updateUser({ password });
      if (err) throw err;
      const { data } = await supabase.auth.getSession();
      await evaluate(data.session);
    });

  const createCompany = () =>
    wrap(async () => {
      if (companyName.trim().length < 2) throw new Error('Enter your company name.');
      const { data, error: err } = await supabase.rpc('create_company_and_join', {
        p_company_name: companyName.trim(),
        p_full_name: fullName.trim(),
      });
      if (err) throw err;
      const p = (Array.isArray(data) ? data[0] : data) as Profile;
      setProfile(p);
      setPhase('ready');
    });

  // ── phone / invite (secondary) ──────────────────────────────────────────────
  const normalise = (input: string): string | null => {
    const d = input.replace(/[^\d+]/g, '');
    if (/^\+353\d{9}$/.test(d)) return d;
    if (/^353\d{9}$/.test(d)) return `+${d}`;
    if (/^08\d{8}$/.test(d)) return `+353${d.slice(1)}`;
    return null;
  };
  const sendCode = () =>
    wrap(async () => {
      const p = normalise(phone);
      if (!p) throw new Error('Enter an Irish mobile, e.g. 087 123 4567');
      const { error: err } = await supabase.auth.signInWithOtp({ phone: p });
      if (err) throw err;
      setPhone(p);
      setPhase('otp');
    });
  const verify = () =>
    wrap(async () => {
      const { data, error: err } = await supabase.auth.verifyOtp({ phone, token: code.trim(), type: 'sms' });
      if (err) throw new Error('Wrong or expired code');
      await evaluate(data.session);
    });
  const joinWithCode = () =>
    wrap(async () => {
      const p = normalise(phone);
      if (!p) throw new Error('Enter an Irish mobile, e.g. 087 123 4567');
      if (inviteCode.trim().length !== 6) throw new Error('Enter the 6-digit invite code');
      let sess = (await supabase.auth.getSession()).data.session;
      if (!sess) {
        const { error: anonErr } = await supabase.auth.signInAnonymously();
        if (anonErr) throw anonErr;
        sess = (await supabase.auth.getSession()).data.session;
      }
      const { data, error: err } = await supabase.rpc('claim_invite_with_code', {
        p_phone: p,
        p_code: inviteCode.trim(),
      });
      if (err) throw err;
      const prof = (Array.isArray(data) ? data[0] : data) as Profile | null;
      if (!prof) throw new Error("That code isn't right — check it and try again.");
      await evaluate(sess);
    });

  if (phase === 'loading' || phase === 'checking') return <div className="center-page">Loading…</div>;
  if (phase === 'ready' && profile) return <>{children(profile)}</>;

  const Brand = () => (
    <h1>
      <svg className="auth-mark" viewBox="0 0 64 64">
        <rect width="64" height="64" rx="14" fill="#0B1220" />
        <circle cx="32" cy="32" r="20" fill="none" stroke="#4ADE80" strokeWidth="4.5" />
        <polyline points="23,33 29,39 42,25" fill="none" stroke="#F2F6FC" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      TimeTable
    </h1>
  );

  return (
    <div className="center-page">
      <div className="auth-card">
        <Brand />
        <p className="dim">Manager dashboard</p>

        {phase === 'auth' && (
          <>
            <button className="google-btn" onClick={signInGoogle} disabled={busy}>
              <GoogleIcon /> Continue with Google
            </button>
            <div className="or">or</div>
            <label>Email</label>
            <input type="email" autoFocus placeholder="you@company.ie" value={email} onChange={(e) => setEmail(e.target.value)} />
            <label>Password</label>
            <input type="password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void signInEmail()} />
            <button onClick={signInEmail} disabled={busy}>Sign in</button>
            <div className="auth-links">
              <span role="button" onClick={signUpEmail}>Create account</span>
              <span role="button" onClick={resetPassword}>Forgot password?</span>
            </div>
            <div className="or">·</div>
            <button className="ghost" onClick={() => { setError(null); setInfo(null); setPhase('phone'); }}>
              Sign in with phone / invite code
            </button>
          </>
        )}

        {phase === 'onboarding' && (
          <>
            <p>Welcome! Set up your company to start your 14-day free trial.</p>
            <label>Company name</label>
            <input autoFocus placeholder="Acme Groundworks" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            <label>Your name</label>
            <input placeholder="Mary Manager" value={fullName} onChange={(e) => setFullName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void createCompany()} />
            <button onClick={createCompany} disabled={busy}>Create company & start trial</button>
            <button className="ghost" onClick={() => void supabase.auth.signOut()}>Sign out</button>
          </>
        )}

        {phase === 'recovery' && (
          <>
            <p>Choose a new password.</p>
            <label>New password</label>
            <input type="password" autoFocus placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void setNewPassword()} />
            <button onClick={setNewPassword} disabled={busy}>Set password</button>
          </>
        )}

        {phase === 'phone' && (
          <>
            <label>Mobile number</label>
            <input autoFocus placeholder="087 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void sendCode()} />
            <button onClick={sendCode} disabled={busy}>Text me a code</button>
            <button className="ghost" onClick={() => setPhase('invite')}>I have an invite code</button>
            <button className="ghost" onClick={() => setPhase('auth')}>Back to email sign-in</button>
          </>
        )}

        {phase === 'invite' && (
          <>
            <label>Mobile number</label>
            <input autoFocus placeholder="087 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <label>Invite code</label>
            <input placeholder="6-digit code" maxLength={6} value={inviteCode} onChange={(e) => setInviteCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void joinWithCode()} />
            <button onClick={joinWithCode} disabled={busy}>Join</button>
            <button className="ghost" onClick={() => setPhase('phone')}>Back</button>
          </>
        )}

        {phase === 'otp' && (
          <>
            <label>Code sent to {phone}</label>
            <input autoFocus placeholder="123456" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void verify()} />
            <button onClick={verify} disabled={busy}>Verify</button>
            <button className="ghost" onClick={() => setPhase('phone')}>Different number</button>
          </>
        )}

        {phase === 'notManager' && (
          <>
            <p>This dashboard is for managers. Workers clock in with the phone app.</p>
            <button className="ghost" onClick={() => void supabase.auth.signOut()}>Sign out</button>
          </>
        )}

        {info && <p className="info-msg">{info}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
