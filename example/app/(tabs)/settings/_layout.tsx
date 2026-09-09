import { Stack } from 'expo-router';

import { colors } from '@/lib/theme';

/**
 * A stack nested inside a tab. `routeshotexample://settings/billing` on a cold app has to
 * restore Tabs -> Settings tab -> Billing, which is the hardest deep-link case routeshot tests.
 */
export default function SettingsLayout() {
  return (
    <Stack screenOptions={{ headerTintColor: colors.text }}>
      <Stack.Screen name="index" options={{ title: 'Settings' }} />
      <Stack.Screen name="billing" options={{ title: 'Billing' }} />
    </Stack>
  );
}
