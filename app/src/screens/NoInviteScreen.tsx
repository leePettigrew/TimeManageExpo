import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { Screen } from '../ui/Screen';
import { Button } from '../ui/Button';
import { colors } from '../ui/theme';
import { useSession } from '../state/session';

export function NoInviteScreen() {
  const { retry, signOut } = useSession();
  return (
    <Screen title="Almost there">
      <Text style={styles.body}>
        Your number isn&apos;t registered with any employer yet. Ask your boss to add your mobile
        number in their dashboard, then tap the button below.
      </Text>
      <Button title="Check again" onPress={retry} />
      <Button title="Use a different number" onPress={() => void signOut()} variant="ghost" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { color: colors.text, fontSize: 17, lineHeight: 25 },
});
