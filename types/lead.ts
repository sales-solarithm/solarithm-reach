import {
  AuthorizedUser,
  CallLogEntry,
  DuplicateConflict,
  DuplicateResolutionMode,
  LeadRecord,
  LeadStatus,
  MalformedRowError,
  RawSheetRow,
  SanitizedRowItem,
  UserRole,
} from '@/lib/types';

export interface LeadActivityTrackingMetadata {
  createdByEmail: string | null;
  createdByName: string | null;
  createdByRole: 'OWNER' | 'SALES' | null;
  lastCalledByEmail: string | null;
  lastCalledByName: string | null;
  lastCalledDate: string | null;
  interestedAt: string | null;
  closedWonAt: string | null;
}

export type {
  AuthorizedUser,
  CallLogEntry,
  DuplicateConflict,
  DuplicateResolutionMode,
  LeadRecord,
  LeadStatus,
  MalformedRowError,
  RawSheetRow,
  SanitizedRowItem,
  UserRole,
};
