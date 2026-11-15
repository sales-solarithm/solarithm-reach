export type AuditActorRole =
  | 'owner'
  | 'sales'
  | 'system'
  | 'OWNER'
  | 'ADMIN'
  | 'SALES'
  | 'LEAD_SALES';

export type AuditActionType =
  | 'CALL_LOGGED'
  | 'STATUS_CHANGED'
  | 'LEAD_CLAIMED'
  | 'BATCH_RESET'
  | 'MANUALLY_TRANSFERRED'
  | 'DUPLICATE_OVERWRITTEN'
  | 'CLOSED_WON'
  | 'LEAD_LOST'
  | 'WHATSAPP_DISPATCHED';

export interface AuditLogMetadata {
  companyName?: string;
  phoneNumber?: string;
  batchId?: string | null;
  fromRepEmail?: string | null;
  fromRepName?: string | null;
  toRepEmail?: string | null;
  toRepName?: string | null;
  callNote?: string;
  dealValueInr?: string;
  lossReason?: string;
  duplicateMatchReason?: string;
  remediationReason?: string;
  templateName?: string;
  dispatchedByEmail?: string;
  dispatchedAt?: string;
  compiledMessage?: string;
  [key: string]: unknown;
}

export interface AuditLogRecord {
  id: string;
  leadId: string;
  actorEmail: string; // User or system executing the change
  actorName: string;
  actorRole: AuditActorRole;
  actionType: AuditActionType;
  previousStatus: string | null;
  newStatus: string;
  metadata: AuditLogMetadata;
  timestamp: string; // ISO string
}

export interface CreateAuditLogInput {
  id?: string;
  leadId: string;
  actorEmail: string;
  actorName: string;
  actorRole: AuditActorRole;
  actionType: AuditActionType;
  previousStatus: string | null;
  newStatus: string;
  metadata?: AuditLogMetadata;
  timestamp?: string;
}
