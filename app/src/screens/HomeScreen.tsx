import React, { useCallback, useEffect, useState } from 'react';
import { Text, View, StyleSheet, Alert, Platform, Linking } from 'react-native';
import * as Device from 'expo-device';
import { Screen } from '../ui/Screen';
import { Button } from '../ui/Button';
import { colors, spacing } from '../ui/theme';
import { useSession } from '../state/session';
import { clockIn, clockOut, getLocalShift, reconcileWithServer, refreshLocalShiftFromOutbox, LocalShift } from '../lib/shift';
import { flush, onSyncStatus, SyncStatus } from '../lib/sync';
import { pendingCounts, kvGet } from '../lib/outbox';
import { TeamScreen } from './TeamScreen';

function batteryAdvice(): string {
  const brand = (Device.manufacturer ?? '').toLowerCase();
  if (brand.includes('samsung')) {
    return 'Samsung: Settings → Battery → Background usage limits → make sure this app is NOT in "Sleeping apps", and add it to "Never sleeping apps".';
  }
  if (brand.includes('xiaomi') || brand.includes('redmi') || brand.includes('poco')) {
    return 'Xiaomi: enable "Autostart" for this app and set Battery saver to "No restrictions" in App settings.';
  }
  if (brand.includes('huawei')) {
    return 'Huawei: App launch → set this app to "Manage manually" and allow all three options.';
  }
  return 'Open your phone settings and set this app’s battery usage to "Unrestricted" so tracking isn’t stopped mid-shift.';
}

function fmtDuration(fromIso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(fromIso).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function HomeScreen() {
  const { profile, signOut } = useSession();
  const [shift, setShift] = useState<LocalShift | null>(null);
  const [busy, setBusy] = useState(false);
  const [showTeam, setShowTeam] = useState(false);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [pending, setPending] = useState({ events: 0, pings: 0 });
  const [trail, setTrail] = useState<string>('off');
  const [showBatteryHelp, setShowBatteryHelp] = useState(false);
  const [, forceTick] = useState(0);

  const refresh = useCallback(async () => {
    await refreshLocalShiftFromOutbox();
    setShift(await getLocalShift());
    setPending(await pendingCounts());
    setTrail((await kvGet('breadcrumbs_state')) ?? 'off');
  }, []);

  useEffect(() => {
    void refresh();
    void reconcileWithServer().then(() => refresh());
    const unsub = onSyncStatus((s) => {
      setSync(s);
      if (!s.running) void refresh();
    });
    const timer = setInterval(() => forceTick((n) => n + 1), 30_000); // live duration
    return () => {
      unsub();
      clearInterval(timer);
    };
  }, [refresh]);

  const doClockIn = async () => {
    setBusy(true);
    try {
      await clockIn();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const doClockOut = () => {
    Alert.alert('Clock out?', 'This ends your shift and stops location tracking.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clock out',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await clockOut();
            await refresh();
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const offline = sync?.lastResult === 'offline';
  const queued = pending.events + pending.pings;

  if (showTeam) {
    return <TeamScreen onBack={() => setShowTeam(false)} />;
  }

  return (
    <Screen>
      <Text style={styles.greeting}>{profile?.full_name || 'Worker'}</Text>

      <View style={[styles.card, shift ? styles.cardActive : null]}>
        <Text style={styles.cardLabel}>{shift ? 'CLOCKED IN' : 'OFF THE CLOCK'}</Text>
        {shift ? (
          <>
            <Text style={styles.duration}>{fmtDuration(shift.startedAt)}</Text>
            <Text style={styles.since}>
              since{' '}
              {new Date(shift.startedAt).toLocaleTimeString('en-IE', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </Text>
            {trail === 'on' ? (
              <Text style={styles.trackNote}>Location tracking is ON while clocked in</Text>
            ) : (
              <Text style={styles.trackWarn}>
                Route tracking is off ({trail === 'denied' ? 'permission needed' : 'unavailable'}) —
                only clock times are recorded
              </Text>
            )}
          </>
        ) : (
          <Text style={styles.since}>Location tracking is OFF</Text>
        )}
      </View>

      {shift && trail === 'denied' ? (
        <Button
          title="Enable location permission"
          onPress={() => void Linking.openSettings()}
          variant="ghost"
        />
      ) : null}

      {shift && Platform.OS === 'android' ? (
        <View>
          <Text style={styles.helpLink} onPress={() => setShowBatteryHelp((v) => !v)}>
            {showBatteryHelp ? '▾' : '▸'} Tracking stops by itself? Phone battery settings
          </Text>
          {showBatteryHelp ? (
            <View style={styles.helpBox}>
              <Text style={styles.helpText}>{batteryAdvice()}</Text>
              <Button
                title="Open app settings"
                onPress={() => void Linking.openSettings()}
                variant="ghost"
              />
            </View>
          ) : null}
        </View>
      ) : null}

      {shift ? (
        <Button title="Clock out" onPress={doClockOut} variant="danger" loading={busy} />
      ) : (
        <Button title="Clock in" onPress={doClockIn} loading={busy} />
      )}

      <View style={styles.statusRow}>
        {offline ? <Text style={styles.badgeWarn}>⚠ No signal — saving on phone</Text> : null}
        {queued > 0 ? (
          <Text style={styles.badgeInfo}>
            {queued} item{queued === 1 ? '' : 's'} waiting to send
          </Text>
        ) : sync?.lastSyncAt ? (
          <Text style={styles.badgeOk}>
            ✓ Up to date{' '}
            {sync.lastSyncAt.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' })}
          </Text>
        ) : null}
      </View>

      {queued > 0 ? (
        <Button title="Send now" onPress={() => void flush()} variant="ghost" />
      ) : null}

      <View style={styles.footer}>
        {profile?.role === 'manager' ? (
          <Button title="Team" onPress={() => setShowTeam(true)} variant="ghost" style={{ marginBottom: 8 }} />
        ) : null}
        <Button title="Sign out" onPress={() => confirmSignOut(signOut, queued)} variant="ghost" />
      </View>
    </Screen>
  );
}

function confirmSignOut(signOut: () => Promise<void>, queued: number) {
  Alert.alert(
    'Sign out?',
    queued > 0
      ? `${queued} unsent item(s) will be lost. Connect to the internet and let them send first.`
      : 'You will need a new text-message code to sign back in.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
    ],
  );
}

const styles = StyleSheet.create({
  greeting: { color: colors.textDim, fontSize: 18 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing(3),
    alignItems: 'center',
    gap: spacing(1),
  },
  cardActive: { borderColor: colors.primary },
  cardLabel: { color: colors.textDim, fontSize: 14, fontWeight: '700', letterSpacing: 2 },
  duration: { color: colors.text, fontSize: 48, fontWeight: '800' },
  since: { color: colors.textDim, fontSize: 16 },
  trackNote: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  trackWarn: { color: colors.warn, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  helpLink: { color: colors.info, fontSize: 15, paddingVertical: 4 },
  helpBox: { gap: 8, paddingTop: 4 },
  helpText: { color: colors.textDim, fontSize: 14, lineHeight: 20 },
  statusRow: { alignItems: 'center', gap: spacing(1) },
  badgeWarn: { color: colors.warn, fontSize: 15, fontWeight: '600' },
  badgeInfo: { color: colors.info, fontSize: 15 },
  badgeOk: { color: colors.textDim, fontSize: 14 },
  footer: { flex: 1, justifyContent: 'flex-end' },
});
