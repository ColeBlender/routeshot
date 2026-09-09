import { Link, Stack } from 'expo-router';
import { Pressable } from 'react-native';

import { Button, Screen, Subtitle, Title } from '@/components/ui';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <Screen>
        <Title>Not found</Title>
        <Subtitle>This route does not exist in the example app.</Subtitle>
        <Link href="/" asChild>
          <Pressable>
            <Button label="Go to home" />
          </Pressable>
        </Link>
      </Screen>
    </>
  );
}
