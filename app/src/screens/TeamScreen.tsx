// Manager view: who's on the clock right now, from the phone. Same RLS-scoped
// queries the dashboard uses; read-only, refreshed on pull and on a timer.
import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Screen } from '../ui/Screen';
import { Button } from '../ui/Button';
import { colors, spacing } from '../ui/theme';
import { supabase } from '../lib/supabase';

interface OpenShiftRow {
  id: string;
  worker_id: string;
  full_name: string;
  clock_in_device_at: string;
  anomaly_flags: string[];
}

interface LatestRow {
  worker_id: string;
  received_at: string;
  battery_pct: number | null;
}

export function TeamScreen({ onBack }: { onBack: () => void }) {
  const [shifts, setShifts] = useState<OpenShiftRow[]>([]);
  const [latest, setLatest] = useState<Map<string, LatestRow>>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [shiftRes, pingRes] = await Promise.all([
        supabase
          .from('v_shift_effective')
          .select('id, worker_id, full_name, clock_in_device_at, anomaly_flags')
          .eq('status', 'open')
          .order('clock_in_device_at', { ascending: true }),
        supabase.from('worker_latest_ping').select('worker_id, received_at, battery_pct'),
      ]);
      if (shiftRes.error) throw shiftRes.error;
      setShifts((shiftRes.data ?? []) as OpenShiftRow[]);
      setLatest(new Map(((pingRes.data ?? []) as LatestRow[]).map((p) => [p.worker_id, p])));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const ago = (iso: string) => {
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
  };

  return (
    <Screen title="Team" onBack={onBack}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <FlatList
        data={shifts}
        keyExtractor={(s) => s.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load()} />}
        ListEmptyComponent={<Text style={styles.dim}>Nobody is clocked in right now.</Text>}
        renderItem={({ item }) => {
          const p = latest.get(item.worker_id);
          const stale = !p || Date.now() - new Date(p.received_at).getTime() > 10 * 60_000;
          return (
            <View style={styles.row}>
              <View style={styles.rowTop}>
                <Text style={styles.name}>{item.full_name}</Text>
                <Text style={styles.dim}>
                  in since{' '}
                  {new Date(item.clock_in_device_at).toLocaleTimeString('en-IE', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Text>
              </View>
              <Text style={stale ? styles.warn : styles.ok}>
                {p ? `${stale ? '⚠ last seen ' : '● live · '}${ago(p.received_at)}` : '⚠ no location yet'}
                {p?.battery_pct != null ? ` · 🔋${p.battery_pct}%` : ''}
              </Text>
              {item.anomaly_flags.length > 0 ? (
                <Text style={styles.flag}>⚑ {item.anomaly_flags.join(', ')}</Text>
              ) : null}
            </View>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing(2),
    marginBottom: spacing(1),
    gap: 4,
  },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  name: { color: colors.text, fontSize: 17, fontWeight: '700' },
  dim: { color: colors.textDim, fontSize: 14 },
  ok: { color: colors.primary, fontSize: 14 },
  warn: { color: colors.warn, fontSize: 14 },
  flag: { color: colors.danger, fontSize: 13 },
  error: { color: colors.danger, fontSize: 15 },
});
