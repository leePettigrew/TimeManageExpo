import React, { useState } from 'react';
import { Text, TextInput, StyleSheet } from 'react-native';
import { Screen } from '../ui/Screen';
import { Button } from '../ui/Button';
import { colors, spacing } from '../ui/theme';
import { supabase } from '../lib/supabase';

// Irish mobiles: 08x xxx xxxx → +353 8x xxx xxxx
export function normalisePhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, '');
  if (/^\+353\d{9}$/.test(digits)) return digits;
  if (/^353\d{9}$/.test(digits)) return `+${digits}`;
  if (/^08\d{8}$/.test(digits)) return `+353${digits.slice(1)}`;
  return null;
}

export function PhoneLoginScreen({ onCodeSent }: { onCodeSent: (phone: string) => void }) {
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const phone = normalisePhone(raw);
    if (!phone) {
      setError('Enter an Irish mobile number, e.g. 087 123 4567');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({ phone });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    onCodeSent(phone);
  };

  return (
    <Screen title="Sign in">
      <Text style={styles.hint}>
        Enter the mobile number your employer registered. We&apos;ll text you a code.
      </Text>
      <TextInput
        style={styles.input}
        placeholder="087 123 4567"
        placeholderTextColor={colors.textDim}
        keyboardType="phone-pad"
        autoFocus
        value={raw}
        onChangeText={setRaw}
        onSubmitEditing={submit}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button title="Text me a code" onPress={submit} loading={busy} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hint: { color: colors.textDim, fontSize: 16, lineHeight: 22 },
  input: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 22,
    padding: spacing(2),
  },
  error: { color: colors.danger, fontSize: 15 },
});
