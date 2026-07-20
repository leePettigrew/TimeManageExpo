import { useEffect, useState } from 'react';
import '@fontsource-variable/inter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoginGate } from './auth/LoginGate';
import { LiveBoard } from './live/LiveBoard';
import { Timesheets } from './timesheets/Timesheets';
import { Review } from './review/Review';
import { Team } from './team/Team';
import { Admin } from './admin/Admin';
import { BillingProvider, useBilling } from './billing/BillingContext';
import { BillingPage } from './billing/BillingPage';
import { trialDaysLeft, startCheckout } from './billing/billing';
import { Icon } from './ui/Icon';
import { supabase } from './lib/supabase';
import type { Profile } from './lib/types';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 1 } },
});

type Tab = 'live' | 'timesheets' | 'review' | 'team' | 'admin' | 'billing';

const NAV: { key: Tab; label: string; icon: 'live' | 'timesheet' | 'review' | 'team' | 'admin' }[] = [
  { key: 'live', label: 'Live', icon: 'live' },
  { key: 'timesheets', label: 'Timesheets', icon: 'timesheet' },
  { key: 'review', label: 'Review', icon: 'review' },
  { key: 'team', label: 'Team', icon: 'team' },
];

const TITLES: Record<Tab, { title: string; sub: string }> = {
  live: { title: 'Live board', sub: "Who's on the clock right now" },
  timesheets: { title: 'Timesheets', sub: 'Hours by week, ready for payroll' },
  review: { title: 'Needs review', sub: 'Shifts flagged for a closer look' },
  team: { title: 'Team', sub: 'Invite workers and manage your crew' },
  admin: { title: 'Admin', sub: 'Companies, people and activity across the system' },
  billing: { title: 'Billing', sub: 'Your plan and subscription' },
};

function initials(name: string): string {
  return (
    name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?'
  );
}

function TrialBanner({ onGoBilling }: { onGoBilling: () => void }) {
  const { company } = useBilling();
  if (!company) return null;
  const s = company.subscription_status;
  if (s === 'active') return null;

  if (s === 'trialing' && company.is_active) {
    const days = trialDaysLeft(company);
    if (days > 7) return null; // only nag in the last week
    return (
      <div className="banner warn">
        <Icon name="clock" size={16} />
        <span>Free trial ends in {days} day{days === 1 ? '' : 's'}.</span>
        <span className="spacer" />
        <button onClick={() => void startCheckout()}>Subscribe</button>
      </div>
    );
  }
  // trial ended / not active → read-only
  return (
    <div className="banner danger">
      <Icon name="review" size={16} />
      <span>Your trial has ended — the dashboard is read-only. Subscribe to keep tracking.</span>
      <span className="spacer" />
      <button className="ghost" onClick={onGoBilling}>Details</button>
      <button onClick={() => void startCheckout()}>Subscribe</button>
    </div>
  );
}

function Shell({ profile }: { profile: Profile }) {
  const [tab, setTab] = useState<Tab>('live');

  // returning from Stripe Checkout
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('billing')) {
      setTab('billing');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const nav = profile.is_operator
    ? [...NAV, { key: 'admin' as Tab, label: 'Admin', icon: 'admin' as const }]
    : NAV;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="side-brand">
          <span className="brand-mark">
            <svg width="20" height="20" viewBox="0 0 64 64">
              <circle cx="32" cy="32" r="20" fill="none" stroke="#4ADE80" strokeWidth="5" />
              <polyline points="23,33 29,39 42,25" fill="none" stroke="#F2F6FC" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="side-brand-name">TimeTable</span>
        </div>

        <nav className="side-nav">
          {nav.map((n) => (
            <button key={n.key} className={tab === n.key ? 'side-link active' : 'side-link'} onClick={() => setTab(n.key)}>
              <Icon name={n.icon} size={19} />
              {n.label}
            </button>
          ))}
          <button className={tab === 'billing' ? 'side-link active' : 'side-link'} onClick={() => setTab('billing')}>
            <Icon name="battery" size={19} />
            Billing
          </button>
        </nav>

        <div className="side-user">
          <div className="side-avatar">{initials(profile.full_name || '?')}</div>
          <div className="side-user-meta">
            <span className="side-user-name">{profile.full_name || 'Manager'}</span>
            <span className="side-user-role">{profile.is_operator ? 'Operator' : 'Manager'}</span>
          </div>
          <button className="icon-btn" title="Sign out" onClick={() => void supabase.auth.signOut().then(() => location.reload())}>
            <Icon name="signout" size={18} />
          </button>
        </div>
      </aside>

      <div className="content">
        <TrialBanner onGoBilling={() => setTab('billing')} />
        <header className="topbar">
          <div>
            <h1 className="topbar-title">{TITLES[tab].title}</h1>
            <p className="topbar-sub">{TITLES[tab].sub}</p>
          </div>
        </header>
        <main className={tab === 'live' ? 'main-flush' : 'main-scroll'}>
          {tab === 'live' && <LiveBoard />}
          {tab === 'timesheets' && <Timesheets />}
          {tab === 'review' && <Review />}
          {tab === 'team' && <Team profile={profile} />}
          {tab === 'admin' && profile.is_operator && <Admin />}
          {tab === 'billing' && <BillingPage />}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LoginGate>
        {(profile) => (
          <BillingProvider>
            <Shell profile={profile} />
          </BillingProvider>
        )}
      </LoginGate>
    </QueryClientProvider>
  );
}
