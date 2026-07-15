// Operator console — visible only to profiles flagged is_operator. Reads span
// every company (operator RLS policies); every mutation goes through an
// audited admin_* RPC. No service keys anywhere near the browser.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import type { Company, Profile } from '../lib/types';
import { fmtAgo } from '../lib/format';

interface AdminInvite {
  id: string;
  company_id: string;
  phone_e164: string;
  role: string;
  full_name: string;
  code: string;
  created_at: string;
  expires_at: string;
}

interface AuditRow {
  id: number;
  company_id: string | null;
  action: string;
  entity: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export function Admin() {
  const qc = useQueryClient();
  const [newCompany, setNewCompany] = useState({ name: '', phone: '', manager: '' });
  const [personFilter, setPersonFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  const companies = useQuery({
    queryKey: ['admin-companies'],
    queryFn: async (): Promise<Company[]> => {
      const { data, error: err } = await supabase.from('companies').select('*').order('created_at');
      if (err) throw err;
      return data as Company[];
    },
  });

  const people = useQuery({
    queryKey: ['admin-people'],
    queryFn: async (): Promise<Profile[]> => {
      const { data, error: err } = await supabase.from('profiles').select('*').order('full_name');
      if (err) throw err;
      return data as Profile[];
    },
  });

  const invites = useQuery({
    queryKey: ['admin-invites'],
    queryFn: async (): Promise<AdminInvite[]> => {
      const { data, error: err } = await supabase
        .from('invites')
        .select('*')
        .is('claimed_at', null)
        .order('created_at', { ascending: false });
      if (err) throw err;
      return data as AdminInvite[];
    },
  });

  const openShifts = useQuery({
    queryKey: ['admin-open-shifts'],
    queryFn: async (): Promise<number> => {
      const { count, error: err } = await supabase
        .from('shifts')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'open');
      if (err) throw err;
      return count ?? 0;
    },
    refetchInterval: 30_000,
  });

  const audit = useQuery({
    queryKey: ['admin-audit'],
    queryFn: async (): Promise<AuditRow[]> => {
      const { data, error: err } = await supabase
        .from('audit_log')
        .select('id, company_id, action, entity, detail, created_at')
        .order('created_at', { ascending: false })
        .limit(40);
      if (err) throw err;
      return data as AuditRow[];
    },
    refetchInterval: 60_000,
  });

  const companyName = useMemo(() => {
    const map = new Map((companies.data ?? []).map((c) => [c.id, c.name]));
    return (id: string | null) => (id ? (map.get(id) ?? '—') : '—');
  }, [companies.data]);

  const invalidateAll = () => {
    for (const k of ['admin-companies', 'admin-people', 'admin-invites', 'admin-audit']) {
      void qc.invalidateQueries({ queryKey: [k] });
    }
  };

  const createCompany = useMutation({
    mutationFn: async () => {
      const digits = newCompany.phone.replace(/[^\d+]/g, '');
      const phone = /^\+353\d{9}$/.test(digits)
        ? digits
        : /^08\d{8}$/.test(digits)
          ? `+353${digits.slice(1)}`
          : null;
      if (!phone) throw new Error('Manager phone must be an Irish mobile, e.g. 087 123 4567');
      if (newCompany.name.trim().length < 2) throw new Error('Company name required');
      const { error: err } = await supabase.rpc('admin_create_company', {
        p_name: newCompany.name.trim(),
        p_manager_phone: phone,
        p_manager_name: newCompany.manager.trim(),
      });
      if (err) throw err;
    },
    onSuccess: () => {
      setNewCompany({ name: '', phone: '', manager: '' });
      setError(null);
      invalidateAll();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const renameCompany = useMutation({
    mutationFn: async (vars: { id: string; name: string }) => {
      const { error: err } = await supabase.rpc('admin_rename_company', {
        p_company_id: vars.id,
        p_name: vars.name,
      });
      if (err) throw err;
    },
    onSuccess: invalidateAll,
  });

  const setActive = useMutation({
    mutationFn: async (vars: { id: string; active: boolean }) => {
      const { error: err } = await supabase.rpc('admin_set_profile_active', {
        p_profile_id: vars.id,
        p_active: vars.active,
      });
      if (err) throw err;
    },
    onSuccess: invalidateAll,
  });

  const cancelInvite = useMutation({
    mutationFn: async (id: string) => {
      const { error: err } = await supabase.rpc('admin_cancel_invite', { p_invite_id: id });
      if (err) throw err;
    },
    onSuccess: invalidateAll,
  });

  const allPeople = people.data ?? [];
  const filtered = personFilter
    ? allPeople.filter(
        (p) =>
          p.full_name.toLowerCase().includes(personFilter.toLowerCase()) ||
          p.phone_e164.includes(personFilter.replace(/\s/g, '')),
      )
    : allPeople;

  return (
    <div className="page">
      <div className="stat-row">
        <div className="stat">
          <div className="k">Companies</div>
          <div className="v">{companies.data?.length ?? '…'}</div>
        </div>
        <div className="stat">
          <div className="k">People</div>
          <div className="v">{allPeople.length || '…'}</div>
        </div>
        <div className="stat">
          <div className="k">On the clock now</div>
          <div className="v green">{openShifts.data ?? '…'}</div>
        </div>
        <div className="stat">
          <div className="k">Pending invites</div>
          <div className="v">{invites.data?.length ?? '…'}</div>
        </div>
      </div>

      <h2>New company</h2>
      <div className="invite-form">
        <input
          placeholder="Company name"
          value={newCompany.name}
          onChange={(e) => setNewCompany({ ...newCompany, name: e.target.value })}
        />
        <input
          placeholder="Boss's name"
          value={newCompany.manager}
          onChange={(e) => setNewCompany({ ...newCompany, manager: e.target.value })}
        />
        <input
          placeholder="Boss's mobile (087...)"
          value={newCompany.phone}
          onChange={(e) => setNewCompany({ ...newCompany, phone: e.target.value })}
        />
        <button disabled={createCompany.isPending} onClick={() => createCompany.mutate()}>
          Create company
        </button>
      </div>
      <p className="dim small">
        Creates the company and a manager invite — the code appears below; give it to the boss with
        the dashboard link.
      </p>
      {error && <p className="error">{error}</p>}

      <h2>Companies</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>People</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(companies.data ?? []).map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{allPeople.filter((p) => p.company_id === c.id).length}</td>
              <td className="dim">{new Date(c.created_at).toLocaleDateString('en-IE')}</td>
              <td>
                <button
                  className="ghost small"
                  onClick={() => {
                    const name = prompt('New name for this company:', c.name);
                    if (name && name.trim().length >= 2) renameCompany.mutate({ id: c.id, name: name.trim() });
                  }}
                >
                  Rename
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {(invites.data ?? []).length > 0 && (
        <>
          <h2>Pending invites (all companies)</h2>
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Name</th>
                <th>Phone</th>
                <th>Role</th>
                <th>Code</th>
                <th>Expires</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(invites.data ?? []).map((i) => (
                <tr key={i.id}>
                  <td>{companyName(i.company_id)}</td>
                  <td>{i.full_name || '—'}</td>
                  <td>{i.phone_e164}</td>
                  <td>{i.role}</td>
                  <td>
                    <span className="badge info" style={{ fontSize: 14, letterSpacing: 2 }}>
                      {i.code}
                    </span>
                  </td>
                  <td className="dim">{new Date(i.expires_at).toLocaleDateString('en-IE')}</td>
                  <td>
                    <button className="ghost small" onClick={() => cancelInvite.mutate(i.id)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>People (all companies)</h2>
      <input
        placeholder="Search by name or phone…"
        value={personFilter}
        onChange={(e) => setPersonFilter(e.target.value)}
        style={{ width: 280 }}
      />
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Company</th>
            <th>Phone</th>
            <th>Role</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((p) => (
            <tr key={p.id} className={p.is_active ? '' : 'inactive'}>
              <td>
                {p.full_name || '—'}
                {p.is_operator ? <span className="badge info">operator</span> : null}
              </td>
              <td>{companyName(p.company_id)}</td>
              <td>{p.phone_e164}</td>
              <td>{p.role}</td>
              <td>{p.is_active ? 'active' : 'deactivated'}</td>
              <td>
                <button
                  className="ghost small"
                  onClick={() => setActive.mutate({ id: p.id, active: !p.is_active })}
                >
                  {p.is_active ? 'Deactivate' : 'Reactivate'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Recent activity</h2>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Company</th>
            <th>Action</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {(audit.data ?? []).map((a) => (
            <tr key={a.id}>
              <td className="dim">{fmtAgo(a.created_at)}</td>
              <td>{companyName(a.company_id)}</td>
              <td>{a.action}</td>
              <td className="dim small">{JSON.stringify(a.detail)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
