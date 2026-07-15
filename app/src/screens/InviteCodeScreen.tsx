import React, { useState } from 'react';
import { Text, TextInput, StyleSheet } from 'react-native';
import { Screen } from '../ui/Screen';
import { Button } from '../ui/Button';
import { colors, radius, spacing } from '../ui/theme';
import { useSession } from '../state/session';
import { normalisePhone } from './PhoneLoginScreen';

// SMS-free onboarding: worker types their number + the 6-digit code the boss
// reads off the dashboard. No text message involved.
export function InviteCodeScreen({ onBack }: { onBack: () => void }) {
  const { claimWithCode } = useSession();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const p = normalisePhone(phone);
    if (!p) {
      setError('Enter an Irish mobile number, e.g. 087 123 4567');
      return;
    }
    if (code.trim().length !== 6) {
      setError('Enter the 6-digit code your boss gave you');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await claimWithCode(p, code.trim());
      // success → session moves to the disclosure screen
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Join with a code" onBack={onBack}>
      <Text style={styles.hint}>Your boss gives you a 6-digit code. No text message needed.</Text>

      <Text style={styles.label}>Your mobile number</Text>
      <TextInput
        style={styles.input}
        placeholder="087 123 4567"
        placeholderTextColor={colors.textFaint}
        keyboardType="phone-pad"
        autoFocus
        value={phone}
        onChangeText={(t) => {
          setPhone(t);
          if (error) setError(null);
        }}
      />

      <Text style={styles.label}>Invite code</Text>
      <TextInput
        style={[styles.input, styles.codeInput]}
        placeholder="000000"
        placeholderTextColor={colors.textFaint}
        keyboardType="number-pad"
        maxLength={6}
        value={code}
        onChangeText={(t) => {
          setCode(t);
          if (error) setError(null);
        }}
        onSubmitEditing={submit}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button title="Join" icon="log-in-outline" onPress={submit} loading={busy} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hint: { color: colors.textDim, fontSize: 16, lineHeight: 22 },
  label: { color: colors.textDim, fontSize: 14, fontWeight: '600', marginTop: spacing(1) },
  input: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 22,
    padding: spacing(2),
  },
  codeInput: { fontSize: 28, letterSpacing: 10, textAlign: 'center' },
  error: { color: colors.danger, fontSize: 15, lineHeight: 21 },
});
