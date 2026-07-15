import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoginGate } from './auth/LoginGate';
import { LiveBoard } from './live/LiveBoard';
import { Timesheets } from './timesheets/Timesheets';
import { Review } from './review/Review';
import { Team } from './team/Team';
import { Admin } from './admin/Admin';
import { supabase } from './lib/supabase';
import type { Profile } from './lib/types';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 1 } },
});

type Tab = 'live' | 'timesheets' | 'review' | 'team' | 'admin';

function Shell({ profile }: { profile: Profile }) {
  const [tab, setTab] = useState<Tab>('live');
  return (
    <div className="shell">
      <header>
        <span className="brand">
          <span className="brand-mark">
            <svg width="18" height="18" viewBox="0 0 64 64">
              <circle cx="32" cy="32" r="20" fill="none" stroke="#4ADE80" strokeWidth="5" />
              <polyline
                points="23,33 29,39 42,25"
                fill="none"
                stroke="#F2F6FC"
                strokeWidth="5.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          TimeTable
        </span>
        <nav>
          {(
            [
              ['live', 'Live'],
              ['timesheets', 'Timesheets'],
              ['review', 'Review'],
              ['team', 'Team'],
              ...(profile.is_operator ? [['admin', 'Admin'] as [Tab, string]] : []),
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              className={tab === key ? 'tab active' : 'tab'}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <span className="dim">{profile.full_name}</span>
        <button className="ghost small" onClick={() => void supabase.auth.signOut().then(() => location.reload())}>
          Sign out
        </button>
      </header>
      <main>
        {tab === 'live' && <LiveBoard />}
        {tab === 'timesheets' && <Timesheets />}
        {tab === 'review' && <Review />}
        {tab === 'team' && <Team profile={profile} />}
        {tab === 'admin' && profile.is_operator && <Admin />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LoginGate>{(profile) => <Shell profile={profile} />}</LoginGate>
    </QueryClientProvider>
  );
}
