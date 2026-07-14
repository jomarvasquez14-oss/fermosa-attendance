import {
  createContext,
  useCallback,
  useContext,
  useState,
  type PropsWithChildren,
} from 'react';
import type { PunchType } from '@fermosa/shared';
import { kvGetSync, kvRemoveSync, kvSetSync } from './db';

/**
 * Kiosk mode: this device is a shared branch terminal. The registration key
 * lives only on this device; every punch is verified server-side by the
 * kiosk-punch Edge Function (device key + employee PIN).
 */

export interface KioskConfig {
  device_id: string;
  device_key: string;
  branch_id: string;
  branch_name: string;
  device_name: string;
}

const KIOSK_KEY = 'fermosa.kiosk.config';

function readConfig(): KioskConfig | null {
  const raw = kvGetSync(KIOSK_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as KioskConfig;
  } catch {
    return null;
  }
}

interface KioskState {
  kiosk: KioskConfig | null;
  activateKiosk: (config: KioskConfig) => void;
  deactivateKiosk: () => void;
}

const KioskContext = createContext<KioskState>({
  kiosk: null,
  activateKiosk: () => {},
  deactivateKiosk: () => {},
});

export function KioskProvider({ children }: PropsWithChildren) {
  const [kiosk, setKiosk] = useState<KioskConfig | null>(() => readConfig());

  const activateKiosk = useCallback((config: KioskConfig) => {
    kvSetSync(KIOSK_KEY, JSON.stringify(config));
    setKiosk(config);
  }, []);

  const deactivateKiosk = useCallback(() => {
    kvRemoveSync(KIOSK_KEY);
    setKiosk(null);
  }, []);

  return (
    <KioskContext.Provider value={{ kiosk, activateKiosk, deactivateKiosk }}>
      {children}
    </KioskContext.Provider>
  );
}

export const useKiosk = () => useContext(KioskContext);

export interface KioskPunchResult {
  ok: boolean;
  error?: string;
  employee_name?: string;
  duplicate?: boolean;
  inside_geofence?: boolean | null;
  distance_m?: number | null;
}

/** Punch through the kiosk Edge Function. Requires connectivity. */
export async function kioskPunch(args: {
  kiosk: KioskConfig;
  employeeCode: string;
  pin: string;
  type: PunchType;
  clientUuid: string;
  selfieB64: string | null;
  lat: number | null;
  lng: number | null;
  gpsAccuracyM: number | null;
}): Promise<KioskPunchResult> {
  const url = `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/kiosk-punch`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
        Authorization: `Bearer ${process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!}`,
      },
      body: JSON.stringify({
        device_id: args.kiosk.device_id,
        device_key: args.kiosk.device_key,
        employee_code: args.employeeCode,
        pin: args.pin,
        type: args.type,
        client_uuid: args.clientUuid,
        happened_at: new Date().toISOString(),
        selfie_base64: args.selfieB64,
        lat: args.lat,
        lng: args.lng,
        gps_accuracy_m: args.gpsAccuracyM,
      }),
    });
    return (await res.json()) as KioskPunchResult;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' };
  }
}
