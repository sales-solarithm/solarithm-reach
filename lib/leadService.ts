import { reachDb } from './firebaseDual';

/**
 * Operational Lead Service (`lib/leadService.ts`)
 * Bound strictly to `reachDb` (`solarithm-tools-370ed`) for all lead records,
 * Excel uploads, call notes, dispositions, and owner closing metrics.
 */
export const leadOperationalDb = reachDb;

export { reachDb };
export * from './leadStore';
