import * as api from './api';
import { loadActiveKeyId, loadSecrets, rememberSecret, saveActiveKeyId } from './keystore';

/**
 * The API key a signed-in browser chats with: the active key from the keystore if its secret is still
 * here, else any live key we hold the secret for, else a fresh "Chat" key (secret kept in this browser
 * only). Shared by /app/chat and the homepage widget so both spend the same credits.
 */
export async function ensureChatKey(token: string): Promise<string> {
  const secrets = loadSecrets();
  const activeId = loadActiveKeyId();
  if (activeId && secrets[activeId]) return secrets[activeId];
  const keys = await api.listKeys(token).catch(() => []);
  const live = keys.filter((k) => !k.revoked && secrets[String(k.id)]).sort((a, b) => b.created_at - a.created_at)[0];
  if (live) {
    saveActiveKeyId(String(live.id));
    return secrets[String(live.id)];
  }
  const created = await api.createKey(token, { name: 'Chat' });
  rememberSecret(created.id, created.key);
  saveActiveKeyId(String(created.id));
  return created.key;
}
