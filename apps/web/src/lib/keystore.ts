// The gateway only ever returns a full API key once (POST /keys). To let the in-app chat use a key
// without re-pasting it, we keep the secrets of keys created in THIS browser, keyed by id.
import { MOCK, STORAGE } from '../config';

const KEY = `${STORAGE.chatKey}.secrets`;

const MOCK_SECRETS: Record<string, string> = {
  '3': 'mesh_sk_7f3a2c91e4b8d0f6a5c3e9b1d7f2a8c4',
  '2': 'mesh_sk_b91e04aa3f6c2d8e1b7a9c5d4e0f6a2b',
};

export function loadSecrets(): Record<string, string> {
  let stored: Record<string, string> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
  } catch {
    stored = {};
  }
  return MOCK ? { ...MOCK_SECRETS, ...stored } : stored;
}

export function rememberSecret(id: number, key: string) {
  try {
    const all = loadSecrets();
    all[String(id)] = key;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: chat will ask for the key */
  }
}

/**
 * A key pasted by hand (pages/Chat.tsx rail). It is stored next to the created-here secrets under this
 * pseudo-id, and only ever leaves the browser as the Authorization header of a chat request.
 */
export const PASTED_ID = 'pasted';
const ACTIVE = `${STORAGE.chatKey}.active`;

/** `mesh_sk_` + at least 16 url-safe characters (apps/gateway/src/auth.ts API_KEY_PREFIX). */
export const isMeshKey = (s: string): boolean => /^mesh_sk_[A-Za-z0-9_-]{16,}$/.test(s.trim());

/** `mesh_sk_7f3a2c…a8c4` for labels; never the whole key. */
export const maskKey = (k: string): string => (k.length > 18 ? `${k.slice(0, 14)}…${k.slice(-4)}` : `${k.slice(0, 8)}…`);

export function rememberPastedKey(key: string) {
  try {
    const all = loadSecrets();
    all[PASTED_ID] = key.trim();
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: the key lives in memory for this page only */
  }
}

export function forgetPastedKey() {
  try {
    const all = loadSecrets();
    delete all[PASTED_ID];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/** Which kept key the chat sends with: a key id as a string, PASTED_ID, or null for "newest". */
export function loadActiveKeyId(): string | null {
  try {
    return localStorage.getItem(ACTIVE);
  } catch {
    return null;
  }
}

export function saveActiveKeyId(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE, id);
    else localStorage.removeItem(ACTIVE);
  } catch {
    /* ignore */
  }
}

export function forgetSecret(id: number) {
  try {
    const all = loadSecrets();
    delete all[String(id)];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}
