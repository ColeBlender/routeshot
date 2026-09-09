import { Link } from 'expo-router';
import { Pressable } from 'react-native';

import { Card, Row, Screen, Subtitle, Title } from '@/components/ui';
import { isBenign } from '@/lib/scenario';

const BASE_ROWS = [
  { label: 'Account', value: 'cole@example.dev' },
  { label: 'Notifications', value: 'On' },
  { label: 'Appearance', value: 'Light' },
  { label: 'Units', value: 'Metric' },
];

/** benign: the same rows in a different order. Real diff, nothing broken. */
const ROWS = isBenign ? [...BASE_ROWS].reverse() : BASE_ROWS;

export default function SettingsScreen() {
  return (
    <Screen>
      <Title>Settings</Title>
      <Subtitle>Billing lives one level deeper, inside this tab's own stack.</Subtitle>

      <Card>
        {ROWS.map((row) => (
          <Row key={row.label} label={row.label} value={row.value} />
        ))}
        <Link href="/settings/billing" asChild>
          <Pressable>
            <Row label="Billing" value="Team plan" />
          </Pressable>
        </Link>
      </Card>
    </Screen>
  );
}
