'use client';

import { useCallback, useEffect, useState } from 'react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { AuthorizedUser, LeadRecord } from '@/lib/types';

export const SOFT_LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes in milliseconds

export interface SoftLockCollisionState {
  isLockedByAnotherRep: boolean;
  lockedByEmail: string | null;
  lockedByName: string | null;
  lockedAt: string | null;
  remainingMs: number;
  bannerMessage: string | null;
}

/**
 * Pure helper: Evaluates whether a lead is currently soft-locked by another sales rep
 * within the 10-minute inactivity window (`SOFT_LOCK_TTL_MS`).
 */
export function evaluateLeadSoftLockCollision(
  lead: LeadRecord | null | undefined,
  currentUserEmail: string | null | undefined,
  now: Date = new Date()
): SoftLockCollisionState {
  if (!lead || !lead.currentCallerEmail || !lead.lockedAt) {
    return {
      isLockedByAnotherRep: false,
      lockedByEmail: null,
      lockedByName: null,
      lockedAt: null,
      remainingMs: 0,
      bannerMessage: null,
    };
  }

  const lockedAtMs = new Date(lead.lockedAt).getTime();
  if (Number.isNaN(lockedAtMs)) {
    return {
      isLockedByAnotherRep: false,
      lockedByEmail: null,
      lockedByName: null,
      lockedAt: null,
      remainingMs: 0,
      bannerMessage: null,
    };
  }

  const elapsedMs = now.getTime() - lockedAtMs;
  if (elapsedMs >= SOFT_LOCK_TTL_MS) {
    // Expired (> 10 minutes of inactivity)
    return {
      isLockedByAnotherRep: false,
      lockedByEmail: null,
      lockedByName: null,
      lockedAt: null,
      remainingMs: 0,
      bannerMessage: null,
    };
  }

  const remainingMs = Math.max(0, SOFT_LOCK_TTL_MS - elapsedMs);
  const normalizedCaller = lead.currentCallerEmail.trim().toLowerCase();
  const normalizedCurrent = (currentUserEmail || '').trim().toLowerCase();

  const isAnotherRep = Boolean(normalizedCurrent && normalizedCaller !== normalizedCurrent);
  const displayCallerName = lead.currentCallerName
    ? lead.currentCallerName.split(' (')[0]
    : lead.currentCallerEmail;

  return {
    isLockedByAnotherRep: isAnotherRep,
    lockedByEmail: lead.currentCallerEmail,
    lockedByName: displayCallerName,
    lockedAt: lead.lockedAt,
    remainingMs,
    bannerMessage: isAnotherRep
      ? `Rep ${displayCallerName} is currently viewing/calling this lead.`
      : null,
  };
}

/**
 * Pure helper: Acquires a soft lock on a lead if it is not currently locked by another active rep
 * (or if `forceOverride` is true, e.g., when an Owner overrides the lock).
 */
export function acquireLeadSoftLockPure(
  lead: LeadRecord,
  caller: { email: string; name: string },
  nowIso: string = new Date().toISOString(),
  forceOverride: boolean = false
): { updatedLead: LeadRecord; acquired: boolean; collision: SoftLockCollisionState } {
  const now = new Date(nowIso);
  const existingCollision = evaluateLeadSoftLockCollision(lead, caller.email, now);

  if (existingCollision.isLockedByAnotherRep && !forceOverride) {
    return {
      updatedLead: lead,
      acquired: false,
      collision: existingCollision,
    };
  }

  const updatedLead: LeadRecord = {
    ...lead,
    currentCallerEmail: caller.email,
    currentCallerName: caller.name,
    lockedAt: nowIso,
    updatedAt: nowIso,
  };

  return {
    updatedLead,
    acquired: true,
    collision: evaluateLeadSoftLockCollision(updatedLead, caller.email, now),
  };
}

/**
 * Pure helper: Releases the soft lock on a lead.
 */
export function releaseLeadSoftLockPure(
  lead: LeadRecord,
  nowIso: string = new Date().toISOString()
): LeadRecord {
  return {
    ...lead,
    currentCallerEmail: null,
    currentCallerName: null,
    lockedAt: null,
    updatedAt: nowIso,
  };
}

/**
 * Writes or clears the temporary soft lock in Firestore (`currentCallerEmail`, `lockedAt = serverTimestamp()`).
 */
export async function syncSoftLockToFirestore(
  leadId: string,
  caller: { email: string | null; name: string | null }
): Promise<void> {
  try {
    const leadRef = doc(db, 'leads', leadId);
    await updateDoc(leadRef, {
      currentCallerEmail: caller.email,
      currentCallerName: caller.name,
      lockedAt: caller.email ? serverTimestamp() : null,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    // Non-blocking fallback when offline or in preview rules mode
  }
}

interface UseLeadLockOptions {
  activeLead: LeadRecord | null;
  currentUser: AuthorizedUser | null;
  onUpdateLeadInState: (updatedLead: LeadRecord) => void;
}

/**
 * Phase 10 Task 2: Real-Time Tab Concurrency & Soft Collision Warnings (`hooks/useLeadLock.ts`)
 * - Automatically writes a temporary soft lock (`currentCallerEmail`, `lockedAt`) when the drawer opens.
 * - Expires automatically after 10 minutes (`SOFT_LOCK_TTL_MS`) of inactivity.
 * - Exposes `collision` state, `overrideSoftLock()`, and `simulatePeerCollisionLock()` for multi-rep verification.
 */
export function useLeadLock({
  activeLead,
  currentUser,
  onUpdateLeadInState,
}: UseLeadLockOptions) {
  const [nowTick, setNowTick] = useState<Date>(() => new Date());

  // Tick every 5 seconds while a lead drawer is open to keep the 10-minute expiry accurate
  useEffect(() => {
    if (!activeLead) return;
    const interval = setInterval(() => {
      setNowTick(new Date());
    }, 5000);
    return () => clearInterval(interval);
  }, [activeLead?.id]);

  // Acquire soft lock when a rep opens the Call Action Drawer on an unlocked lead
  useEffect(() => {
    if (!activeLead || !currentUser) return;

    const nowIso = new Date().toISOString();
    const check = evaluateLeadSoftLockCollision(activeLead, currentUser.email, new Date(nowIso));

    // Only auto-acquire if not locked by another rep and not already locked by current user
    if (
      !check.isLockedByAnotherRep &&
      activeLead.currentCallerEmail?.toLowerCase() !== currentUser.email.toLowerCase()
    ) {
      const { updatedLead, acquired } = acquireLeadSoftLockPure(
        activeLead,
        { email: currentUser.email, name: currentUser.name },
        nowIso,
        false
      );
      if (acquired) {
        onUpdateLeadInState(updatedLead);
        void syncSoftLockToFirestore(activeLead.id, {
          email: currentUser.email,
          name: currentUser.name,
        });
      }
    }
  }, [activeLead?.id, currentUser?.email]);

  const collision = evaluateLeadSoftLockCollision(
    activeLead,
    currentUser?.email,
    nowTick
  );

  const releaseLock = useCallback(
    (leadToRelease?: LeadRecord | null) => {
      const target = leadToRelease ?? activeLead;
      if (!target) return;
      // Only release if the lock isn't held by another rep
      const currentCheck = evaluateLeadSoftLockCollision(
        target,
        currentUser?.email,
        new Date()
      );
      if (!currentCheck.isLockedByAnotherRep) {
        const unlocked = releaseLeadSoftLockPure(target, new Date().toISOString());
        onUpdateLeadInState(unlocked);
        void syncSoftLockToFirestore(target.id, { email: null, name: null });
      }
    },
    [activeLead, currentUser?.email, onUpdateLeadInState]
  );

  const overrideSoftLock = useCallback(() => {
    if (!activeLead || !currentUser) return;
    const nowIso = new Date().toISOString();
    const { updatedLead } = acquireLeadSoftLockPure(
      activeLead,
      { email: currentUser.email, name: currentUser.name },
      nowIso,
      true
    );
    onUpdateLeadInState(updatedLead);
    setNowTick(new Date(nowIso));
    void syncSoftLockToFirestore(activeLead.id, {
      email: currentUser.email,
      name: currentUser.name,
    });
  }, [activeLead, currentUser, onUpdateLeadInState]);

  const simulatePeerCollisionLock = useCallback(
    (peerRep: { email: string; name: string }) => {
      if (!activeLead) return;
      const nowIso = new Date().toISOString();
      const { updatedLead } = acquireLeadSoftLockPure(
        activeLead,
        peerRep,
        nowIso,
        true
      );
      onUpdateLeadInState(updatedLead);
      setNowTick(new Date(nowIso));
      void syncSoftLockToFirestore(activeLead.id, peerRep);
    },
    [activeLead, onUpdateLeadInState]
  );

  return {
    collision,
    releaseLock,
    overrideSoftLock,
    simulatePeerCollisionLock,
  };
}
