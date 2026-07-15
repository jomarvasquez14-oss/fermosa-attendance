import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '@/lib/auth';
import { KioskProvider, useKiosk } from '@/lib/kiosk';

SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { session, loading } = useAuth();
  const { kiosk } = useKiosk();

  useEffect(() => {
    if (!loading) SplashScreen.hideAsync();
  }, [loading]);

  if (loading) return null;

  const kioskMode = !!kiosk;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={kioskMode}>
        <Stack.Screen name="kiosk" />
      </Stack.Protected>
      <Stack.Protected guard={!kioskMode && !!session}>
        <Stack.Screen name="index" />
        <Stack.Screen name="selfie" />
        <Stack.Screen name="leave" />
        <Stack.Screen name="change-password" />
        <Stack.Screen name="kiosk-setup" />
      </Stack.Protected>
      <Stack.Protected guard={!kioskMode && !session}>
        <Stack.Screen name="login" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <KioskProvider>
        <StatusBar style="auto" />
        <RootNavigator />
      </KioskProvider>
    </AuthProvider>
  );
}
