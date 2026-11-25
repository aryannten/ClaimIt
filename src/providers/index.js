/**
 * Plugin-style provider registry.
 * Adding a new store requires adding a provider module and registering it here.
 */

import * as epic from './epic.js';

const PROVIDERS = [epic];

/**
 * Return all registered store providers.
 * @returns {Array<object>}
 */
export function getAllProviders() {
  return PROVIDERS.slice();
}

/**
 * Look up a provider by id.
 * @param {string} id
 * @returns {object|null}
 */
export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

/**
 * Return providers currently enabled in user settings.
 * Stubs marked `enabledByDefault: false` and `stub: true` stay disabled.
 * @param {object} settings
 * @returns {Array<object>}
 */
export function getEnabledProviders(settings) {
  return PROVIDERS.filter((provider) => {
    if (provider.stub === true) return false;
    const storeCfg = settings?.stores?.[provider.id];
    return Boolean(storeCfg?.enabled);
  });
}
