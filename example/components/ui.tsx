import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';

import { colors, radius, spacing } from '@/lib/theme';

type ScreenProps = { children: ReactNode; style?: StyleProp<ViewStyle> };

export function Screen({ children, style }: ScreenProps) {
  return <View style={[styles.screen, style]}>{children}</View>;
}

type TitleProps = {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  ellipsizeMode?: 'head' | 'middle' | 'tail' | 'clip';
};

export function Title({ children, style, numberOfLines, ellipsizeMode }: TitleProps) {
  return (
    <Text style={[styles.title, style]} numberOfLines={numberOfLines} ellipsizeMode={ellipsizeMode}>
      {children}
    </Text>
  );
}

export function Subtitle({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
}) {
  return <Text style={[styles.subtitle, style]}>{children}</Text>;
}

type CardProps = { children: ReactNode; style?: StyleProp<ViewStyle> };

export function Card({ children, style }: CardProps) {
  return <View style={[styles.card, style]}>{children}</View>;
}

type RowProps = { label: string; value?: string; style?: StyleProp<ViewStyle> };

export function Row({ label, value, style }: RowProps) {
  return (
    <View style={[styles.row, style]}>
      <Text style={styles.rowLabel}>{label}</Text>
      {value ? <Text style={styles.rowValue}>{value}</Text> : null}
    </View>
  );
}

type ButtonProps = { label: string; style?: StyleProp<ViewStyle>; tone?: 'primary' | 'secondary' };

/** Presentational only. Navigation is done by wrapping this in a `<Link asChild>`. */
export function Button({ label, style, tone = 'primary' }: ButtonProps) {
  const isPrimary = tone === 'primary';
  return (
    <View style={[styles.button, isPrimary ? styles.buttonPrimary : styles.buttonSecondary, style]}>
      <Text style={isPrimary ? styles.buttonPrimaryText : styles.buttonSecondaryText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
  },
  title: { fontSize: 28, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 15, lineHeight: 21, color: colors.muted, marginTop: spacing.sm },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm + 2,
  },
  rowLabel: { fontSize: 16, color: colors.text },
  rowValue: { fontSize: 15, color: colors.muted },
  button: {
    borderRadius: radius.sm,
    paddingVertical: spacing.sm + 4,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonSecondary: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  buttonPrimaryText: { color: colors.accentText, fontSize: 16, fontWeight: '600' },
  buttonSecondaryText: { color: colors.text, fontSize: 16, fontWeight: '600' },
});
