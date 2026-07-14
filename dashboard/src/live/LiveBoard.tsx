// Live "who's in" board: open shifts + latest positions. Realtime via
// Postgres Changes on shifts and worker_latest_ping, with 30s polling as the
// degraded-mode fallback and per-worker last-seen staleness badges — a manager
// must never mistake stale for live.
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import type { LatestPing, Ping, ShiftEffective } from '../lib/types';
import { fmtAgo, fmtTime, agoMinutes } from '../lib/format';
import { WorkerMap } from './WorkerMap';
import { FLAG_LABELS } from '../lib/types';

const STALE_MINUTES = 10;

export function LiveBoard() {
  const qc = useQueryClient();
  const [selectedShift, setSelectedShift] = useState<string | null>(null);
  const [focusWorker, setFocusWorker] = useState<string | null>(null);

  const openShifts = useQuery({
    queryKey: ['open-shifts'],
    queryFn: async (): Promise<ShiftEffective[]> => {
      const { data, error } = await supabase
        .from('v_shift_effective')
        .select('*')
        .eq('status', 'open')
        .order('clock_in_received_at', { ascending: true });
      if (error) throw error;
      return data as ShiftEffective[];
    },
    refetchInterval: 30_000,
  });

  const latestPings = useQuery({
    queryKey: ['latest-pings'],
    queryFn: async (): Promise<LatestPing[]> => {
      const { data, error } = await supabase.from('worker_latest_ping').select('*');
      if (error) throw error;
      return data as LatestPing[];
    },
    refetchInterval: 30_000,
  });

  const trail = useQuery({
    queryKey: ['trail', selectedShift],
    enabled: !!selectedShift,
    queryFn: async (): Promise<Ping[]> => {
      const { data, error } = await supabase
        .from('location_pings')
        .select('id, shift_id, seq, device_at, lat, lng, accuracy_m, mocked')
        .eq('shift_id', selectedShift as string)
        .order('device_at', { ascending: true })
        .limit(2000);
      if (error) throw error;
      return data as Ping[];
    },
    refetchInterval: 60_000,
  });

  // realtime: shifts flip the board, ping upserts move the map
  useEffect(() => {
    const channel = supabase
      .channel('live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts' }, () => {
        void qc.invalidateQueries({ queryKey: ['open-shifts'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'worker_latest_ping' }, () => {
        void qc.invalidateQueries({ queryKey: ['latest-pings'] });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [qc]);

  const shifts = openShifts.data ?? [];
  const pings = latestPings.data ?? [];

  const markers = useMemo(() => {
    const byWorker = new Map(pings.map((p) => [p.worker_id, p]));
    return shifts.flatMap((s) => {
      const p = byWorker.get(s.worker_id);
      if (!p || p.shift_id !== s.id) return [];
      return [{ ...p, name: s.full_name, stale: agoMinutes(p.received_at) > STALE_MINUTES }];
    });
  }, [shifts, pings]);

  const pingByWorker = useMemo(() => new Map(pings.map((p) => [p.worker_id, p])), [pings]);

  return (
    <div className="live-layout">
      <div className="live-list">
        <h2>
          On the clock <span className="count">{shifts.length}</span>
        </h2>
        {openShifts.isLoading && <p className="dim">Loading…</p>}
        {!openShifts.isLoading && shifts.length === 0 && (
          <p className="dim">Nobody is clocked in right now.</p>
        )}
        {shifts.map((s) => {
          const p = pingByWorker.get(s.worker_id);
          const stale = p ? agoMinutes(p.received_at) > STALE_MINUTES : true;
          return (
            <button
              key={s.id}
              className={`worker-row ${selectedShift === s.id ? 'selected' : ''}`}
              onClick={() => {
                setSelectedShift(s.id === selectedShift ? null : s.id);
                setFocusWorker(s.worker_id);
              }}
            >
              <div className="worker-row-top">
                <strong>{s.full_name}</strong>
                <span>in since {fmtTime(s.clock_in_device_at)}</span>
              </div>
              <div className="worker-row-bottom">
                {p && p.shift_id === s.id ? (
                  <span className={stale ? 'badge warn' : 'badge ok'}>
                    {stale ? `⚠ last seen ${fmtAgo(p.received_at)}` : `● live · ${fmtAgo(p.received_at)}`}
                    {p.battery_pct != null ? ` · 🔋${p.battery_pct}%` : ''}
                  </span>
                ) : (
                  <span className="badge warn">no location yet</span>
                )}
                {s.anomaly_flags.map((f) => (
                  <span key={f} className="badge flag" title={FLAG_LABELS[f] ?? f}>
                    {FLAG_LABELS[f] ?? f}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
        {selectedShift && (
          <p className="dim small">Showing today&apos;s route for the selected worker. Click again to hide.</p>
        )}
      </div>
      <WorkerMap
        latest={markers}
        trail={selectedShift ? (trail.data ?? null) : null}
        focusWorkerId={focusWorker}
        onSelectWorker={(workerId) => {
          const s = shifts.find((x) => x.worker_id === workerId);
          if (s) setSelectedShift(s.id);
          setFocusWorker(workerId);
        }}
      />
    </div>
  );
}
