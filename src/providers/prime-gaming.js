/**
 * Prime Gaming Provider Stub (not enabled yet).
 *
 * TODO:
 * - Query Prime Gaming offers GraphQL / feed for free-to-keep PC keys/claims (GOG, Epic, Amazon Games)
 * - Filter out in-game loot unless explicitly enabled
 * - Implement isOwned() using claimed history / offer status badge
 * - Implement claim() or NEEDS_USER handoff for key redemption
 */

import { CLAIM_STATUS } from './constants.js';

export const id = 'prime';
export const name = 'Prime Gaming';
export const stub = true;
export const enabledByDefault = false;

export async function fetchOffers() {
  // TODO: Implement Prime Gaming offer discovery
  return [];
}

export async function isOwned() {
  // TODO: Implement Prime Gaming claimed-status detection
  return false;
}

export async function claim() {
  return {
    status: CLAIM_STATUS.NEEDS_USER,
    reason: 'Prime Gaming auto-claim is not implemented yet'
  };
}
