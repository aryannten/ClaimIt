/**
 * GOG Store Provider Stub (not enabled yet).
 *
 * TODO:
 * - Fetch GOG giveaway banner / catalog endpoint (e.g. https://www.gog.com/#giveaway)
 * - Detect 100%-off limited-time giveaways vs permanent free classics
 * - Implement isOwned() via GOG user library / product page state
 * - Implement claim() by clicking the giveaway claim banner using active browser session
 */

import { CLAIM_STATUS } from './constants.js';

export const id = 'gog';
export const name = 'GOG';
export const stub = true;
export const enabledByDefault = false;

export async function fetchOffers() {
  // TODO: Implement GOG giveaway scraping/API lookup
  return [];
}

export async function isOwned() {
  // TODO: Check GOG library ownership
  return false;
}

export async function claim() {
  return {
    status: CLAIM_STATUS.NEEDS_USER,
    reason: 'GOG auto-claim is not implemented yet'
  };
}
