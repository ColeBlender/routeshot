import { Link } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Card, Row, Screen, Subtitle, Title } from '@/components/ui';
import { isBenign, isBroken } from '@/lib/scenario';

const ITEMS = [
  { id: '42', name: 'Sunset Ridge', detail: 'Route 42' },
  { id: '7', name: 'Harbour Loop', detail: 'Route 7' },
  { id: '13', name: 'Old Mill Crossing', detail: 'Route 13' },
];

export default function HomeScreen() {
  return (
    <Screen>
      {/* broken: a fixed-height clip box plus clip-mode truncation cuts the title mid-word. */}
      <View style={isBroken ? styles.clippedTitleBox : undefined}>
        <Title
          numberOfLines={isBroken ? 1 : undefined}
          ellipsizeMode={isBroken ? 'clip' : undefined}>
          Routeshot Example Application
        </Title>
      </View>

      <Subtitle>
        {isBenign
          ? 'Every route below is captured, diffed, and judged on each pull request.'
          : 'A small deterministic app used to exercise routeshot end to end.'}
      </Subtitle>

      <Card>
        {ITEMS.map((item) => (
          <Link key={item.id} href={`/items/${item.id}`} asChild>
            <Pressable>
              <Row label={item.name} value={item.detail} />
            </Pressable>
          </Link>
        ))}
      </Card>

      <Link href="/about" asChild>
        <Pressable>
          <Button label="About this app" tone="secondary" />
        </Pressable>
      </Link>

      <Link href="/modal" asChild>
        <Pressable>
          <Button label="Open quick actions" />
        </Pressable>
      </Link>
    </Screen>
  );
}

const styles = StyleSheet.create({
  clippedTitleBox: { height: 20, overflow: 'hidden' },
});
