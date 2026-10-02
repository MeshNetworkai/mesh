import type { Page } from '@playwright/test';
import { ADMIN_TOKEN, GATEWAY_URL } from '../playwright.config';

export const WALLET = 'mockwallet_alice';

/** Mint a session JWT through the (dev-only) admin endpoint, exactly like scripts/demo.sh. */
export async function devLogin(wallet = WALLET): Promise<{ token: string; wallet: string; chain: string }> {
  const res = await fetch(`${GATEWAY_URL}/admin/dev-login`, {
    method: 'POST',
    headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ wallet }),
  });
  if (!res.ok) throw new Error(`dev-login ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ token: string; wallet: string; chain: string }>;
}

/** Install the session in localStorage before any page script runs (the app reads `mesh.session` on boot). */
export async function signIn(page: Page, wallet = WALLET) {
  const session = await devLogin(wallet);
  await page.addInitScript((s) => {
    localStorage.setItem('mesh.session', JSON.stringify({ token: s.token, wallet: s.wallet, chain: s.chain }));
  }, session);
  return session;
}

export async function balanceUsd(token: string): Promise<number> {
  const res = await fetch(`${GATEWAY_URL}/me`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`/me ${res.status}`);
  const me = (await res.json()) as { balance: { usd: number } };
  return me.balance.usd;
}

/** Parse "$1.234" / "$0.0010" / "1.2k" style text into a number (null when not a number). */
export function parseUsd(text: string | null): number | null {
  if (!text) return null;
  const m = text.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

export async function noHorizontalScroll(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const over = [...document.querySelectorAll<HTMLElement>('body *')].filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 1).slice(0, 5);
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      offenders: over.map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}:${Math.round(el.getBoundingClientRect().right)}`),
    };
  });
}
