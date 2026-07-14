import React, { useState } from 'react';
import { ScrollView, Text, StyleSheet } from 'react-native';
import { Screen } from '../ui/Screen';
import { Button } from '../ui/Button';
import { colors, spacing } from '../ui/theme';
import { useSession } from '../state/session';

// GDPR Art 13 transparency + Google Play "prominent disclosure". Shown before
// any OS location permission prompt. Play policy expects the exact phrase
// "even when the app is closed or not in use" for background collection.
export function DisclosureScreen() {
  const { acknowledge } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await acknowledge();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="How this app uses your location">
      <ScrollView style={styles.scroll} contentContainerStyle={{ gap: spacing(2) }}>
        <Text style={styles.body}>
          This app collects location data <Text style={styles.strong}>only between clock-in and
          clock-out</Text> to verify work hours and site attendance for your employer — even when
          the app is closed or not in use.
        </Text>
        <Text style={styles.body}>
          • Tracking <Text style={styles.strong}>starts</Text> when you clock in and{' '}
          <Text style={styles.strong}>stops completely</Text> when you clock out.{'\n'}
          • While tracking is on, your phone shows a visible notification.{'\n'}
          • Your employer can see your clock times, locations during shifts, and total hours.{'\n'}
          • Nobody can see your location outside working hours — the app does not collect it.
        </Text>
        <Text style={styles.body}>
          Location trails are kept for 90 days, then deleted automatically. Your total hours are
          kept for payroll. You can ask your employer for a copy of your data at any time.
        </Text>
        <Text style={styles.dim}>
          Legal basis: your employer&apos;s legitimate interest in verifying working time
          (GDPR Art 6(1)(f)). Tapping &quot;I understand&quot; records that this notice was shown
          to you — it is not a request for consent.
        </Text>
      </ScrollView>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button title="I understand" onPress={accept} loading={busy} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  body: { color: colors.text, fontSize: 17, lineHeight: 25 },
  strong: { fontWeight: '800' },
  dim: { color: colors.textDim, fontSize: 14, lineHeight: 20 },
  error: { color: colors.danger, fontSize: 15 },
});
