import { router } from 'expo-router';
import { Pressable } from 'react-native';

import { Button, Card, Row, Screen, Subtitle, Title } from '@/components/ui';

export default function ModalScreen() {
  return (
    <Screen>
      <Title>Quick actions</Title>
      <Subtitle>Presented as a modal from the root stack.</Subtitle>

      <Card>
        <Row label="Start a new route" />
        <Row label="Import from a file" />
        <Row label="Share the current region" />
      </Card>

      <Pressable onPress={() => router.back()}>
        <Button label="Close" />
      </Pressable>
    </Screen>
  );
}
