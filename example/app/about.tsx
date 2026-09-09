import { StyleSheet, Text, View } from 'react-native';

import { Card, Row, Screen, Subtitle, Title } from '@/components/ui';
import { isBroken } from '@/lib/scenario';
import { colors, radius, spacing } from '@/lib/theme';

export default function AboutScreen() {
  // broken: the screen renders an error state instead of its content.
  if (isBroken) {
    return (
      <Screen>
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>Something went wrong</Text>
          <Text style={styles.errorBody}>This screen could not be loaded. Please try again.</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>About</Title>
      <Subtitle>
        A plain stack screen outside the tabs, reached by deep link or from the home screen.
      </Subtitle>

      <Card>
        <Row label="App" value="Routeshot Example" />
        <Row label="Version" value="1.0.0" />
        <Row label="Scheme" value="routeshotexample" />
        <Row label="Bundle id" value="dev.routeshot.example" />
      </Card>

      <Text style={styles.body}>
        Nothing on this screen changes between runs, so any pixel difference here means the change
        came from the code under test.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 14, lineHeight: 20, color: colors.muted, marginTop: spacing.md },
  errorBox: {
    backgroundColor: colors.dangerSurface,
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginTop: spacing.lg,
  },
  errorTitle: { fontSize: 20, fontWeight: '700', color: colors.danger },
  errorBody: { fontSize: 15, color: colors.danger, marginTop: spacing.sm },
});
