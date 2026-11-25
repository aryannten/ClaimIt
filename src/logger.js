/**
 * Structured ring-buffer logger backed by chrome.storage.local (last 200 entries).
 */

export const MAX_LOG_ENTRIES = 200;
export const LOG_STORAGE_KEY = 'claimit_logs';

/**
 * Pure helper to append an entry to a bounded ring buffer.
 * @param {object[]} existing
 * @param {object} entry
 * @param {number} [maxEntries=200]
 * @returns {object[]}
 */
export function appendToRingBuffer(existing, entry, maxEntries = MAX_LOG_ENTRIES) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  list.push(entry);
  if (list.length > maxEntries) {
    return list.slice(list.length - maxEntries);
  }
  return list;
}

/**
 * Format a structured log entry.
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} scope
 * @param {string} message
 * @param {object} [meta]
 * @returns {object}
 */
export function createLogEntry(level, scope, message, meta = null) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    meta: meta ?? null
  };
}

let writeQueue = Promise.resolve();

function hasChromeStorage() {
  return typeof chrome !== 'undefined' && Boolean(chrome?.storage?.local);
}

/**
 * Persist a log entry into the chrome.storage.local ring buffer sequentially.
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} scope
 * @param {string} message
 * @param {object} [meta]
 */
export function writeLog(level, scope, message, meta = null) {
  const entry = createLogEntry(level, scope, message, meta);
  if (!hasChromeStorage()) {
    return Promise.resolve(entry);
  }

  writeQueue = writeQueue
    .then(async () => {
      const data = await chrome.storage.local.get(LOG_STORAGE_KEY);
      const updated = appendToRingBuffer(data[LOG_STORAGE_KEY], entry, MAX_LOG_ENTRIES);
      await chrome.storage.local.set({ [LOG_STORAGE_KEY]: updated });
      return entry;
    })
    .catch(() => entry);

  return writeQueue;
}

export const logger = {
  debug: (scope, message, meta) => writeLog('debug', scope, message, meta),
  info: (scope, message, meta) => writeLog('info', scope, message, meta),
  warn: (scope, message, meta) => writeLog('warn', scope, message, meta),
  error: (scope, message, meta) => writeLog('error', scope, message, meta),

  async getAll() {
    if (!hasChromeStorage()) return [];
    await writeQueue;
    const data = await chrome.storage.local.get(LOG_STORAGE_KEY);
    return Array.isArray(data[LOG_STORAGE_KEY]) ? data[LOG_STORAGE_KEY] : [];
  },

  async clear() {
    if (!hasChromeStorage()) return;
    writeQueue = writeQueue.then(() => chrome.storage.local.set({ [LOG_STORAGE_KEY]: [] }));
    return writeQueue;
  }
};
