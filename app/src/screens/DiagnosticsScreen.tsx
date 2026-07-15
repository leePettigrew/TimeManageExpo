// On-device tracking diagnostics. This is how you actually verify the app is
// capturing and delivering GPS — everything about the tracking pipeline made
// visible on the phone: permissions, whether the background task is alive,
// points captured this shift, last fix + accuracy, and sync backlog.
import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { Screen, Card } from '../ui/Screen';
import { Button } from '../ui/Button';
import { colors, spacing } from '../ui/theme';
import { getLocalShift } from '../lib/shift';
import { breadcrumbsRunning } from '../lib/breadcrumbs';
import { pendingCounts, pingStatsFor, kvGet } from '../lib/outbox';
import { getFix } from '../lib/location';
import { flush } from '../lib/sync';

interface Diag {
  fg: string;
  bg: string;
  taskRunning: boolean;
  hasShift: boolean;
  serverShiftId: string | null;
  intervalS: string;
  trailState: string;
  captured: number;
  synced: number;
  lastFixAt: string | null;
  lastAccuracy: number | null;
  queuedEvents: number;
  queuedPings: number;
  lastSyncAt: string | null;
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function DiagnosticsScreen({ onBack }: { onBack: () => void }) {
  const [d, setD] = useState<Diag | null>(null);
  const [testFix, setTestFix] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const fg = await Location.getForegroundPermissionsAsync().catch(() => null);
    const bg = await Location.getBackgroundPermissionsAsync().catch(() => null);
    const shift = await getLocalShift();
    const stats = shift ? await pingStatsFor(shift.clockEventId) : null;
    const counts = await pendingCounts();
    setD({
      fg: fg?.status ?? 'unknown',
      bg: bg?.status ?? 'unknown',
      taskRunning: await breadcrumbsRunning(),
      hasShift: !!shift,
      serverShiftId: shift?.serverShiftId ?? null,
      intervalS: (await kvGet('applied_interval_s')) ?? (await kvGet('ping_interval_s')) ?? 'default',
      trailState: (await kvGet('breadcrumbs_state')) ?? 'off',
      captured: stats?.total ?? 0,
      synced: stats?.synced ?? 0,
      lastFixAt: stats?.lastDeviceAt ?? null,
      lastAccuracy: stats?.lastAccuracyM ?? null,
      queuedEvents: counts.events,
      queuedPings: counts.pings,
      lastSyncAt: await kvGet('last_sync_at'),
    });
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const captureTestFix = async () => {
    setBusy(true);
    setTestFix('locating…');
    const fix = await getFix(15000);
    setBusy(false);
    if (!fix) {
      setTestFix('No fix — GPS unavailable or permission denied.');
      return;
    }
    setTestFix(
      `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}  ±${Math.round(fix.accuracyM ?? 0)}m` +
        (fix.mocked ? '  ⚠ MOCKED' : ''),
    );
  };

  const ok = (b: boolean) => (b ? colors.primary : colors.danger);

  return (
    <Screen title="Tracking check" onBack={onBack}>
      <ScrollView contentContainerStyle={{ gap: spacing(1.5), paddingBottom: spacing(3) }}>
        <Card>
          <Text style={styles.section}>PERMISSIONS</Text>
          <Row label="Location while using" value={d?.fg ?? '…'} color={ok(d?.fg === 'granted')} />
          <Row
            label="Location always (background)"
            value={d?.bg ?? '…'}
            color={ok(d?.bg === 'granted')}
          />
          {d && d.bg !== 'granted' ? (
            <Text style={styles.warn}>
              Background not granted → tracking only works with the app open. Set location to
              &quot;Allow all the time&quot; in phone settings.
            </Text>
          ) : null}
        </Card>

        <Card>
          <Text style={styles.section}>THIS SHIFT</Text>
          <Row label="Clocked in" value={d?.hasShift ? 'yes' : 'no'} color={ok(!!d?.hasShift)} />
          <Row
            label="Tracking task running"
            value={d?.taskRunning ? 'yes' : 'no'}
            color={ok(!!d?.taskRunning)}
          />
          <Row label="Trail state" value={d?.trailState ?? '…'} />
          <Row label="Update interval" value={d ? `${d.intervalS}s` : '…'} />
          <Row label="Server shift linked" value={d?.serverShiftId ? 'yes' : 'not yet'} color={ok(!!d?.serverShiftId)} />
        </Card>

        <Card>
          <Text style={styles.section}>POINTS CAPTURED</Text>
          <Row label="Captured this shift" value={String(d?.captured ?? 0)} big />
          <Row label="Uploaded to server" value={String(d?.synced ?? 0)} />
          <Row label="Last fix" value={ago(d?.lastFixAt ?? null)} />
          {d?.lastAccuracy != null ? (
            <Row label="Last accuracy" value={`±${Math.round(d.lastAccuracy)}m`} />
          ) : null}
        </Card>

        <Card>
          <Text style={styles.section}>SYNC</Text>
          <Row label="Waiting to upload" value={`${d?.queuedEvents ?? 0} events, ${d?.queuedPings ?? 0} points`} />
          <Row label="Last sync" value={ago(d?.lastSyncAt ?? null)} />
        </Card>

        <Button title="Sync now" icon="cloud-upload-outline" onPress={() => void flush().then(load)} variant="subtle" />

        <Card>
          <Text style={styles.section}>TEST A GPS FIX</Text>
          <Text style={styles.testResult}>{testFix ?? 'Tap below to grab one location reading.'}</Text>
          <Button
            title="Capture a fix now"
            icon="locate-outline"
            onPress={captureTestFix}
            loading={busy}
            variant="subtle"
          />
        </Card>

        <Text style={styles.footNote}>
          Auto-refreshes every 5s. To confirm background tracking: clock in, lock the phone, walk a
          few minutes, then reopen — &quot;Captured this shift&quot; should have gone up.
        </Text>
      </ScrollView>
    </Screen>
  );
}

function Row({
  label,
  value,
  color,
  big,
}: {
  label: string;
  value: string;
  color?: string;
  big?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, big && styles.rowValueBig, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { color: colors.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 2, marginBottom: spacing(1) },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5 },
  rowLabel: { color: colors.textDim, fontSize: 15, flex: 1 },
  rowValue: { color: colors.text, fontSize: 15, fontWeight: '700' },
  rowValueBig: { fontSize: 24 },
  warn: { color: colors.warn, fontSize: 13, lineHeight: 18, marginTop: spacing(1) },
  testResult: { color: colors.text, fontSize: 15, marginBottom: spacing(1), fontVariant: ['tabular-nums'] },
  footNote: { color: colors.textFaint, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: spacing(1) },
});
