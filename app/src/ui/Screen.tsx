import React from 'react';
import {
  SafeAreaView,
  StyleSheet,
  View,
  Text,
  KeyboardAvoidingView,
  Platform,
  Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, type } from './theme';

interface Props {
  title?: string;
  onBack?: () => void;
  children: React.ReactNode;
}

export function Screen({ title, onBack, children }: Props) {
  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <View style={styles.body}>
          {title || onBack ? (
            <View style={styles.header}>
              {onBack ? (
                <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
                  <Ionicons name="chevron-back" size={26} color={colors.text} />
                </Pressable>
              ) : null}
              {title ? <Text style={type.title}>{title}</Text> : null}
            </View>
          ) : null}
          {children}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** Small rounded status chip. */
export function Chip({
  label,
  tone = 'dim',
  icon,
}: {
  label: string;
  tone?: 'ok' | 'warn' | 'info' | 'danger' | 'dim';
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  const tones = {
    ok: { bg: colors.primaryDim, fg: colors.primary },
    warn: { bg: colors.warnDim, fg: colors.warn },
    info: { bg: colors.infoDim, fg: colors.info },
    danger: { bg: colors.dangerDim, fg: colors.danger },
    dim: { bg: colors.card, fg: colors.textDim },
  }[tone];
  return (
    <View style={[styles.chip, { backgroundColor: tones.bg }]}>
      {icon ? <Ionicons name={icon} size={13} color={tones.fg} /> : null}
      <Text style={[styles.chipLabel, { color: tones.fg }]}>{label}</Text>
    </View>
  );
}

/** Card container with the standard surface treatment. */
export function Card({ children, active = false }: { children: React.ReactNode; active?: boolean }) {
  return <View style={[styles.card, active && styles.cardActive]}>{children}</View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  body: { flex: 1, padding: spacing(2.5), gap: spacing(2), paddingTop: spacing(3) },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing(1), minHeight: 36 },
  back: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipLabel: { fontSize: 13, fontWeight: '600' },
  card: {
    backgroundColor: colors.card,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing(3),
  },
  cardActive: { borderColor: colors.primary },
});
