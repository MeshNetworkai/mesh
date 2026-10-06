// Renders scripts/og-card.html (the site's own type: headline, dots mark, three monoliths) to public/og.png.
// Run from apps/web: node scripts/og-card.mjs   (needs playwright-core + a Chromium; CI uses /opt/pw-browsers)
import { chromium } from 'playwright-core';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM, args: ['--no-sandbox', '--allow-file-access-from-files'] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })).newPage();
await page.goto('file://' + resolve(here, 'og-card.html'));
await page.waitForTimeout(800);
await page.screenshot({ path: resolve(here, '../public/og.png') });
await browser.close();
console.log('wrote public/og.png');
