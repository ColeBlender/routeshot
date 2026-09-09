import { Image, StyleSheet, Text, View } from 'react-native';

import { Card, Row, Screen, Subtitle, Title } from '@/components/ui';
import { isBenign, isBroken } from '@/lib/scenario';
import { colors, radius, spacing } from '@/lib/theme';

/** benign: the accent used by the stats card changes. Different pixels, nothing wrong. */
const accent = isBenign ? '#0f9d58' : colors.accent;

export default function ExploreScreen() {
  return (
    <Screen>
      <Title>Explore</Title>
      <Subtitle>Static content only. No clocks, no random data, no network calls.</Subtitle>

      <View style={styles.hero}>
        <Image source={require('../../assets/images/icon.png')} style={styles.heroImage} />
        {/* broken: the badge is absolutely positioned on top of the caption below it. */}
        <Text style={[styles.heroCaption, isBroken && styles.heroCaptionOverlapped]}>
          Three saved routes in the Northwest region
        </Text>
        <View style={[styles.badge, { backgroundColor: accent }, isBroken && styles.badgeOverlap]}>
          <Text style={styles.badgeText}>Saved</Text>
        </View>
      </View>

      <Card>
        <Row label="Routes" value="3" />
        <Row label="Total distance" value="46.2 km" />
        <Row label="Elevation gain" value="1,180 m" />
      </Card>

      <View style={[styles.note, { borderLeftColor: accent }]}>
        <Text style={styles.noteText}>
          Screenshots are compared pixel for pixel, so anything that moves between runs would show
          up as a false positive.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    marginTop: spacing.md,
    alignItems: 'center',
  },
  heroImage: { width: 72, height: 72, borderRadius: radius.lg },
  heroCaption: {
    fontSize: 14,
    color: colors.muted,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  heroCaptionOverlapped: { marginTop: 0 },
  badge: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
  },
  badgeOverlap: { position: 'absolute', top: 96, left: spacing.lg, marginTop: 0 },
  badgeText: { color: colors.accentText, fontSize: 13, fontWeight: '600' },
  note: {
    marginTop: spacing.md,
    borderLeftWidth: 3,
    paddingLeft: spacing.md,
    paddingVertical: spacing.xs,
  },
  noteText: { fontSize: 14, lineHeight: 20, color: colors.muted },
});
