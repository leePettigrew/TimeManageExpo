import React, { useState } from 'react';
import { Text, TextInput, StyleSheet } from 'react-native';
import { Screen } from '../ui/Screen';
import { Button } from '../ui/Button';
import { colors, radius, spacing } from '../ui/theme';
import { supabase } from '../lib/supabase';
import { friendlyAuthError } from '../lib/friendlyError';

export function OtpScreen({ phone, onBack }: { phone: string; onBack: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

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
    if (err) setError(friendlyAuthError(err));
    // success: onAuthStateChange in SessionProvider takes it from here
  };

  return (
    <Screen title="Enter code" onBack={onBack}>
      <Text style={styles.hint}>We sent a 6-digit code to {phone}.</Text>
      <TextInput
        style={[styles.input, focused && styles.inputFocused]}
        placeholder="••••••"
        placeholderTextColor={colors.textFaint}
        keyboardType="number-pad"
        autoFocus
        maxLength={6}
        value={code}
        onChangeText={(t) => {
          setCode(t);
          if (error) setError(null);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={submit}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button title="Verify" icon="lock-open-outline" onPress={submit} loading={busy} />
      <Button title="Use a different number" onPress={onBack} variant="ghost" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hint: { color: colors.textDim, fontSize: 16, lineHeight: 22 },
  input: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 30,
    letterSpacing: 12,
    textAlign: 'center',
    padding: spacing(2),
  },
  inputFocused: { borderColor: colors.primary },
  error: { color: colors.danger, fontSize: 15, lineHeight: 21 },
});
