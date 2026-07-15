import React from 'react';
import { Text, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen, Card } from '../ui/Screen';
import { Button } from '../ui/Button';
import { colors, spacing } from '../ui/theme';
import { useSession } from '../state/session';

export function NoInviteScreen() {
  const { retry, signOut } = useSession();
  return (
    <Screen title="Almost there">
      <Card>
        <View style={styles.iconRow}>
          <Ionicons name="person-add-outline" size={28} color={colors.info} />
        </View>
        <Text style={styles.body}>
          Your number isn&apos;t registered with an employer yet.{'\n\n'}
          Ask your boss to add your mobile number in their dashboard, then come back and tap the
          button below.
        </Text>
      </Card>
      <Button title="Check again" icon="refresh-outline" onPress={retry} />
      <Button title="Use a different number" onPress={() => void signOut()} variant="ghost" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  iconRow: { marginBottom: spacing(1.5) },
  body: { color: colors.text, fontSize: 17, lineHeight: 25 },
});
