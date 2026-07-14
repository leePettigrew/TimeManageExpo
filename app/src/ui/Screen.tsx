import React from 'react';
import { SafeAreaView, StyleSheet, View, Text, KeyboardAvoidingView, Platform } from 'react-native';
import { colors, spacing } from './theme';

export function Screen({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <View style={styles.body}>
          {title ? <Text style={styles.title}>{title}</Text> : null}
          {children}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  body: { flex: 1, padding: spacing(3), gap: spacing(2) },
  title: { fontSize: 28, fontWeight: '800', color: colors.text, marginBottom: spacing(1) },
});
