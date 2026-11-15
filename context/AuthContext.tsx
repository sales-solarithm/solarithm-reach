'use client';

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from 'react';
import { useRouter } from 'next/navigation';
import { AuthorizedUser } from '@/lib/types';
import {
  authenticateEmployeeByEmail,
  CANONICAL_NEXUS_EMPLOYEES,
  evaluateEmployeeAccessPure,
  ReachSessionUser,
} from '@/lib/authService';

export const REACH_SESSION_STORAGE_KEY = 'solarithm_reach_session';
const LEGACY_SESSION_KEY = 'solarithm_reach_active_session_v1';

interface AuthContextValue {
  user: ReachSessionUser | null;
  loading: boolean;
  isLoading: boolean;
  authorizedUsers: AuthorizedUser[];
  login: (email: string) => Promise<ReachSessionUser>;
  loginWithEmail: (
    email: string
  ) => Promise<{ success: boolean; error?: string; user?: ReachSessionUser }>;
  logout: () => void;
  switchRoleProfile: (email: string) => void;
  addAuthorizedUser: (newUser: AuthorizedUser) => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function mapCanonicalEmployeesToAuthorizedUsers(): AuthorizedUser[] {
  const result: AuthorizedUser[] = [];
  for (const emp of CANONICAL_NEXUS_EMPLOYEES) {
    try {
      const evaluated = evaluateEmployeeAccessPure(emp, emp.employeeId);
      result.push({
        email: evaluated.email,
        name: evaluated.name,
        role: evaluated.role,
        status: 'ACTIVE',
        employeeId: evaluated.employeeId,
        uid: evaluated.uid,
        department: evaluated.department,
        designation: evaluated.designation,
        isOwnerTier: evaluated.isOwnerTier,
        isSalesTier: evaluated.isSalesTier,
      });
    } catch {
      // Skip inactive or non-reach roles
    }
  }
  return result;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<ReachSessionUser | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [authorizedUsers, setAuthorizedUsers] = useState<AuthorizedUser[]>(() =>
    mapCanonicalEmployeesToAuthorizedUsers()
  );

  useEffect(() => {
    let mounted = true;

    function hydrateSession() {
      if (typeof window !== 'undefined') {
        const storedRaw =
          window.localStorage.getItem(REACH_SESSION_STORAGE_KEY) ||
          window.localStorage.getItem(LEGACY_SESSION_KEY);

        if (storedRaw) {
          try {
            const parsed = JSON.parse(storedRaw) as Partial<ReachSessionUser> & {
              email?: string;
              role?: string;
            };
            if (parsed && parsed.email) {
              const roleUpper = String(parsed.role || 'SALES')
                .trim()
                .toUpperCase();
              const isOwnerTier =
                typeof parsed.isOwnerTier === 'boolean'
                  ? parsed.isOwnerTier
                  : roleUpper === 'OWNER' || roleUpper === 'ADMIN';
              const isSalesTier =
                typeof parsed.isSalesTier === 'boolean'
                  ? parsed.isSalesTier
                  : roleUpper === 'SALES' || roleUpper === 'LEAD_SALES';

              const hydratedUser: ReachSessionUser = {
                employeeId: String(parsed.employeeId || 'SDM-USER-01')
                  .trim()
                  .toUpperCase(),
                uid: parsed.uid || null,
                name: parsed.name || 'Solarithm Member',
                email: parsed.email.trim().toLowerCase(),
                role: (isOwnerTier
                  ? roleUpper === 'ADMIN'
                    ? 'ADMIN'
                    : 'OWNER'
                  : roleUpper === 'LEAD_SALES'
                  ? 'LEAD_SALES'
                  : 'SALES') as ReachSessionUser['role'],
                department: parsed.department || 'General',
                designation: parsed.designation || roleUpper,
                isOwnerTier,
                isSalesTier,
                status: 'ACTIVE',
              };

              if (mounted) {
                setUser(hydratedUser);
                window.localStorage.setItem(
                  REACH_SESSION_STORAGE_KEY,
                  JSON.stringify(hydratedUser)
                );
              }
            }
          } catch {
            window.localStorage.removeItem(REACH_SESSION_STORAGE_KEY);
            window.localStorage.removeItem(LEGACY_SESSION_KEY);
          }
        }
      }

      if (mounted) {
        setLoading(false);
      }
    }

    hydrateSession();
    return () => {
      mounted = false;
    };
  }, []);

  const login = useCallback(async (rawEmail: string): Promise<ReachSessionUser> => {
    const sessionUser = await authenticateEmployeeByEmail(rawEmail);
    setUser(sessionUser);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(
        REACH_SESSION_STORAGE_KEY,
        JSON.stringify(sessionUser)
      );
      window.localStorage.removeItem(LEGACY_SESSION_KEY);
    }
    return sessionUser;
  }, []);

  const loginWithEmail = useCallback(
    async (
      rawEmail: string
    ): Promise<{ success: boolean; error?: string; user?: ReachSessionUser }> => {
      try {
        const sessionUser = await login(rawEmail);
        return { success: true, user: sessionUser };
      } catch (err) {
        return {
          success: false,
          error:
            err instanceof Error
              ? err.message
              : 'Access Denied: Unregistered organization email.',
        };
      }
    },
    [login]
  );

  const logout = useCallback(() => {
    setUser(null);
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(REACH_SESSION_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_SESSION_KEY);
    }
    router.push('/login');
  }, [router]);

  const switchRoleProfile = useCallback(
    (email: string) => {
      void login(email).catch(() => {
        // Ignore invalid profile switch
      });
    },
    [login]
  );

  const addAuthorizedUser = useCallback((newUser: AuthorizedUser) => {
    setAuthorizedUsers((prev) => [
      ...prev.filter(
        (u) => u.email.toLowerCase() !== newUser.email.toLowerCase()
      ),
      newUser,
    ]);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isLoading: loading,
        authorizedUsers,
        login,
        loginWithEmail,
        logout,
        switchRoleProfile,
        addAuthorizedUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
