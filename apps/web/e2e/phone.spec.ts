import { expect, test } from '@playwright/test';
import { noHorizontalScroll, signIn } from './helpers';

/** 390 px viewport (project "phone"): nothing may be wider than the screen. */
const PAGES = ['/', '/docs', '/download', '/stats', '/app/node', '/app/market', '/app/chat'];

for (const path of PAGES) {
  test(`no horizontal scroll at 390px: ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const r = await noHorizontalScroll(page);
    expect(r.scrollWidth, JSON.stringify(r)).toBeLessThanOrEqual(r.clientWidth);
    expect(r.bodyScrollWidth, JSON.stringify(r)).toBeLessThanOrEqual(r.clientWidth);
  });
}

test('chat at 390px: the rail is a drawer behind the Chats button, the composer is on screen', async ({ page }) => {
  await page.goto('/app/chat');
  await expect(page.getByRole('heading', { name: 'What do you want to ask?' })).toBeVisible();
  const rail = page.locator('#chat-rail');
  const vw = page.viewportSize()!.width;
  const vh = page.viewportSize()!.height;
  expect((await rail.boundingBox())!.x + (await rail.boundingBox())!.width).toBeLessThanOrEqual(0); // off-canvas
  const composer = (await page.locator('#prompt').boundingBox())!;
  expect(composer.y + composer.height).toBeLessThanOrEqual(vh);
  await page.getByRole('button', { name: 'Chats' }).click();
  await expect(rail).toHaveClass(/open/);
  await expect.poll(async () => (await rail.boundingBox())!.x, { message: 'drawer slid in' }).toBe(0); // after the 0.2s transition
  expect((await rail.boundingBox())!.width).toBeLessThan(vw);
  await page.getByRole('button', { name: 'Close conversations' }).click();
  await expect(rail).not.toHaveClass(/open/);
});

test('no horizontal scroll at 390px when signed in: /app, /app/keys, /app/chat', async ({ page }) => {
  await signIn(page);
  for (const path of ['/app', '/app/keys', '/app/chat']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const r = await noHorizontalScroll(page);
    expect(r.scrollWidth, `${path}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(r.clientWidth);
  }
});
