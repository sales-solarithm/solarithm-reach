import { AuthorizedUser, BatchRecord, LeadRecord, RawSheetRow } from './types';

export const INITIAL_AUTHORIZED_USERS: AuthorizedUser[] = [
  {
    email: 'jalpaom2004@gmail.com',
    name: 'Jay Shah',
    role: 'owner',
    status: 'active',
  },
  {
    email: 'owner@solarithmdesign.com',
    name: 'Jay Shah',
    role: 'owner',
    status: 'active',
  },
  {
    email: 'jay@solarithmdesign.com',
    name: 'Jay Shah',
    role: 'owner',
    status: 'active',
  },
  {
    email: 'arjun@solarithmdesign.com',
    name: 'Arjun Deshmukh (VP Engineering)',
    role: 'owner',
    status: 'active',
  },
  {
    email: 'sales@solarithmdesign.com',
    name: 'Priya Nair (Sr. Solar Outreach Specialist)',
    role: 'sales',
    status: 'active',
  },
  {
    email: 'rohan@solarithmdesign.com',
    name: 'Rohan Kulkarni (Enterprise Telecaller)',
    role: 'sales',
    status: 'active',
  },
  {
    email: 'kavita@solarithmdesign.com',
    name: 'Kavita Sharma (C&I Solar Advisor)',
    role: 'sales',
    status: 'active',
  },
];

export const INITIAL_LEADS: LeadRecord[] = [];

export const INITIAL_BATCHES: BatchRecord[] = [];

export const SAMPLE_DIRTY_INGESTION_ROWS: RawSheetRow[] = [];

export function synthesizeBulkLeadsForBatchTest(_existingCount = 0): LeadRecord[] {
  return [];
}
