// Crew management: invite by phone number (the app binds on first OTP login),
// deactivate leavers. Deactivation kills all data access immediately via RLS.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import type { Profile } from '../lib/types';
import { PING_INTERVALS } from '../lib/types';

interface Invite {
  id: string;
  phone_e164: string;
  role: 'manager' | 'worker';
  full_name: string;
  code: string;
  claimed_at: string | null;
  expires_at: string;
}

export function Team({ profile }: { profile: Profile }) {
  const qc = useQueryClient();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'worker' | 'manager'>('worker');
  const [error, setError] = useState<string | null>(null);

  const members = useQuery({
    queryKey: ['team'],
    queryFn: async (): Promise<Profile[]> => {
      const { data, error: err } = await supabase.from('profiles').select('*').order('full_name');
      if (err) throw err;
      return data as Profile[];
    },
  });

  const invites = useQuery({
    queryKey: ['invites'],
    queryFn: async (): Promise<Invite[]> => {
      const { data, error: err } = await supabase
        .from('invites')
        .select('*')
        .is('claimed_at', null)
        .order('created_at', { ascending: false });
      if (err) throw err;
      return data as Invite[];
    },
  });

  const addInvite = useMutation({
    mutationFn: async () => {
      const digits = phone.replace(/[^\d+]/g, '');
      const normalised = /^\+353\d{9}$/.test(digits)
        ? digits
        : /^353\d{9}$/.test(digits)
          ? `+${digits}`
          : /^08\d{8}$/.test(digits)
            ? `+353${digits.slice(1)}`
            : null;
      if (!normalised) throw new Error('Enter an Irish mobile, e.g. 087 123 4567');
      const { error: err } = await supabase.from('invites').insert({
        company_id: profile.company_id,
        phone_e164: normalised,
        role,
        full_name: name.trim(),
        created_by: profile.id,
      });
      if (err) {
        if (err.message.includes('invites_pending_phone_uq')) {
          throw new Error('That number already has a pending invite.');
        }
        throw err;
      }
    },
    onSuccess: () => {
      setPhone('');
      setName('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['invites'] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const setActive = useMutation({
    mutationFn: async (vars: { id: string; active: boolean }) => {
      const { error: err } = await supabase
        .from('profiles')
        .update({ is_active: vars.active })
        .eq('id', vars.id);
      if (err) throw err;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team'] }),
  });

  const removeInvite = useMutation({
    mutationFn: async (id: string) => {
      const { error: err } = await supabase.from('invites').delete().eq('id', id);
      if (err) throw err;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['invites'] }),
  });

  const setInterval_ = useMutation({
    mutationFn: async (vars: { id: string; seconds: number }) => {
      const { error: err } = await supabase
        .from('profiles')
        .update({ ping_interval_s: vars.seconds })
        .eq('id', vars.id);
      if (err) throw err;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team'] }),
  });

  return (
    <div className="page">
      <h2>Add someone</h2>
      <div className="invite-form">
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          placeholder="087 123 4567"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <select value={role} onChange={(e) => setRole(e.target.value as 'worker' | 'manager')}>
          <option value="worker">Worker</option>
          <option value="manager">Manager</option>
        </select>
        <button disabled={addInvite.isPending || !phone.trim()} onClick={() => addInvite.mutate()}>
          Invite
        </button>
      </div>
      <p className="dim small">
        They install the app, tap <strong>&quot;I have an invite code&quot;</strong>, and enter
        their number plus the code below — no text messages needed.
      </p>
      {error && <p className="error">{error}</p>}

      {(invites.data ?? []).length > 0 && (
        <>
          <h3>Waiting to join</h3>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Role</th>
                <th>Their invite code</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(invites.data ?? []).map((i) => (
                <tr key={i.id}>
                  <td>{i.full_name || '—'}</td>
                  <td>{i.phone_e164}</td>
                  <td>{i.role}</td>
                  <td>
                    <span className="code-pill">{i.code}</span>
                  </td>
                  <td>
                    <button className="ghost small" onClick={() => removeInvite.mutate(i.id)}>
                      Cancel invite
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>Team</h3>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Phone</th>
            <th>Role</th>
            <th>GPS updates</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(members.data ?? []).map((m) => (
            <tr key={m.id} className={m.is_active ? '' : 'inactive'}>
              <td>{m.full_name || '—'}</td>
              <td>{m.phone_e164}</td>
              <td>{m.role}</td>
              <td>
                <select
                  value={m.ping_interval_s}
                  title="How often this phone records a location while clocked in. Applies from the next sync; faster settings use more battery."
                  onChange={(e) => setInterval_.mutate({ id: m.id, seconds: Number(e.target.value) })}
                >
                  {PING_INTERVALS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                  {!PING_INTERVALS.some((o) => o.value === m.ping_interval_s) && (
                    <option value={m.ping_interval_s}>{m.ping_interval_s}s</option>
                  )}
                </select>
              </td>
              <td>{m.is_active ? 'active' : 'deactivated'}</td>
              <td>
                {m.id !== profile.id && (
                  <button
                    className="ghost small"
                    onClick={() => setActive.mutate({ id: m.id, active: !m.is_active })}
                  >
                    {m.is_active ? 'Deactivate' : 'Reactivate'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="dim small">
        GPS cadence and on-demand location checks only ever apply while someone is clocked in —
        the server refuses both otherwise, and workers can see every location check in their app.
      </p>
    </div>
  );
}
