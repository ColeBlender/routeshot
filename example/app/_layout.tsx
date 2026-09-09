import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Linking } from 'react-native';
import { useRouteshotUpdateOverride } from 'routeshot/expo';

export default function RootLayout() {
  // Picks up `routeshotexample://routeshot/update?url=...` and points expo-updates at that
  // update group. Without the deep link it does nothing, so it is safe to leave in every build.
  useRouteshotUpdateOverride({ useEffect, Linking });

  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerTintColor: '#11161d' }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Home' }} />
        <Stack.Screen name="items/[id]" options={{ title: 'Item' }} />
        <Stack.Screen name="about" options={{ title: 'About' }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Quick actions' }} />
      </Stack>
    </>
  );
}
