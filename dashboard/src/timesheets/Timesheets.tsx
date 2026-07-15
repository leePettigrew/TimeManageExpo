// Timesheets: weekly totals with per-day drilldown and CSV export for payroll.
// All numbers come from the SQL views (single source of truth shared with any
// future consumer); CSV is generated client-side from the same data.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import type { TimesheetDaily, TimesheetWeekly, ShiftEffective } from '../lib/types';
import { downloadCsv, fmtDate, fmtHours, fmtTime } from '../lib/format';
import { FLAG_LABELS } from '../lib/types';
import { ShiftReplay } from './ShiftReplay';

function isoWeekOf(d: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: date.getUTCFullYear(), week };
}

function shiftWeek(year: number, week: number, delta: number): { year: number; week: number } {
  // walk via an actual date to handle 52/53-week years correctly
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - day + 1 + (week - 1 + delta) * 7);
  return isoWeekOf(monday);
}

export function Timesheets() {
  const [{ year, week }, setWeek] = useState(() => isoWeekOf(new Date()));
  const [drill, setDrill] = useState<string | null>(null); // worker_id
  const [replay, setReplay] = useState<ShiftEffective | null>(null);

  const weekly = useQuery({
    queryKey: ['timesheet-weekly', year, week],
    queryFn: async (): Promise<TimesheetWeekly[]> => {
      const { data, error } = await supabase
        .from('v_timesheet_weekly')
        .select('*')
        .eq('iso_year', year)
        .eq('iso_week', week)
        .order('full_name');
      if (error) throw error;
      return data as TimesheetWeekly[];
    },
  });

  const daily = useQuery({
    queryKey: ['timesheet-daily', year, week, drill],
    enabled: !!drill,
    queryFn: async (): Promise<TimesheetDaily[]> => {
      const { data, error } = await supabase
        .from('v_timesheet_daily')
        .select('*')
        .eq('worker_id', drill as string)
        .order('work_date', { ascending: false })
        .limit(30);
      if (error) throw error;
      return data as TimesheetDaily[];
    },
  });

  const shifts = useQuery({
    queryKey: ['worker-shifts', drill],
    enabled: !!drill,
    queryFn: async (): Promise<ShiftEffective[]> => {
      const { data, error } = await supabase
        .from('v_shift_effective')
        .select('*')
        .eq('worker_id', drill as string)
        .order('clock_in_device_at', { ascending: false })
        .limit(30);
      if (error) throw error;
      return data as ShiftEffective[];
    },
  });

  const rows = weekly.data ?? [];
  const totalSeconds = rows.reduce((acc, r) => acc + (r.worked_seconds ?? 0), 0);
  const totalFlagged = rows.reduce((acc, r) => acc + r.flagged_shifts, 0);

  const exportCsv = () => {
    downloadCsv(
      `timesheet-${year}-W${String(week).padStart(2, '0')}.csv`,
      ['Worker', 'ISO week', 'Shifts', 'Hours (decimal)', 'Hours', 'Flagged shifts', 'Adjusted'],
      rows.map((r) => [
        r.full_name,
        `${r.iso_year}-W${String(r.iso_week).padStart(2, '0')}`,
        r.shift_count,
        r.worked_hours,
        fmtHours(r.worked_seconds),
        r.flagged_shifts,
        r.has_adjustments ? 'yes' : '',
      ]),
    );
  };

  return (
    <div className="page">
      <div className="toolbar">
        <button className="ghost" onClick={() => setWeek(shiftWeek(year, week, -1))}>
          ◀
        </button>
        <h2>
          Week {week}, {year}
        </h2>
        <button className="ghost" onClick={() => setWeek(shiftWeek(year, week, 1))}>
          ▶
        </button>
        <span className="spacer" />
        <button onClick={exportCsv} disabled={rows.length === 0}>
          Export CSV
        </button>
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="k">Team hours this week</div>
          <div className="v green">{fmtHours(totalSeconds)}</div>
        </div>
        <div className="stat">
          <div className="k">People worked</div>
          <div className="v">{rows.length}</div>
        </div>
        <div className="stat">
          <div className="k">Shifts flagged</div>
          <div className={`v ${totalFlagged > 0 ? 'amber' : ''}`}>{totalFlagged}</div>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Worker</th>
            <th>Shifts</th>
            <th>Hours</th>
            <th>Flags</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.worker_id}>
              <td>{r.full_name}</td>
              <td>{r.shift_count}</td>
              <td>
                {fmtHours(r.worked_seconds)}
                {r.has_adjustments ? <span title="Includes manager adjustments"> ✎</span> : null}
              </td>
              <td>{r.flagged_shifts > 0 ? <span className="badge flag">{r.flagged_shifts}</span> : '—'}</td>
              <td>
                <button className="ghost small" onClick={() => setDrill(drill === r.worker_id ? null : r.worker_id)}>
                  {drill === r.worker_id ? 'Hide' : 'Details'}
                </button>
              </td>
            </tr>
          ))}
          {!weekly.isLoading && rows.length === 0 && (
            <tr>
              <td colSpan={5} className="dim">
                No shifts recorded this week.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {drill && (
        <div className="drill">
          <h3>Recent days</h3>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Shifts</th>
                <th>Hours</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {(daily.data ?? []).map((d) => (
                <tr key={d.work_date}>
                  <td>{fmtDate(d.work_date)}</td>
                  <td>{d.shift_count}</td>
                  <td>{fmtHours(d.worked_seconds)}</td>
                  <td>{d.flagged_shifts > 0 ? <span className="badge flag">{d.flagged_shifts}</span> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Recent shifts</h3>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>In</th>
                <th>Out</th>
                <th>Hours</th>
                <th>Status</th>
                <th>Flags</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(shifts.data ?? []).map((s) => (
                <tr key={s.id}>
                  <td>{fmtDate(s.effective_clock_in_at)}</td>
                  <td>{fmtTime(s.effective_clock_in_at)}</td>
                  <td>{fmtTime(s.effective_clock_out_at)}</td>
                  <td>
                    {fmtHours(s.worked_seconds)}
                    {s.is_adjusted ? ' ✎' : ''}
                  </td>
                  <td>{s.status}</td>
                  <td>
                    {s.anomaly_flags.length === 0
                      ? '—'
                      : s.anomaly_flags.map((f) => (
                          <span key={f} className="badge flag" title={FLAG_LABELS[f] ?? f}>
                            {FLAG_LABELS[f] ?? f}
                          </span>
                        ))}
                  </td>
                  <td>
                    <button className="ghost small" onClick={() => setReplay(s)}>
                      Replay route
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {replay && <ShiftReplay shift={replay} onClose={() => setReplay(null)} />}
    </div>
  );
}
