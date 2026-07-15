import type { Session } from '@supabase/supabase-js';
import type { Profile } from '@fermosa/shared';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase } from './supabase';

/** Authenticator Assurance Level for the current session (Supabase MFA). */
export interface Aal {
  currentLevel: string | null; // 'aal1' = password only, 'aal2' = passed 2FA
  nextLevel: string | null; // 'aal2' here means the user has a verified factor
}

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  aal: Aal | null;
  aalLoading: boolean;
  loading: boolean;
  signOut: () => Promise<void>;
  refreshAal: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  session: null,
  profile: null,
  aal: null,
  aalLoading: false,
  loading: true,
  signOut: async () => {},
  refreshAal: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  // undefined = not yet determined; null = no session / not applicable.
  const [aal, setAal] = useState<Aal | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) {
        setLoading(false);
        setAal(null);
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (!newSession) {
        setProfile(null);
        setAal(null);
        setLoading(false);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Profile — keyed on user id (stable across token refreshes).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    supabase
      .from('profiles')
      .select('*')
      .eq('id', session.user.id)
      .single()
      .then(({ data }) => {
        if (!cancelled) {
          setProfile(data as Profile | null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user.id]);

  // AAL — keyed on the access token, so an aal1→aal2 upgrade is picked up.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    supabase.auth.mfa.getAuthenticatorAssuranceLevel().then(({ data }) => {
      if (!cancelled) {
        setAal(data ? { currentLevel: data.currentLevel, nextLevel: data.nextLevel } : null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token]);

  const refreshAal = async () => {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    setAal(data ? { currentLevel: data.currentLevel, nextLevel: data.nextLevel } : null);
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        profile,
        aal: aal ?? null,
        aalLoading: session != null && aal === undefined,
        loading,
        signOut,
        refreshAal,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

/** True when the user has a verified 2FA factor but this session is still aal1. */
export function needsMfaChallenge(aal: Aal | null): boolean {
  return !!aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2';
}
