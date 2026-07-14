import React, { useState } from 'react';
import { Text, TextInput, StyleSheet } from 'react-native';
import { Screen } from '../ui/Screen';
import { Button } from '../ui/Button';
import { colors, spacing } from '../ui/theme';
import { supabase } from '../lib/supabase';

export function OtpScreen({ phone, onBack }: { phone: string; onBack: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (code.trim().length < 6) {
      setError('Enter the 6-digit code from the text message');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.verifyOtp({
      phone,
      token: code.trim(),
      type: 'sms',
    });
    setBusy(false);
    if (err) setError('Wrong or expired code — try again.');
    // success: onAuthStateChange in SessionProvider takes it from here
  };

  return (
    <Screen title="Enter code">
      <Text style={styles.hint}>We sent a 6-digit code to {phone}.</Text>
      <TextInput
        style={styles.input}
        placeholder="123456"
        placeholderTextColor={colors.textDim}
        keyboardType="number-pad"
        autoFocus
        maxLength={6}
        value={code}
        onChangeText={setCode}
        onSubmitEditing={submit}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button title="Verify" onPress={submit} loading={busy} />
      <Button title="Different number" onPress={onBack} variant="ghost" />
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
    fontSize: 28,
    letterSpacing: 8,
    textAlign: 'center',
    padding: spacing(2),
  },
  error: { color: colors.danger, fontSize: 15 },
});
