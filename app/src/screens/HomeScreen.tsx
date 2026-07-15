import React, { useCallback, useEffect, useState } from 'react';
import { Text, View, StyleSheet, Alert, Platform, Linking, Pressable, ScrollView } from 'react-native';
import * as Device from 'expo-device';
import { Ionicons } from '@expo/vector-icons';
import { Screen, Card, Chip } from '../ui/Screen';
import { Button } from '../ui/Button';
import { colors, spacing } from '../ui/theme';
import { useSession } from '../state/session';
import { clockIn, clockOut, getLocalShift, reconcileWithServer, refreshLocalShiftFromOutbox, LocalShift } from '../lib/shift';
import { flush, onSyncStatus, SyncStatus } from '../lib/sync';
import { pendingCounts, kvGet } from '../lib/outbox';
import { supabase } from '../lib/supabase';
import { TeamScreen } from './TeamScreen';
import { HoursScreen } from './HoursScreen';
import { DiagnosticsScreen } from './DiagnosticsScreen';
import { requestIgnoreBatteryOptimizations, openAppSettings } from '../lib/batteryReliability';

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
  const [view, setView] = useState<'home' | 'team' | 'hours' | 'diag'>('home');
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [pending, setPending] = useState({ events: 0, pings: 0 });
  const [trail, setTrail] = useState<string>('off');
  const [showBatteryHelp, setShowBatteryHelp] = useState(false);
  const [locationChecks, setLocationChecks] = useState(0);
  const [, forceTick] = useState(0);

  const refresh = useCallback(async () => {
    await refreshLocalShiftFromOutbox();
    setShift(await getLocalShift());
    setPending(await pendingCounts());
    setTrail((await kvGet('breadcrumbs_state')) ?? 'off');
    // transparency: workers see when their location was checked (best effort)
    try {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      const { data } = await supabase
        .from('location_requests')
        .select('id')
        .gte('created_at', midnight.toISOString());
      setLocationChecks(data?.length ?? 0);
    } catch {
      /* offline — keep last value */
    }
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

  if (view === 'team') return <TeamScreen onBack={() => setView('home')} />;
  if (view === 'hours') return <HoursScreen onBack={() => setView('home')} />;
  if (view === 'diag') return <DiagnosticsScreen onBack={() => setView('home')} />;

  const offline = sync?.lastResult === 'offline';
  const queued = pending.events + pending.pings;
  const firstName = (profile?.full_name || 'there').split(/\s+/)[0];
  const today = new Date().toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <Screen>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.greeting}>Hi, {firstName}</Text>
          <Text style={styles.date}>{today}</Text>
        </View>
        {offline ? <Chip label="offline" tone="warn" icon="cloud-offline-outline" /> : null}
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Card active={!!shift}>
          <View style={styles.statusHead}>
            <Chip
              label={shift ? 'ON THE CLOCK' : 'OFF THE CLOCK'}
              tone={shift ? 'ok' : 'dim'}
              icon={shift ? 'time' : 'time-outline'}
            />
            {shift && trail === 'on' ? <Chip label="tracking" tone="ok" icon="navigate" /> : null}
            {shift && trail !== 'on' ? <Chip label="route off" tone="warn" icon="navigate-outline" /> : null}
          </View>
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
            </>
          ) : (
            <Text style={styles.restingNote}>Location tracking is off. Enjoy the quiet.</Text>
          )}
        </Card>

        {shift ? (
          <Button title="Clock out" icon="log-out-outline" onPress={doClockOut} variant="danger" loading={busy} />
        ) : (
          <Button title="Clock in" icon="log-in-outline" onPress={doClockIn} loading={busy} />
        )}

        <View style={styles.chipRow}>
          {queued > 0 ? (
            <Chip label={`${queued} waiting to send`} tone="info" icon="cloud-upload-outline" />
          ) : sync?.lastSyncAt ? (
            <Chip
              label={`up to date · ${sync.lastSyncAt.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' })}`}
              tone="dim"
              icon="checkmark-circle-outline"
            />
          ) : null}
          {locationChecks > 0 ? (
            <Chip label={`location checked ${locationChecks}× today`} tone="info" icon="locate-outline" />
          ) : null}
        </View>

        {queued > 0 ? (
          <>
            <Button
              title="Send now"
              icon="paper-plane-outline"
              onPress={() => void flush().then(refresh)}
              variant="subtle"
            />
            {sync?.lastResult === 'error' ? (
              <Text style={styles.syncNote}>
                Couldn&apos;t send — it&apos;ll keep trying automatically. See Tracking for details.
              </Text>
            ) : offline ? (
              <Text style={styles.syncNote}>No signal — these send automatically once you&apos;re back online.</Text>
            ) : (
              <Text style={styles.syncNote}>Sending automatically in the background…</Text>
            )}
          </>
        ) : null}

        {shift && trail === 'denied' ? (
          <Button
            title="Enable location permission"
            icon="settings-outline"
            onPress={() => void Linking.openSettings()}
            variant="subtle"
          />
        ) : null}

        {shift && Platform.OS === 'android' ? (
          <View style={styles.helpBlock}>
            <Pressable style={styles.helpToggle} onPress={() => setShowBatteryHelp((v) => !v)}>
              <Ionicons
                name={showBatteryHelp ? 'chevron-down' : 'chevron-forward'}
                size={16}
                color={colors.info}
              />
              <Text style={styles.helpLink}>Tracking stops by itself? Phone battery settings</Text>
            </Pressable>
            {showBatteryHelp ? (
              <View style={styles.helpBox}>
                <Text style={styles.helpText}>
                  Tap below to let tracking keep running when your phone is locked. Then:
                </Text>
                <Text style={styles.helpText}>{batteryAdvice()}</Text>
                <Button
                  title="Keep tracking when locked"
                  icon="battery-charging-outline"
                  onPress={() => void requestIgnoreBatteryOptimizations()}
                />
                <Button
                  title="Open app settings"
                  icon="settings-outline"
                  onPress={() => void openAppSettings()}
                  variant="ghost"
                />
              </View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        <FooterAction icon="stopwatch-outline" label="My hours" onPress={() => setView('hours')} />
        <FooterAction icon="pulse-outline" label="Tracking" onPress={() => setView('diag')} />
        {profile?.role === 'manager' ? (
          <FooterAction icon="people-outline" label="Team" onPress={() => setView('team')} />
        ) : null}
        <FooterAction
          icon="exit-outline"
          label="Sign out"
          onPress={() => confirmSignOut(signOut, queued)}
        />
      </View>
    </Screen>
  );
}

function FooterAction({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={({ pressed }) => [styles.footerBtn, pressed && { opacity: 0.7 }]} onPress={onPress}>
      <Ionicons name={icon} size={22} color={colors.textDim} />
      <Text style={styles.footerLabel}>{label}</Text>
    </Pressable>
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
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  greeting: { color: colors.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  date: { color: colors.textDim, fontSize: 14, marginTop: 2 },
  scroll: { gap: spacing(2), paddingBottom: spacing(2) },
  statusHead: { flexDirection: 'row', gap: spacing(1), marginBottom: spacing(1.5), flexWrap: 'wrap' },
  duration: { color: colors.text, fontSize: 54, fontWeight: '800', letterSpacing: -1.5 },
  since: { color: colors.textDim, fontSize: 15, marginTop: 2 },
  restingNote: { color: colors.textDim, fontSize: 15, marginTop: spacing(0.5) },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(1) },
  helpBlock: { gap: spacing(1) },
  helpToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  helpLink: { color: colors.info, fontSize: 14, fontWeight: '600' },
  helpBox: { gap: spacing(1) },
  helpText: { color: colors.textDim, fontSize: 14, lineHeight: 20 },
  syncNote: { color: colors.textDim, fontSize: 13, textAlign: 'center', lineHeight: 18 },
  footer: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing(1.5),
    justifyContent: 'space-around',
  },
  footerBtn: { alignItems: 'center', gap: 3, minWidth: 84 },
  footerLabel: { color: colors.textDim, fontSize: 12, fontWeight: '600' },
});
