/**
 * itch.io Provider Stub (not enabled yet).
 *
 * TODO:
 * - Scrape or query https://itch.io/games/on-sale / 100%-off sale bundles
 * - Filter out permanent free/pay-what-you-want titles (require originalPrice > 0 & 100% sale)
 * - Implement isOwned() via itch.io library/purchase state
 * - Implement claim() by clicking "Download or claim" / "No thanks, just take me to the downloads"
 */

import { CLAIM_STATUS } from './constants.js';

export const id = 'itch';
export const name = 'itch.io';
export const stub = true;
export const enabledByDefault = false;

export async function fetchOffers() {
  // TODO: Implement itch.io 100%-off sales parser
  return [];
}

export async function isOwned() {
  // TODO: Implement itch.io ownership check
  return false;
}

export async function claim() {
  return {
    status: CLAIM_STATUS.NEEDS_USER,
    reason: 'itch.io auto-claim is not implemented yet'
  };
}
