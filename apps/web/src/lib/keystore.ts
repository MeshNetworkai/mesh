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

export function forgetSecret(id: number) {
  try {
    const all = loadSecrets();
    delete all[String(id)];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}
