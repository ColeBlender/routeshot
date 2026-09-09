import { Tabs } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import type { ColorValue } from 'react-native';

import { colors } from '@/lib/theme';

/**
 * Plain View icons rather than an icon font: one less dependency, and a shape that renders
 * identically on every run. A font icon that has not loaded yet is a classic capture flake.
 */
function TabIcon({ color, shape }: { color: ColorValue; shape: 'circle' | 'square' | 'diamond' }) {
  return <View style={[styles.icon, styles[shape], { backgroundColor: color }]} />;
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        headerTintColor: colors.text,
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => <TabIcon color={color} shape="circle" />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Explore',
          tabBarIcon: ({ color }) => <TabIcon color={color} shape="diamond" />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          headerShown: false,
          tabBarIcon: ({ color }) => <TabIcon color={color} shape="square" />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  icon: { width: 20, height: 20 },
  circle: { borderRadius: 10 },
  square: { borderRadius: 4 },
  diamond: { borderRadius: 3, transform: [{ rotate: '45deg' }] },
});
