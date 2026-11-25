/**
 * Fab (Unreal Engine Marketplace / Fab.com) Provider Stub (not enabled yet).
 *
 * TODO:
 * - Query Fab's limited-time free assets/listings endpoint (bi-weekly free-for-limited-time drops)
 * - Exclude permanently free Fab listings
 * - Implement isOwned() check via Fab entitlement state
 * - Implement claim() using Epic/Fab active browser session
 */

import { CLAIM_STATUS } from './constants.js';

export const id = 'fab';
export const name = 'Fab';
export const stub = true;
export const enabledByDefault = false;

export async function fetchOffers() {
  // TODO: Implement Fab limited-time free asset discovery
  return [];
}

export async function isOwned() {
  // TODO: Implement Fab entitlement check
  return false;
}

export async function claim() {
  return {
    status: CLAIM_STATUS.NEEDS_USER,
    reason: 'Fab auto-claim is not implemented yet'
  };
}
