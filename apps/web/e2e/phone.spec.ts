import { expect, test } from '@playwright/test';
import { noHorizontalScroll, signIn } from './helpers';

/** 390 px viewport (project "phone"): nothing may be wider than the screen. */
const PAGES = ['/', '/docs', '/download', '/numbers', '/app/node', '/app/market'];

for (const path of PAGES) {
  test(`no horizontal scroll at 390px: ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const r = await noHorizontalScroll(page);
    expect(r.scrollWidth, JSON.stringify(r)).toBeLessThanOrEqual(r.clientWidth);
    expect(r.bodyScrollWidth, JSON.stringify(r)).toBeLessThanOrEqual(r.clientWidth);
  });
}

test('no horizontal scroll at 390px when signed in: /app, /app/keys, /app/chat', async ({ page }) => {
  await signIn(page);
  for (const path of ['/app', '/app/keys', '/app/chat']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const r = await noHorizontalScroll(page);
    expect(r.scrollWidth, `${path}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(r.clientWidth);
  }
});
