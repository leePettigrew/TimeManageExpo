// My hours: the worker's own timesheet. Transparency kills pay disputes —
// what the boss sees is what the worker sees. Cached locally so it still
// opens in a dead zone.
import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen, Card, Chip } from '../ui/Screen';
import { colors, spacing } from '../ui/theme';
import { supabase } from '../lib/supabase';
import { kvGet, kvSet } from '../lib/outbox';

interface ShiftRow {
  id: string;
  status: string;
  effective_clock_in_at: string;
  effective_clock_out_at: string | null;
  worked_seconds: number | null;
  is_adjusted: boolean;
  is_flagged: boolean;
}

interface HoursData {
  fetchedAt: string;
  weekSeconds: number;
  weekShifts: number;
  shifts: ShiftRow[];
}

function fmtHours(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' });
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' });
}

function startOfIsoWeek(): Date {
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // Mon=0
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function HoursScreen({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<HoursData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const since = new Date(Date.now() - 30 * 86400_000).toISOString();
      const { data: rows, error } = await supabase
        .from('v_shift_effective')
        .select('id, status, effective_clock_in_at, effective_clock_out_at, worked_seconds, is_adjusted, is_flagged')
        .gte('effective_clock_in_at', since)
        .order('effective_clock_in_at', { ascending: false })
        .limit(60);
      if (error) throw error;

      const weekStart = startOfIsoWeek().getTime();
      const shifts = (rows ?? []) as ShiftRow[];
      const weekRows = shifts.filter((s) => new Date(s.effective_clock_in_at).getTime() >= weekStart);
      const fresh: HoursData = {
        fetchedAt: new Date().toISOString(),
        weekSeconds: weekRows.reduce((acc, s) => acc + (s.worked_seconds ?? 0), 0),
        weekShifts: weekRows.length,
        shifts,
      };
      setData(fresh);
      setOffline(false);
      await kvSet('hours_cache', JSON.stringify(fresh));
    } catch {
      const cached = await kvGet('hours_cache');
      if (cached) setData(JSON.parse(cached) as HoursData);
      setOffline(true);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen title="My hours" onBack={onBack}>
      <Card active>
        <Text style={styles.weekLabel}>THIS WEEK</Text>
        <Text style={styles.weekHours}>{fmtHours(data?.weekSeconds ?? 0)}</Text>
        <Text style={styles.weekMeta}>
          {data ? `${data.weekShifts} shift${data.weekShifts === 1 ? '' : 's'}` : '…'}
          {offline && data ? ` · as of ${fmtTime(data.fetchedAt)} (offline)` : ''}
        </Text>
      </Card>

      <Text style={styles.sectionTitle}>Last 30 days</Text>
      <FlatList
        data={data?.shifts ?? []}
        keyExtractor={(s) => s.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load()} tintColor={colors.primary} />}
        ListEmptyComponent={
          <Text style={styles.empty}>{refreshing ? 'Loading…' : 'No shifts yet — clock in to start the record.'}</Text>
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Text style={styles.rowDay}>{fmtDay(item.effective_clock_in_at)}</Text>
              <Text style={styles.rowTimes}>
                {fmtTime(item.effective_clock_in_at)} → {item.status === 'open' ? 'now' : fmtTime(item.effective_clock_out_at)}
              </Text>
            </View>
            <View style={styles.rowRight}>
              <Text style={styles.rowHours}>
                {item.status === 'open' ? 'on the clock' : fmtHours(item.worked_seconds)}
              </Text>
              <View style={styles.rowChips}>
                {item.is_adjusted ? <Chip label="adjusted" tone="info" icon="create-outline" /> : null}
                {item.is_flagged ? <Chip label="review" tone="warn" icon="flag-outline" /> : null}
              </View>
            </View>
          </View>
        )}
      />
      <View style={styles.footNoteRow}>
        <Ionicons name="shield-checkmark-outline" size={14} color={colors.textFaint} />
        <Text style={styles.footNote}>Exactly what your employer sees — nothing more.</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  weekLabel: { color: colors.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 2 },
  weekHours: { color: colors.text, fontSize: 44, fontWeight: '800', letterSpacing: -1 },
  weekMeta: { color: colors.textDim, fontSize: 14 },
  sectionTitle: { color: colors.textDim, fontSize: 14, fontWeight: '600', marginTop: spacing(0.5) },
  empty: { color: colors.textFaint, fontSize: 15, paddingVertical: spacing(2) },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing(2),
    marginBottom: spacing(1),
  },
  rowLeft: { gap: 2 },
  rowDay: { color: colors.text, fontSize: 16, fontWeight: '700' },
  rowTimes: { color: colors.textDim, fontSize: 13 },
  rowRight: { alignItems: 'flex-end', gap: 4 },
  rowHours: { color: colors.primary, fontSize: 17, fontWeight: '800' },
  rowChips: { flexDirection: 'row', gap: 4 },
  footNoteRow: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center' },
  footNote: { color: colors.textFaint, fontSize: 12 },
});
