// Anomaly review queue: every fraud flag surfaces here with its evidence, and
// corrections are append-only adjustments via the adjust_shift RPC — original
// clock evidence is never rewritten.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import type { ShiftEffective } from '../lib/types';
import { FLAG_LABELS } from '../lib/types';
import { fmtDate, fmtHours, fmtTime } from '../lib/format';

export function Review() {
  const qc = useQueryClient();
  const [adjusting, setAdjusting] = useState<ShiftEffective | null>(null);

  const flagged = useQuery({
    queryKey: ['flagged-shifts'],
    queryFn: async (): Promise<ShiftEffective[]> => {
      const { data, error } = await supabase
        .from('v_shift_effective')
        .select('*')
        .eq('is_flagged', true)
        .neq('status', 'open')
        .order('clock_in_device_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as ShiftEffective[];
    },
    refetchInterval: 60_000,
  });

  const resolve = useMutation({
    mutationFn: async (vars: { shiftId: string; field: string; value: string; reason: string }) => {
      const { error } = await supabase.rpc('adjust_shift', {
        p_shift_id: vars.shiftId,
        p_field: vars.field,
        p_new_value: vars.value,
        p_reason: vars.reason,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setAdjusting(null);
      void qc.invalidateQueries({ queryKey: ['flagged-shifts'] });
      void qc.invalidateQueries({ queryKey: ['timesheet-weekly'] });
    },
  });

  const rows = flagged.data ?? [];

  return (
    <div className="page">
      <h2>Needs review</h2>
      <p className="dim">
        Shifts with anomalies. Flags are evidence, not verdicts — talk to the worker, then adjust
        the times or mark the shift reviewed. Every change is logged and the original record kept.
      </p>
      <table>
        <thead>
          <tr>
            <th>Worker</th>
            <th>Date</th>
            <th>In → Out</th>
            <th>Hours</th>
            <th>Status</th>
            <th>Flags</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td>{s.full_name}</td>
              <td>{fmtDate(s.effective_clock_in_at)}</td>
              <td>
                {fmtTime(s.effective_clock_in_at)} → {fmtTime(s.effective_clock_out_at)}
              </td>
              <td>{fmtHours(s.worked_seconds)}{s.is_adjusted ? ' ✎' : ''}</td>
              <td>{s.status}</td>
              <td>
                {s.anomaly_flags.map((f) => (
                  <span key={f} className="badge flag" title={f}>
                    {FLAG_LABELS[f] ?? f}
                  </span>
                ))}
                {s.clock_in_sync_lag_s > 6 * 3600 && (
                  <span className="badge warn">synced {Math.round(s.clock_in_sync_lag_s / 3600)}h late</span>
                )}
              </td>
              <td>
                <button className="ghost small" onClick={() => setAdjusting(s)}>
                  Resolve
                </button>
              </td>
            </tr>
          ))}
          {!flagged.isLoading && rows.length === 0 && (
            <tr>
              <td colSpan={7} className="dim">
                Nothing needs review. 🎉
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {adjusting && (
        <AdjustDialog
          shift={adjusting}
          busy={resolve.isPending}
          error={resolve.error ? String(resolve.error.message) : null}
          onCancel={() => setAdjusting(null)}
          onSubmit={(field, value, reason) =>
            resolve.mutate({ shiftId: adjusting.id, field, value, reason })
          }
        />
      )}
    </div>
  );
}

function AdjustDialog({
  shift,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  shift: ShiftEffective;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (field: string, value: string, reason: string) => void;
}) {
  const [field, setField] = useState<'clock_out_at' | 'clock_in_at' | 'status'>('clock_out_at');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');

  const toLocalInput = (iso: string | null) => {
    if (!iso) return '';
    const d = new Date(iso);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          Adjust — {shift.full_name}, {fmtDate(shift.effective_clock_in_at)}
        </h3>
        <label>What to change</label>
        <select
          value={field}
          onChange={(e) => {
            const f = e.target.value as typeof field;
            setField(f);
            setValue('');
          }}
        >
          <option value="clock_out_at">Clock-out time</option>
          <option value="clock_in_at">Clock-in time</option>
          <option value="status">Mark reviewed / disputed</option>
        </select>

        {field === 'status' ? (
          <select value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">— choose —</option>
            <option value="closed">Reviewed, hours stand (closed)</option>
            <option value="disputed">Disputed</option>
          </select>
        ) : (
          <input
            type="datetime-local"
            value={value || toLocalInput(field === 'clock_in_at' ? shift.effective_clock_in_at : shift.effective_clock_out_at)}
            onChange={(e) => setValue(e.target.value)}
          />
        )}

        <label>Reason (required, shown in the audit log)</label>
        <input
          placeholder="e.g. confirmed by phone, van tracker agrees"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            disabled={busy || !reason.trim() || !(value || field !== 'status')}
            onClick={() => {
              const v =
                field === 'status'
                  ? value
                  : new Date(
                      value ||
                        toLocalInput(
                          field === 'clock_in_at' ? shift.effective_clock_in_at : shift.effective_clock_out_at,
                        ),
                    ).toISOString();
              onSubmit(field, v, reason.trim());
            }}
          >
            Save adjustment
          </button>
        </div>
      </div>
    </div>
  );
}
