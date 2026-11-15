'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  X,
  Phone,
  Building2,
  AlertTriangle,
  CheckCircle2,
  MapPin,
  Mail,
  Plus,
  Flame,
  UserCheck,
  Clock,
} from 'lucide-react';
import { LeadRecord, LeadStatus } from '@/lib/types';
import { normalizeCompanyName, sanitizePhoneNumber } from '@/lib/phoneSanitizer';
import {
  SingleLeadDuplicateMatch,
  applyClaimOrUpdateExistingLeadPure,
  applyHotClientCrossRepEscalationPure,
  checkSingleLeadDuplicateInFirestore,
  checkSingleLeadDuplicatePure,
  classifyLeadCollisionScenarioPure,
  computeOperationalDatesForStatus,
} from '@/lib/leadStore';
import { sanitizeFirestorePayload } from '@/lib/firestoreSanitizer';

interface AddLeadModalProps {
  isOpen: boolean;
  onClose: () => void;
  existingLeads: LeadRecord[];
  isOwnerTier?: boolean;
  currentUser?: {
    email: string;
    name: string;
    role?: string;
    isOwnerTier?: boolean;
    isSalesTier?: boolean;
  } | null;
  onCreateLead: (lead: LeadRecord, isOverwrite?: boolean) => void;
}

const INITIAL_STATUS_OPTIONS: { value: LeadStatus; label: string }[] = [
  { value: 'FRESH', label: 'FRESH (Global Pool)' },
  { value: 'PROPOSAL_SHARED', label: 'PROPOSAL_SHARED (+2d Follow-Up)' },
  { value: 'INTERESTED', label: 'INTERESTED (Owner Closing Queue)' },
  { value: 'FUTURE_REQUIREMENT', label: 'FUTURE_REQUIREMENT (+30d Follow-Up)' },
  { value: 'NOT_INTERESTED', label: 'NOT_INTERESTED' },
  { value: 'DIDNT_RECEIVE', label: 'DIDNT_RECEIVE (+48h Cooldown)' },
  { value: 'SWITCH_OFF', label: 'SWITCH_OFF' },
  { value: 'NOT_A_SOLAR_COMPANY', label: 'NOT_A_SOLAR_COMPANY' },
];

export function AddLeadModal({
  isOpen,
  onClose,
  existingLeads,
  isOwnerTier = true,
  currentUser = null,
  onCreateLead,
}: AddLeadModalProps) {
  const [companyName, setCompanyName] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [altPhoneInput, setAltPhoneInput] = useState('');
  const [stateVal, setStateVal] = useState('');
  const [cityVal, setCityVal] = useState('');
  const [emailVal, setEmailVal] = useState('');
  const [initialStatus, setInitialStatus] = useState<LeadStatus>(
    isOwnerTier ? 'FRESH' : 'PROPOSAL_SHARED'
  );
  const [notesVal, setNotesVal] = useState('');
  const [urgentHandoverNote, setUrgentHandoverNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [firestoreBlurDuplicate, setFirestoreBlurDuplicate] =
    useState<SingleLeadDuplicateMatch | null>(null);

  const sanitizedPrimary = useMemo(() => sanitizePhoneNumber(phoneInput), [phoneInput]);
  const sanitizedAlt = useMemo(
    () => (altPhoneInput.trim() ? sanitizePhoneNumber(altPhoneInput) : null),
    [altPhoneInput]
  );

  const cleanPrimary10 = sanitizedPrimary.isValid ? sanitizedPrimary.cleaned : '';
  const formattedPrimary = sanitizedPrimary.isValid ? sanitizedPrimary.formatted : '';
  const cleanAlt10 = sanitizedAlt?.isValid ? sanitizedAlt.cleaned : null;
  const formattedAlt = sanitizedAlt?.isValid ? sanitizedAlt.formatted : null;
  const trimmedCompany = companyName.trim();

  // Real-time in-memory duplicate check
  const localDuplicateMatch = useMemo(() => {
    return checkSingleLeadDuplicatePure(
      {
        companyName: trimmedCompany,
        cleanedPrimaryPhone: cleanPrimary10,
        formattedPrimaryPhone: formattedPrimary,
        cleanedAltPhone: cleanAlt10,
        formattedAltPhone: formattedAlt,
      },
      existingLeads
    );
  }, [
    trimmedCompany,
    cleanPrimary10,
    formattedPrimary,
    cleanAlt10,
    formattedAlt,
    existingLeads,
  ]);

  const activeDuplicateMatch = firestoreBlurDuplicate || localDuplicateMatch;

  const collisionScenario = useMemo(() => {
    if (!activeDuplicateMatch) return null;
    return classifyLeadCollisionScenarioPure(
      activeDuplicateMatch.lead,
      currentUser?.email || null
    );
  }, [activeDuplicateMatch, currentUser?.email]);

  /**
   * Firestore duplicate query helper triggered both on 300ms debounce (once 10 digits or 3+ company chars are reached)
   * and on input blur.
   */
  const handleInputBlurDuplicateCheck = useCallback(async () => {
    if (!cleanPrimary10 && !cleanAlt10 && trimmedCompany.length < 3) {
      setFirestoreBlurDuplicate(null);
      return;
    }

    const match = await checkSingleLeadDuplicateInFirestore(
      {
        companyName: trimmedCompany,
        cleanedPrimaryPhone: cleanPrimary10,
        formattedPrimaryPhone: formattedPrimary,
        cleanedAltPhone: cleanAlt10,
        formattedAltPhone: formattedAlt,
      },
      existingLeads
    );
    setFirestoreBlurDuplicate(match);
  }, [
    cleanPrimary10,
    cleanAlt10,
    trimmedCompany,
    formattedPrimary,
    formattedAlt,
    existingLeads,
  ]);

  // Debounced (300ms) real-time duplicate detection once 10 normalized phone digits or company name are entered
  useEffect(() => {
    if (!isOpen) return;
    if (!cleanPrimary10 && !cleanAlt10 && trimmedCompany.length < 3) {
      return;
    }

    const timer = setTimeout(() => {
      void handleInputBlurDuplicateCheck();
    }, 300);

    return () => clearTimeout(timer);
  }, [isOpen, cleanPrimary10, cleanAlt10, trimmedCompany, handleInputBlurDuplicateCheck]);

  if (!isOpen) return null;

  const resetAndClose = () => {
    setCompanyName('');
    setPhoneInput('');
    setAltPhoneInput('');
    setStateVal('');
    setCityVal('');
    setEmailVal('');
    setInitialStatus(isOwnerTier ? 'FRESH' : 'PROPOSAL_SHARED');
    setNotesVal('');
    setUrgentHandoverNote('');
    setFormError(null);
    setFirestoreBlurDuplicate(null);
    onClose();
  };

  // Scenario A & Scenario B Handler: Claim or Update Existing Lead
  const handleClaimOrUpdateExisting = () => {
    setFormError(null);
    if (!activeDuplicateMatch) return;

    const actorUser = {
      email: currentUser?.email ? currentUser.email.toLowerCase().trim() : 'owner@solarithmdesign.com',
      name: currentUser?.name ? currentUser.name.split(' (')[0].trim() : 'Solarithm Member',
    };

    const targetStatus: LeadStatus =
      collisionScenario === 'SCENARIO_A_UNCLAIMED_OR_COLD' && initialStatus === 'FRESH'
        ? 'PROPOSAL_SHARED'
        : initialStatus;

    const updatedLead = sanitizeFirestorePayload(
      applyClaimOrUpdateExistingLeadPure(activeDuplicateMatch.lead, {
        newStatus: targetStatus,
        currentUser: actorUser,
        noteText: notesVal,
        altNumber: cleanAlt10,
        state: stateVal.trim() || undefined,
        city: cityVal.trim() || undefined,
        email: emailVal.trim() || undefined,
        nowIso: new Date().toISOString(),
      })
    );

    onCreateLead(updatedLead, true);
    resetAndClose();
  };

  // Scenario C Handler: Hot Client / Ready to Give Project Now Escalation
  const handleEscalateHotClient = () => {
    setFormError(null);
    if (!activeDuplicateMatch) return;

    if (!urgentHandoverNote.trim()) {
      setFormError(
        'Urgent Handover Note is mandatory. Please specify what the client committed to right now.'
      );
      return;
    }

    const actorUser = {
      email: currentUser?.email ? currentUser.email.toLowerCase().trim() : 'sales@solarithmdesign.com',
      name: currentUser?.name ? currentUser.name.split(' (')[0].trim() : 'Sales Rep',
    };

    try {
      const escalatedLead = sanitizeFirestorePayload(
        applyHotClientCrossRepEscalationPure(activeDuplicateMatch.lead, {
          escalatingUser: actorUser,
          urgentHandoverNote,
          altNumber: cleanAlt10,
          state: stateVal.trim() || undefined,
          city: cityVal.trim() || undefined,
          email: emailVal.trim() || undefined,
          nowIso: new Date().toISOString(),
        })
      );

      onCreateLead(escalatedLead, true);
      resetAndClose();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Unable to escalate lead.'
      );
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    // 1.2 Strict Duplicate Prohibition: NEVER create a second duplicate document in Firestore
    if (activeDuplicateMatch) {
      setFormError(
        'Duplicate lead creation is strictly prohibited. Please use the Existing Lead Collision resolution options above.'
      );
      return;
    }

    if (!trimmedCompany) {
      setFormError('Company Name is mandatory.');
      return;
    }

    if (!sanitizedPrimary.isValid) {
      setFormError(
        sanitizedPrimary.error || 'Please enter a valid 10-digit Indian mobile number.'
      );
      return;
    }

    if (sanitizedAlt && !sanitizedAlt.isValid) {
      setFormError(`Alternative Number invalid: ${sanitizedAlt.error}`);
      return;
    }

    const nowIso = new Date().toISOString();
    const isAddedBySalesRep = Boolean(
      currentUser && (!isOwnerTier || currentUser.isSalesTier)
    );

    const creatorEmail = currentUser?.email ? currentUser.email.toLowerCase().trim() : null;
    const creatorName = currentUser?.name ? currentUser.name.split(' (')[0].trim() : null;
    const creatorRole: 'OWNER' | 'SALES' | null = currentUser
      ? isOwnerTier
        ? 'OWNER'
        : 'SALES'
      : null;

    const { cooldownUntil, nextFollowUpDate } = computeOperationalDatesForStatus(
      initialStatus,
      nowIso
    );

    const newLead: LeadRecord = sanitizeFirestorePayload({
      id: `lead-${Date.now()}`,
      companyName: trimmedCompany,
      companyNameNormalized: normalizeCompanyName(trimmedCompany),
      phoneNumber: sanitizedPrimary.cleaned,
      formattedPhone: sanitizedPrimary.formatted,
      altNumber: sanitizedAlt?.isValid ? sanitizedAlt.cleaned : null,
      state: stateVal.trim() || null,
      city: cityVal.trim() || null,
      email: emailVal.trim() || null,
      status: initialStatus,
      assignedBatchId: null,
      assignedRepEmail: isAddedBySalesRep ? creatorEmail : null,
      assignedRepName: isAddedBySalesRep ? creatorName : null,
      createdByEmail: creatorEmail,
      createdByName: creatorName,
      createdByRole: creatorRole,
      callAttempts: initialStatus === 'FRESH' ? 0 : 1,
      callCount: initialStatus === 'FRESH' ? 0 : 1,
      didntReceiveCount: initialStatus === 'DIDNT_RECEIVE' ? 1 : 0,
      switchOffCount: initialStatus === 'SWITCH_OFF' ? 1 : 0,
      lastCalledDate: initialStatus === 'FRESH' ? null : nowIso,
      lastCalledByEmail: initialStatus === 'FRESH' ? null : creatorEmail,
      lastCalledByName: initialStatus === 'FRESH' ? null : creatorName,
      interestedAt:
        initialStatus === 'INTERESTED' || initialStatus === 'CLOSED_WON'
          ? nowIso
          : null,
      closedWonAt: initialStatus === 'CLOSED_WON' ? nowIso : null,
      cooldownUntil,
      nextFollowUpDate,
      createdAt: nowIso,
      updatedAt: nowIso,
      notes: notesVal.trim() || 'Manually added via Single Lead Ingestion.',
      callHistory:
        initialStatus !== 'FRESH' && creatorEmail
          ? [
              {
                id: `log-${Date.now()}`,
                timestamp: nowIso,
                repEmail: creatorEmail,
                repName: creatorName || 'Sales Rep',
                previousStatus: 'FRESH',
                newStatus: initialStatus,
                note: notesVal.trim() || 'Initial status set when adding lead',
              },
            ]
          : undefined,
    });

    onCreateLead(newLead, false);
    resetAndClose();
  };

  const existingCollisionLead = activeDuplicateMatch?.lead || null;
  const assignedRepLabel =
    existingCollisionLead?.assignedRepName?.split(' (')[0].trim() ||
    existingCollisionLead?.assignedRepEmail ||
    'Unassigned / Global Pool';
  const lastCalledLabel = existingCollisionLead?.lastCalledDate
    ? existingCollisionLead.lastCalledDate.slice(0, 10)
    : 'Never';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-lead-modal-title"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 bg-black/70 backdrop-blur-xs"
    >
      <div className="w-full h-full sm:h-auto sm:max-h-[92vh] sm:w-full sm:max-w-lg bg-white dark:bg-[#12151C] sm:border border-slate-200 dark:border-white/10 sm:rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-white/10 shrink-0">
          <div className="min-w-0 pr-2">
            <h2
              id="add-lead-modal-title"
              className="text-sm font-semibold text-slate-900 dark:text-white tracking-tight"
            >
              Add Single Solar Lead
            </h2>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
              Real-time 10-digit duplicate shield &amp; Hot Client cross-rep escalation
            </p>
          </div>
          <button
            type="button"
            onClick={resetAndClose}
            aria-label="Close modal"
            className="p-1.5 rounded text-slate-400 hover:text-slate-700 dark:hover:text-white transition-colors cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 flex flex-col justify-between"
          noValidate
        >
          <div className="space-y-4">
            {/* Mandatory: Company Name */}
            <div>
              <label
                htmlFor="single-company-name"
                className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
              >
                Company Name <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <Building2 className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  id="single-company-name"
                  data-testid="single-company-name-input"
                  type="text"
                  required
                  value={companyName}
                  onChange={(e) => {
                    setCompanyName(e.target.value);
                    setFirestoreBlurDuplicate(null);
                  }}
                  onBlur={() => void handleInputBlurDuplicateCheck()}
                  placeholder="e.g., Surya Kiran Textiles Pvt Ltd"
                  className="w-full pl-9 pr-3 py-2 rounded bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-[#E5B842]"
                />
              </div>
            </div>

            {/* Mandatory: Phone Number with Real-Time Sanitizer Preview */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label
                  htmlFor="single-phone-input"
                  className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
                >
                  Phone Number <span className="text-red-500">*</span>
                </label>
                {phoneInput.trim() && (
                  <span
                    data-testid="single-phone-sanitized-status"
                    className={`text-[11px] font-mono ${
                      sanitizedPrimary.isValid
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    {sanitizedPrimary.isValid
                      ? `Normalized: ${sanitizedPrimary.formatted} (${sanitizedPrimary.cleaned})`
                      : sanitizedPrimary.error}
                  </span>
                )}
              </div>
              <div className="relative">
                <Phone className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  id="single-phone-input"
                  data-testid="single-phone-input"
                  type="text"
                  required
                  value={phoneInput}
                  onChange={(e) => {
                    setPhoneInput(e.target.value);
                    setFirestoreBlurDuplicate(null);
                  }}
                  onBlur={() => void handleInputBlurDuplicateCheck()}
                  placeholder="e.g., +91 98250-11223 or 9825011223.0"
                  className="w-full pl-9 pr-3 py-2 rounded bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 text-xs font-mono text-slate-900 dark:text-white focus:outline-none focus:border-[#E5B842]"
                />
              </div>
            </div>

            {/* Optional fields grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="single-alt-phone"
                  className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1"
                >
                  Alternative Number (Optional)
                </label>
                <input
                  id="single-alt-phone"
                  data-testid="single-alt-phone-input"
                  type="text"
                  value={altPhoneInput}
                  onChange={(e) => {
                    setAltPhoneInput(e.target.value);
                    setFirestoreBlurDuplicate(null);
                  }}
                  onBlur={() => void handleInputBlurDuplicateCheck()}
                  placeholder="09429360746"
                  className="w-full px-3 py-2 rounded bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 text-xs font-mono text-slate-900 dark:text-white focus:outline-none focus:border-[#E5B842]"
                />
              </div>

              <div>
                <label
                  htmlFor="single-initial-status"
                  className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1"
                >
                  Status / Disposition
                </label>
                <select
                  id="single-initial-status"
                  data-testid="single-initial-status-select"
                  value={initialStatus}
                  onChange={(e) => setInitialStatus(e.target.value as LeadStatus)}
                  className="w-full px-2.5 py-2 rounded bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 text-xs font-mono text-slate-900 dark:text-white focus:outline-none focus:border-[#E5B842]"
                >
                  {INITIAL_STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="single-state"
                  className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1"
                >
                  State (Optional)
                </label>
                <div className="relative">
                  <MapPin className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    id="single-state"
                    type="text"
                    value={stateVal}
                    onChange={(e) => setStateVal(e.target.value)}
                    placeholder="Gujarat"
                    className="w-full pl-8 pr-3 py-2 rounded bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-[#E5B842]"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="single-city"
                  className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1"
                >
                  City (Optional)
                </label>
                <input
                  id="single-city"
                  type="text"
                  value={cityVal}
                  onChange={(e) => setCityVal(e.target.value)}
                  placeholder="Ahmedabad"
                  className="w-full px-3 py-2 rounded bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-[#E5B842]"
                />
              </div>

              <div className="sm:col-span-2">
                <label
                  htmlFor="single-email"
                  className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1"
                >
                  Email (Optional)
                </label>
                <div className="relative">
                  <Mail className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    id="single-email"
                    type="email"
                    value={emailVal}
                    onChange={(e) => setEmailVal(e.target.value)}
                    placeholder="director@company.in"
                    className="w-full pl-8 pr-3 py-2 rounded bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-[#E5B842]"
                  />
                </div>
              </div>

              <div className="sm:col-span-2">
                <label
                  htmlFor="single-call-notes"
                  className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1"
                >
                  Call Notes / Remarks (Optional)
                </label>
                <input
                  id="single-call-notes"
                  data-testid="single-call-notes-input"
                  type="text"
                  value={notesVal}
                  onChange={(e) => setNotesVal(e.target.value)}
                  placeholder="e.g., Requested 150 kW rooftop quote, follow up Thursday"
                  className="w-full px-3 py-2 rounded bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-[#E5B842]"
                />
              </div>
            </div>

            {/* 2. Three-Tier Existing Lead Collision Card */}
            {activeDuplicateMatch && existingCollisionLead && (
              <div
                role="alert"
                data-testid="existing-lead-collision-card"
                className="p-3.5 rounded-xl bg-amber-500/[0.08] border border-amber-500/35 text-xs space-y-3"
              >
                {/* Header & Existing Lead Metadata */}
                <div className="flex items-start justify-between gap-2 border-b border-amber-500/20 pb-2.5">
                  <div className="flex items-start gap-2 min-w-0">
                    <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <div className="font-bold text-slate-900 dark:text-white truncate">
                        Existing Lead Detected: {existingCollisionLead.companyName}
                      </div>
                      <p className="text-[11px] text-amber-700 dark:text-amber-300/90 mt-0.5">
                        {activeDuplicateMatch.reason}
                      </p>
                    </div>
                  </div>
                  <span
                    data-testid="collision-lead-status-badge"
                    className="px-2 py-0.5 rounded border border-amber-500/40 bg-amber-500/15 font-mono text-[10px] font-bold text-amber-800 dark:text-amber-300 shrink-0"
                  >
                    {existingCollisionLead.status}
                  </span>
                </div>

                {/* Metadata Grid: Assigned Sales Rep & Last Called Date */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] font-mono bg-white/60 dark:bg-[#0B0D12]/80 p-2.5 rounded-lg border border-amber-500/20">
                  <div className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                    <UserCheck className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    <span className="text-slate-500">Assigned Rep:</span>
                    <span
                      data-testid="collision-assigned-rep"
                      className="font-semibold text-slate-900 dark:text-white truncate"
                    >
                      {assignedRepLabel}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                    <Clock className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    <span className="text-slate-500">Last Called:</span>
                    <span
                      data-testid="collision-last-called-date"
                      className="font-semibold text-slate-900 dark:text-white"
                    >
                      {lastCalledLabel}
                    </span>
                  </div>
                </div>

                {/* SCENARIO A: Unclaimed or Cold (FRESH, DIDNT_RECEIVE, SWITCH_OFF, NOT_INTERESTED, DIDNT_RECEIVE_DEAD, SWITCH_OFF_DEAD) */}
                {collisionScenario === 'SCENARIO_A_UNCLAIMED_OR_COLD' && (
                  <div
                    data-testid="collision-scenario-a"
                    className="space-y-2 pt-0.5"
                  >
                    <p className="text-[11px] text-slate-600 dark:text-slate-300">
                      This lead is currently unclaimed or cold ({existingCollisionLead.status}). Claim it into your pipeline and update its status without creating a duplicate.
                    </p>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        data-testid="claim-and-update-existing-lead-btn"
                        onClick={handleClaimOrUpdateExisting}
                        className="w-full sm:w-auto px-3.5 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs transition-colors cursor-pointer"
                      >
                        Claim &amp; Update Existing Lead
                      </button>
                    </div>
                  </div>
                )}

                {/* SCENARIO B: Owned by the SAME Logged-In Sales Rep */}
                {collisionScenario === 'SCENARIO_B_OWNED_BY_SAME_REP' && (
                  <div
                    data-testid="collision-scenario-b"
                    className="space-y-2 pt-0.5"
                  >
                    <p
                      data-testid="scenario-b-pipeline-msg"
                      className="text-xs font-medium text-amber-800 dark:text-amber-300"
                    >
                      This lead is already in your personal pipeline under{' '}
                      <span className="font-mono font-bold">
                        {existingCollisionLead.status}
                      </span>
                      .
                    </p>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        data-testid="update-my-existing-lead-btn"
                        onClick={handleClaimOrUpdateExisting}
                        className="w-full sm:w-auto px-3.5 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs transition-colors cursor-pointer"
                      >
                        Update My Existing Lead Status &amp; Notes
                      </button>
                    </div>
                  </div>
                )}

                {/* SCENARIO C: Owned by ANOTHER Sales Rep in PROPOSAL_SHARED, FUTURE_REQUIREMENT, or INTERESTED */}
                {collisionScenario === 'SCENARIO_C_OWNED_BY_ANOTHER_REP' && (
                  <div
                    data-testid="collision-scenario-c"
                    className="space-y-3 pt-1"
                  >
                    <div
                      data-testid="scenario-c-warning-banner"
                      className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 text-xs leading-relaxed"
                    >
                      This client is currently assigned to{' '}
                      <strong className="font-bold">{assignedRepLabel}</strong> with
                      status{' '}
                      <strong className="font-mono font-bold">
                        {existingCollisionLead.status}
                      </strong>
                      .
                    </div>

                    {/* Hot Client / Ready to Give Project Now Escalation Workflow */}
                    <div className="p-3 rounded-lg bg-emerald-500/[0.07] border border-emerald-500/30 space-y-2.5">
                      <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300 font-semibold text-xs">
                        <Flame className="w-4 h-4 text-amber-500 shrink-0" />
                        <span>
                          Hot Client / Ready to Give Project Now Escalation
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                        Escalate this client directly to the Owner Closing Queue while preserving{' '}
                        <strong>{assignedRepLabel}</strong> as the Originating Rep and recording your co-escalation.
                      </p>
                      <div>
                        <label
                          htmlFor="urgent-handover-note"
                          className="block text-[11px] font-semibold text-slate-700 dark:text-slate-200 mb-1"
                        >
                          Urgent Handover Note (What did the client commit to right now?){' '}
                          <span className="text-red-500">*</span>
                        </label>
                        <textarea
                          id="urgent-handover-note"
                          data-testid="urgent-handover-note-input"
                          rows={2}
                          required
                          value={urgentHandoverNote}
                          onChange={(e) => {
                            setUrgentHandoverNote(e.target.value);
                            if (formError) setFormError(null);
                          }}
                          placeholder="e.g., Client ready to issue PO for 250 kW plant today, needs final Owner closing call now."
                          className="w-full px-3 py-2 rounded bg-white dark:bg-[#0B0D12] border border-emerald-500/30 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-emerald-500 resize-none"
                        />
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="button"
                          data-testid="escalate-hot-client-btn"
                          onClick={handleEscalateHotClient}
                          className="w-full sm:w-auto px-4 py-2 rounded-lg bg-gradient-to-r from-[#7C6328] to-emerald-600 hover:from-[#8F722E] hover:to-emerald-500 text-white font-semibold text-xs transition-all flex items-center justify-center gap-1.5 shadow-sm cursor-pointer"
                        >
                          <Flame className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                          <span>Escalate to Owner Queue (Client Ready Now)</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {formError && (
              <div
                role="alert"
                data-testid="add-lead-form-error"
                className="p-3 rounded bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 text-xs"
              >
                {formError}
              </div>
            )}
          </div>

          {/* Sticky Footer Buttons: Standard [+ Save Lead] is strictly DISABLED and HIDDEN when activeDuplicateMatch exists */}
          <div className="sticky bottom-0 bg-white dark:bg-[#12151C] flex items-center justify-end gap-2 pt-3 pb-1 border-t border-slate-200 dark:border-white/10 shrink-0">
            <button
              type="button"
              onClick={resetAndClose}
              className="px-3.5 py-2 sm:py-1.5 rounded-lg border border-slate-200 dark:border-white/10 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            {!activeDuplicateMatch && (
              <button
                type="submit"
                disabled={Boolean(activeDuplicateMatch)}
                data-testid="save-single-lead-btn"
                className="px-4 py-2 sm:py-1.5 rounded-lg bg-[#7C6328] hover:bg-[#8F722E] text-white text-xs font-semibold transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {sanitizedPrimary.isValid ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-[#E5B842]" />
                ) : (
                  <Plus className="w-3.5 h-3.5" />
                )}
                <span>Save Lead</span>
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

