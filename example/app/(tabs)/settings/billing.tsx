import { StyleSheet, Text } from 'react-native';

import { Button, Card, Row, Screen, Subtitle, Title } from '@/components/ui';
import { isBroken } from '@/lib/scenario';
import { colors, spacing } from '@/lib/theme';

export default function BillingScreen() {
  return (
    <Screen>
      <Title>Billing</Title>
      <Subtitle>
        The cold deep-link target: tabs, then the settings stack, then this screen.
      </Subtitle>

      <Card>
        <Row label="Plan" value="Team" />
        <Row label="Seats" value="4" />
        <Row label="Amount" value="$96.00 per month" />
        <Row label="Next invoice" value="1 October 2026" />
      </Card>

      <Text style={styles.fineprint}>
        Charges are billed to the card on file at the start of each billing period.
      </Text>

      {/* broken: a huge top margin pushes the primary button below the visible viewport. */}
      <Button label="Update payment method" style={isBroken ? styles.pushedOffscreen : undefined} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  fineprint: { fontSize: 13, lineHeight: 18, color: colors.muted, marginTop: spacing.md },
  pushedOffscreen: { marginTop: 700 },
});
