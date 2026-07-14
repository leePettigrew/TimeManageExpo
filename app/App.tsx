import 'react-native-get-random-values';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SessionProvider, useSession } from './src/state/session';
import { PhoneLoginScreen } from './src/screens/PhoneLoginScreen';
import { OtpScreen } from './src/screens/OtpScreen';
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

  useEffect(() => {
    if (phase === 'ready') startSyncTriggers();
    if (phase === 'signedOut') setOtpPhone(null);
  }, [phase]);

  switch (phase) {
    case 'loading':
      return (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      );
    case 'signedOut':
      return otpPhone ? (
        <OtpScreen phone={otpPhone} onBack={() => setOtpPhone(null)} />
      ) : (
        <PhoneLoginScreen onCodeSent={setOtpPhone} />
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

export default function App() {
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
