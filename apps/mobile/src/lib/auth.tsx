import type { Profile } from '@fermosa/shared';
import type { Session } from '@supabase/supabase-js';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type PropsWithChildren,
} from 'react';
import { supabase } from './supabase';

export interface BranchSummary {
  id: string;
  name: string;
  address: string | null;
  geofence_radius_m: number;
  lat: number;
  lng: number;
  timezone: string;
}

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  branch: BranchSummary | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  session: null,
  profile: null,
  branch: null,
  loading: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [branch, setBranch] = useState<BranchSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) {
        setProfile(null);
        setBranch(null);
        setLoading(false);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { data: profileRow } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .maybeSingle();
      if (cancelled) return;
      setProfile((profileRow as Profile | null) ?? null);

      if (profileRow?.branch_id) {
        const { data: branchRow } = await supabase
          .from('branches')
          .select('id, name, address, geofence_radius_m, lat, lng, timezone')
          .eq('id', profileRow.branch_id)
          .maybeSingle();
        if (cancelled) return;
        setBranch((branchRow as BranchSummary | null) ?? null);
      } else {
        setBranch(null);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ session, profile, branch, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
