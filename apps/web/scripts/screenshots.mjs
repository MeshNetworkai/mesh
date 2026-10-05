// Screenshots of the mock-mode UI at desktop and phone widths.
// Usage: pnpm --filter web screenshots   (starts the Vite dev server with VITE_MOCK=1 on a free port)
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const outDir = process.env.SCREENS_DIR ?? resolve(webRoot, '../../docs/screens');
const PORT = Number(process.env.SCREENS_PORT ?? 4173);
const BASE = `http://127.0.0.1:${PORT}`;

const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) throw new Error(`No chromium found in ${CANDIDATES.join(', ')}`);

mkdirSync(outDir, { recursive: true });

const PAGES = [
  { path: '/', name: 'landing', full: true },
  // Beta: the landing as a stranger sees it (pill, waitlist CTA) and the sign-in modal asking for an invite code.
  { path: '/', name: 'landing-beta', full: true, anon: true },
  { path: '/', name: 'invite', anon: true },
  { path: '/app', name: 'app' },
  { path: '/app/keys', name: 'keys' },
  { path: '/app/chat', name: 'chat' },
  { path: '/app/stats', name: 'stats', full: true },
  { path: '/app/node', name: 'node', full: true },
  { path: '/app/market', name: 'market', full: true },
  { path: '/report', name: 'report', full: true },
  { path: '/download', name: 'download', full: true },
  // /leaderboard: points programme is built but disabled (404 while off), so it is not captured.
  { path: '/admin', name: 'admin', full: true },
  { path: '/api', name: 'api', full: true },
  { path: '/terms', name: 'terms', full: true },
  { path: '/404', name: '404', full: true },
];
// SCREENS_ONLY=landing,api limits the run to those page names.
const only = process.env.SCREENS_ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
const SELECTED = only?.length ? PAGES.filter((p) => only.includes(p.name)) : PAGES;
const WIDTHS = [
  { w: 1440, h: 900, tag: '1440' },
  { w: 390, h: 844, tag: '390' },
];

const reuse = process.env.SCREENS_REUSE === '1';
const server = reuse ? null : spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1', '--clearScreen', 'false'], {
  cwd: webRoot,
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, VITE_MOCK: '1' },
  detached: true, // own process group so we can stop npx + vite together
});
if (server) await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('dev server did not start')), 30_000);
  server.stdout.on('data', (d) => {
    if (String(d).includes('127.0.0.1')) {
      clearTimeout(t);
      res();
    }
  });
  server.on('exit', (c) => rej(new Error(`vite exited ${c}`)));
});

const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
try {
  for (const { w, h, tag } of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: 'light' });
    // Pre-authenticate with the mock session so /app pages render signed in.
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem(
          'mesh.session',
          JSON.stringify({ token: 'mock.jwt.token', wallet: '9xQeKf2sVbT7mRw3Lp8nHJq4cYzA6dEuGk1oXiSNHn4k', chain: 'solana' }),
        );
        localStorage.setItem('mesh.theme', 'light');
      } catch {}
    });
    // No third-party requests in CI: fonts are self-hosted via @fontsource.
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
    // Signed-out context for the `anon` pages (the init script above would re-seed the session on every load).
    const anonCtx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: 'light' });
    await anonCtx.addInitScript(() => {
      try {
        localStorage.setItem('mesh.theme', 'light');
      } catch {}
    });
    await anonCtx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
    const authedPage = await ctx.newPage();
    const anonPage = await anonCtx.newPage();
    const errors = [];
    authedPage.on('pageerror', (e) => errors.push(e.message));
    anonPage.on('pageerror', (e) => errors.push(e.message));
    for (const p of SELECTED) {
      const page = p.anon ? anonPage : authedPage;
      console.log(`→ ${p.path} @ ${w}${p.anon ? ' (signed out)' : ''}`);
      await page.goto(`${BASE}${p.path}`, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready.then(() => true));
      await page.waitForTimeout(900); // let mock latency + fonts settle
      if (p.name === 'invite') {
        // Open the sign-in modal and try the mock wallet without a code: the gateway's `invite_required` shows the field.
        await page.locator('form#waitlist').waitFor({ timeout: 8000 }).catch(() => {});
        await page.getByRole('button', { name: 'Connect wallet' }).first().click();
        await page.locator('.wallet-btn', { hasText: 'Mock wallet' }).click();
        await page.locator('#invite-code').waitFor({ timeout: 8000 }).catch(() => {});
        await page.locator('#invite-code').fill('K7QM2-XDA4P').catch(() => {});
        await page.waitForTimeout(300);
      }
      if (p.name === 'admin') {
        // type the (mock) admin token so the console renders; it is kept in memory only
        const field = page.locator('#admin-token');
        await field.waitFor({ state: 'visible' });
        await field.fill('dev-admin-token');
        await page.keyboard.press('Enter');
        await page.locator('.panels').first().waitFor({ timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(700);
      }
      if (p.name === 'chat') {
        // send one message so the "served by …" line is visible
        const ta = page.locator('#prompt');
        await ta.waitFor({ state: 'visible' });
        await page.waitForFunction(() => !document.querySelector('#prompt')?.disabled, null, { timeout: 8000 }).catch(() => {});
        await ta.fill('Summarise this clause without sending it anywhere public.');
        await page.keyboard.press('Enter');
        await page.locator('.msg.ai .via').first().waitFor({ timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(300);
      }
      const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
      if (scrollW > w) console.warn(`  ! horizontal overflow on ${p.path} @ ${w}: scrollWidth=${scrollW}`);
      const file = resolve(outDir, `${p.name}-${tag}.png`);
      await page.screenshot({ path: file, fullPage: Boolean(p.full) || w < 500 });
      console.log(`saved ${file}`);
    }
    if (errors.length) console.warn('page errors:', errors);
    await ctx.close();
    await anonCtx.close();
  }
} finally {
  await browser.close();
  if (server) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  }
}
process.exit(0);
