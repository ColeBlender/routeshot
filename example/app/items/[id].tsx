import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Card, Row, Screen, Subtitle, Title } from '@/components/ui';
import { isBroken } from '@/lib/scenario';
import { colors, spacing } from '@/lib/theme';

const DETAILS: Record<string, { name: string; distance: string; surface: string }> = {
  '42': { name: 'Sunset Ridge', distance: '18.4 km', surface: 'Gravel' },
  '7': { name: 'Harbour Loop', distance: '12.6 km', surface: 'Paved' },
  '13': { name: 'Old Mill Crossing', distance: '15.2 km', surface: 'Mixed' },
};

export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const detail = DETAILS[id] ?? { name: 'Unknown route', distance: 'n/a', surface: 'n/a' };

  // broken: an early return renders a blank white screen instead of the detail.
  if (isBroken) {
    return <View style={styles.blank} />;
  }

  return (
    <Screen>
      <Title>{detail.name}</Title>
      <Subtitle>
        Item {id}. Dynamic routes need a param, which routeshot.config.ts supplies.
      </Subtitle>

      <Card>
        <Row label="Identifier" value={id} />
        <Row label="Distance" value={detail.distance} />
        <Row label="Surface" value={detail.surface} />
        <Row label="Status" value="Published" />
      </Card>

      <Text style={styles.footnote}>Saved to the Northwest region collection.</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  blank: { flex: 1, backgroundColor: '#ffffff' },
  footnote: { fontSize: 13, color: colors.muted, marginTop: spacing.md },
});
