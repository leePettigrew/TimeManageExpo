import React, { useState } from 'react';
import { Text, TextInput, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../ui/Screen';
import { Button } from '../ui/Button';
import { colors, radius, spacing } from '../ui/theme';
import { supabase } from '../lib/supabase';
import { friendlyAuthError } from '../lib/friendlyError';

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
  const [focused, setFocused] = useState(false);

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
      setError(friendlyAuthError(err));
      return;
    }
    onCodeSent(phone);
  };

  return (
    <Screen>
      <View style={styles.brandBlock}>
        <View style={styles.brandMark}>
          <Ionicons name="checkmark" size={40} color={colors.onPrimary} />
        </View>
        <Text style={styles.brandName}>TimeTable</Text>
        <Text style={styles.tagline}>Clock in. Get paid right.</Text>
      </View>

      <Text style={styles.label}>Your mobile number</Text>
      <TextInput
        style={[styles.input, focused && styles.inputFocused]}
        placeholder="087 123 4567"
        placeholderTextColor={colors.textFaint}
        keyboardType="phone-pad"
        autoFocus
        value={raw}
        onChangeText={(t) => {
          setRaw(t);
          if (error) setError(null);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={submit}
      />
      <Text style={styles.hint}>Use the number your employer registered — we'll text you a code.</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button title="Text me a code" icon="chatbubble-ellipses-outline" onPress={submit} loading={busy} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  brandBlock: { alignItems: 'center', gap: spacing(1), marginTop: spacing(6), marginBottom: spacing(4) },
  brandMark: {
    width: 76,
    height: 76,
    borderRadius: 24,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandName: { color: colors.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  tagline: { color: colors.textDim, fontSize: 15 },
  label: { color: colors.textDim, fontSize: 14, fontWeight: '600' },
  input: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 22,
    padding: spacing(2),
  },
  inputFocused: { borderColor: colors.primary },
  hint: { color: colors.textFaint, fontSize: 13, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 15, lineHeight: 21 },
});
