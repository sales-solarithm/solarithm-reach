export type UserRole =
  | 'owner'
  | 'sales'
  | 'OWNER'
  | 'ADMIN'
  | 'SALES'
  | 'LEAD_SALES';

export interface AuthorizedUser {
  email: string;
  name: string;
  role: UserRole;
  status?: 'active' | 'revoked' | 'ACTIVE' | 'INACTIVE';
  employeeId?: string;
  uid?: string | null;
  department?: string;
  designation?: string;
  isOwnerTier?: boolean;
  isSalesTier?: boolean;
}

export type LeadStatus =
  | 'FRESH'
  | 'REVIVED_FRESH'
  | 'PROPOSAL_SHARED'
  | 'DIDNT_RECEIVE'
  | 'INTERESTED'
  | 'FUTURE_REQUIREMENT'
  | 'NOT_INTERESTED'
  | 'SWITCH_OFF'
  | 'NOT_A_SOLAR_COMPANY'
  | 'CLOSED_WON'
  | 'LEAD_LOST'
  | 'SWITCH_OFF_DEAD'
  | 'DIDNT_RECEIVE_DEAD';

export interface CallLogEntry {
  id: string;
  timestamp: string;
  repEmail: string;
  repName: string;
  previousStatus: LeadStatus;
  newStatus: LeadStatus;
  note?: string;
}

export interface LeadRecord {
  id: string;
  companyName: string;
  companyNameNormalized: string; // lowercase, trimmed
  phoneNumber: string; // strictly 10 digits
  formattedPhone: string; // e.g., +91 94293 60746
  altNumber: string | null; // strictly 10 digits or null
  altNumberDialed?: boolean; // Phase 12 Task 2: Tracks whether altNumber was swapped & dialed
  state?: string | null;
  city?: string | null;
  email?: string | null;
  status: LeadStatus;
  assignedBatchId: string | null;
  assignedRepEmail: string | null;
  assignedRepName: string | null;
  callAttempts: number; // total times dialed
  didntReceiveCount: number; // max 10 before shifting to DIDNT_RECEIVE_DEAD
  switchOffCount: number; // max 3 before shifting to SWITCH_OFF_DEAD
  lastCalledDate: string | null; // ISO timestamp
  cooldownUntil: string | null; // ISO timestamp: lastCalledDate + 48 hours when status is DIDNT_RECEIVE
  nextFollowUpDate: string | null; // ISO timestamp
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  notes?: string;
  callHistory?: CallLogEntry[];
  // Phase 10: High-volume import rollback & real-time soft lock fields
  importBatchId?: string | null;
  currentCallerEmail?: string | null;
  currentCallerName?: string | null;
  lockedAt?: string | null;
  // Phase 13: WhatsApp Outreach Stamp fields
  lastWhatsAppSentAt?: string | null;
  lastWhatsAppTemplateName?: string | null;
  lastWhatsAppSentByEmail?: string | null;
  // Phase 14: Extended call telemetry fields
  callCount?: number;
  lastCalled?: string | null;
  lastCalledBy?: string | null;
  repEmail?: string | null;
  lastCalledByEmail?: string | null;
  lastCalledByName?: string | null;
  lastCallNotes?: string | null;
  // Executive & Rep Performance Analytics Tracking Metadata
  source?: 'manual' | 'excel' | null;
  createdByEmail?: string | null;
  createdByName?: string | null;
  createdByRole?: 'OWNER' | 'SALES' | null;
  interestedAt?: string | null;
  closedWonAt?: string | null;
  leadLostAt?: string | null;
  // Historical Import Remarks metadata
  remarks?: string | null;
  remarksAuthor?: string | null;
  remarksTimestamp?: string | null;
  // Hot Client Cross-Rep Escalation metadata
  escalatedByEmail?: string | null;
  escalatedByName?: string | null;
  isDualRepEscalation?: boolean;
  hotEscalationNote?: string | null;
  // Permanent Manual Company Name Edit protection flag
  isNameManuallyEdited?: boolean;
  // Owner Closing Pipeline metadata (locks INTERESTED leads permanently out of Fresh Pool)
  ownerSubStatus?: OwnerSubStatus | null;
  ownerCallAttempts?: number;
  lastOwnerCalledDate?: string | null;
}

export type OwnerSubStatus =
  | 'PENDING_FIRST_CALL'
  | 'DIDNT_RECEIVE_RETRY'
  | 'SWITCH_OFF_RETRY'
  | 'QUOTE_SHARED'
  | 'SITE_VISIT_SCHEDULED'
  | 'NEGOTIATION'
  | 'FUTURE_PROJECT'
  | 'WON'
  | 'LOST';

export type InterestedSubFilter =
  | 'ALL'
  | 'NEW_HANDOVER'
  | 'OWNER_RETRY'
  | 'QUOTE_NEGOTIATION';

import { DailyBatchDocument, BatchStatus, NightlySweepSummary } from '@/types/batch';

export type { DailyBatchDocument, BatchStatus, NightlySweepSummary };
export type BatchRecord = DailyBatchDocument;

export interface RawSheetRow {
  rowNumber: number;
  companyName: string;
  phoneNumberRaw: string;
  dateOfCalling?: string;
  state?: string;
  city?: string;
  email?: string;
  altNumberRaw?: string;
  statusRaw?: string;
  salesPersonRaw?: string;
  remarksRaw?: string;
}

export interface SanitizedRowItem {
  rowNumber: number;
  companyName: string;
  companyNameNormalized: string;
  phoneNumber: string;
  formattedPhone: string;
  altNumber: string | null;
  formattedAltPhone: string | null;
  state?: string;
  city?: string;
  email?: string;
  dateOfCalling?: string;
  // Historical Import Enriched Fields
  statusRaw?: string;
  importedStatus?: LeadStatus;
  isHistoricalCalled?: boolean;
  salesPersonRaw?: string;
  assignedRepEmail?: string | null;
  assignedRepName?: string | null;
  repFallbackWarning?: boolean;
  unmatchedSalesPersonWarning?: string | null;
  remarks?: string;
  parsedLastCalledDate?: string | null;
}

export interface DuplicateConflict {
  rowNumber: number;
  incoming: SanitizedRowItem;
  existingLead: LeadRecord;
  matchReason: 'PRIMARY_PHONE' | 'ALT_PHONE' | 'COMPANY_NAME';
}

export interface MalformedRowError {
  rowNumber: number;
  companyName: string;
  rawPhone: string;
  rawAltPhone?: string;
  reason: string;
}

export type DuplicateResolutionMode = 'SKIP' | 'OVERWRITE' | 'REVIEW';
