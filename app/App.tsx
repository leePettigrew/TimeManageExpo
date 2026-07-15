import 'react-native-get-random-values';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Updates from 'expo-updates';
import { SessionProvider, useSession } from './src/state/session';
import { PhoneLoginScreen } from './src/screens/PhoneLoginScreen';
import { OtpScreen } from './src/screens/OtpScreen';
import { InviteCodeScreen } from './src/screens/InviteCodeScreen';
import { NoInviteScreen } from './src/screens/NoInviteScreen';
import { DisclosureScreen } from './src/screens/DisclosureScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { Screen } from './src/ui/Screen';
import { Button } from './src/ui/Button';
import { colors } from './src/ui/theme';
import { startSyncTriggers } from './src/lib/sync';

function Router() {
  const { phase, errorMessage, retry } = useSession();
  const [otpPhone, setOtpPhone] = useState<string | null>(null);
  const [authView, setAuthView] = useState<'phone' | 'code'>('phone');

  useEffect(() => {
    if (phase === 'ready') startSyncTriggers();
    if (phase === 'signedOut') {
      setOtpPhone(null);
      setAuthView('phone');
    }
  }, [phase]);

  switch (phase) {
    case 'loading':
      return (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      );
    case 'signedOut':
      if (authView === 'code') return <InviteCodeScreen onBack={() => setAuthView('phone')} />;
      return otpPhone ? (
        <OtpScreen phone={otpPhone} onBack={() => setOtpPhone(null)} />
      ) : (
        <PhoneLoginScreen onCodeSent={setOtpPhone} onUseInviteCode={() => setAuthView('code')} />
      );
    case 'needsInvite':
      return <NoInviteScreen />;
    case 'needsAck':
      return <DisclosureScreen />;
    case 'ready':
      return <HomeScreen />;
    case 'error':
      return (
        <Screen title="Something went wrong">
          <Text style={styles.error}>{errorMessage ?? 'Unknown error'}</Text>
          <Button title="Try again" onPress={retry} />
        </Screen>
      );
  }
}

// Check for an over-the-air update on launch and apply it silently next time.
// Wrapped so a failure (offline, dev build) never blocks the app.
function useOtaUpdates() {
  useEffect(() => {
    if (__DEV__) return;
    (async () => {
      try {
        const result = await Updates.checkForUpdateAsync();
        if (result.isAvailable) {
          await Updates.fetchUpdateAsync();
          // applied on next cold start — never interrupt a worker mid-shift
        }
      } catch {
        /* offline or no update server — ignore */
      }
    })();
  }, []);
}

export default function App() {
  useOtaUpdates();
  return (
    <SessionProvider>
      <StatusBar style="light" />
      <Router />
    </SessionProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  error: { color: colors.text, fontSize: 16 },
});
