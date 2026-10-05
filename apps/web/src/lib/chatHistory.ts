import type { Turn } from '../components/ChatThread';

/**
 * Chat history for /app/chat, kept in this browser only (localStorage). One list per owner: the
 * signed-in wallet, or `guest` for the free messages before a wallet is connected. On sign-in the
 * guest list is folded into the wallet's so the conversation in progress carries on. The gateway
 * never stores prompts or replies (docs/PRIVACY.md); this is the user's own copy.
 */

export const GUEST_OWNER = 'guest';
const PREFIX = 'mesh.chat.history.';
const MAX_CONVERSATIONS = 60;
const MAX_TURNS = 200;
const TITLE_CHARS = 56;

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: Turn[];
}

const keyFor = (owner: string) => `${PREFIX}${owner}`;

export function loadHistory(owner: string): Conversation[] {
  try {
    const raw = localStorage.getItem(keyFor(owner));
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter((c): c is Conversation => Boolean(c && typeof c === 'object' && typeof (c as Conversation).id === 'string' && Array.isArray((c as Conversation).turns)));
  } catch {
    return [];
  }
}

export function saveHistory(owner: string, conversations: Conversation[]) {
  try {
    const trimmed = conversations
      .filter((c) => c.turns.length > 0)
      .slice(0, MAX_CONVERSATIONS)
      // Never persist a half-streamed reply as streaming; the caret would be stuck on reload.
      .map((c) => ({ ...c, turns: c.turns.slice(-MAX_TURNS).map((t) => (t.streaming ? { ...t, streaming: false } : t)) }));
    if (trimmed.length === 0) localStorage.removeItem(keyFor(owner));
    else localStorage.setItem(keyFor(owner), JSON.stringify(trimmed));
  } catch {
    /* storage blocked or full: history is a convenience, the chat still works */
  }
}

/** Fold the guest list into the wallet's (newest first, no duplicates) and clear the guest key. */
export function migrateGuestHistory(wallet: string): Conversation[] {
  const guest = loadHistory(GUEST_OWNER);
  const mine = loadHistory(wallet);
  if (guest.length === 0) return mine;
  const ids = new Set(mine.map((c) => c.id));
  const merged = [...guest.filter((c) => !ids.has(c.id)), ...mine].sort((a, b) => b.updatedAt - a.updatedAt);
  saveHistory(wallet, merged);
  try {
    localStorage.removeItem(keyFor(GUEST_OWNER));
  } catch {
    /* ignore */
  }
  return merged;
}

export function newConversationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/** The first user message, on one line, trimmed to a rail-sized title. */
export function titleFor(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…` : line || 'New chat';
}
