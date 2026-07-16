// Foolproof "turn on location" flow. When background/precise location isn't
// granted, this walks the worker through it in plain steps and drops them
// straight onto the phone's settings page, then re-checks.
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen, Card } from '../ui/Screen';
import { Button } from '../ui/Button';
import { colors, spacing } from '../ui/theme';
import { openAppSettings } from '../lib/batteryReliability';
import { startBreadcrumbs, BreadcrumbState } from '../lib/breadcrumbs';
import { kvSet } from '../lib/outbox';

const ANDROID_STEPS = [
  'Tap "Open location settings" below',
  'Tap Permissions → Location',
  'Choose "Allow all the time"',
  'Turn ON "Use precise location"',
  'Come back here and tap "Check again"',
];

const IOS_STEPS = [
  'Tap "Open location settings" below',
  'Tap Location',
  'Choose "Always"',
  'Turn ON "Precise Location"',
  'Come back here and tap "Check again"',
];

export function LocationHelpScreen({ onBack }: { onBack: () => void }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<BreadcrumbState | null>(null);
  const steps = Platform.OS === 'ios' ? IOS_STEPS : ANDROID_STEPS;

  const recheck = async () => {
    setChecking(true);
    try {
      const state = await startBreadcrumbs().catch(() => 'off' as const);
      await kvSet('breadcrumbs_state', state);
      setResult(state);
      if (state === 'on') setTimeout(onBack, 1200);
    } finally {
      setChecking(false);
    }
  };

  return (
    <Screen title="Turn on location" onBack={onBack}>
      <ScrollView contentContainerStyle={{ gap: spacing(2), paddingBottom: spacing(3) }}>
        <Card>
          <View style={styles.iconRow}>
            <Ionicons name="navigate-circle-outline" size={30} color={colors.info} />
            <Text style={styles.lead}>
              Your shift can only track your route if location is set to{' '}
              <Text style={styles.strong}>Allow all the time</Text> and{' '}
              <Text style={styles.strong}>Precise</Text>.
            </Text>
          </View>
        </Card>

        <Card>
          {steps.map((s, i) => (
            <View key={i} style={styles.step}>
              <View style={styles.stepNum}>
                <Text style={styles.stepNumText}>{i + 1}</Text>
              </View>
              <Text style={styles.stepText}>{s}</Text>
            </View>
          ))}
        </Card>

        {result === 'on' ? (
          <Text style={styles.ok}>✓ Location is on — tracking your shift now.</Text>
        ) : result === 'denied' ? (
          <Text style={styles.warn}>
            Still not fully granted. Make sure you chose &quot;Allow all the time&quot; (not just
            &quot;While using&quot;) and turned on precise location.
          </Text>
        ) : null}

        <Button title="Open location settings" icon="location-outline" onPress={() => void openAppSettings()} />
        <Button title="Check again" icon="refresh-outline" onPress={recheck} loading={checking} variant="subtle" />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  iconRow: { flexDirection: 'row', gap: spacing(1.5), alignItems: 'flex-start' },
  lead: { flex: 1, color: colors.text, fontSize: 16, lineHeight: 23 },
  strong: { fontWeight: '800', color: colors.primary },
  step: { flexDirection: 'row', alignItems: 'center', gap: spacing(1.5), paddingVertical: 8 },
  stepNum: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: colors.infoDim,
    alignItems: 'center', justifyContent: 'center',
  },
  stepNumText: { color: colors.info, fontWeight: '800', fontSize: 14 },
  stepText: { flex: 1, color: colors.text, fontSize: 16, lineHeight: 22 },
  ok: { color: colors.primary, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  warn: { color: colors.warn, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  iconRowSingle: {},
});
