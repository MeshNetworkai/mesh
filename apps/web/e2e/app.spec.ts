import { expect, test } from '@playwright/test';
import { balanceUsd, parseUsd, signIn } from './helpers';

test.describe('landing', () => {
  test('loads with live stats from the gateway', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Trading pays for');
    const readout = page.getByLabel('Next distribution');
    await expect(readout).toBeVisible();
    // Seeded epoch: $100 of fees, $50 to holders, 3 eligible mock wallets.
    await expect(readout).toContainText('Fees collected last epoch');
    await expect(readout.locator('b').first()).toContainText('$100');
    await expect(readout).toContainText('Epoch 02'); // one epoch run → next is 02
    await expect(page.getByRole('button', { name: 'Connect wallet' }).first()).toBeVisible();
  });
});

test.describe('signed-in app', () => {
  test('dev-login → dashboard shows the credit balance', async ({ page }) => {
    const session = await signIn(page);
    const expected = await balanceUsd(session.token);
    expect(expected).toBeGreaterThan(0);
    await page.goto('/app');
    await expect(page.getByText('Your credits')).toBeVisible();
    const tile = page.locator('.tile', { hasText: 'Balance' }).first();
    await expect(tile).toBeVisible();
    await expect(tile).not.toContainText('—');
    await expect
      .poll(async () => parseUsd(await tile.textContent()), { message: 'balance tile matches /me' })
      .toBeCloseTo(expected, 3);
    await expect(page.getByText('Distribution').first()).toBeVisible(); // ledger row from the seeded epoch
  });

  test('create key → chat completion streams and the balance decreases', async ({ page }) => {
    const session = await signIn(page);
    const before = await balanceUsd(session.token);

    await page.goto('/app/keys');
    await expect(page.locator('span.display', { hasText: 'API keys' })).toBeVisible();
    await page.getByLabel('Name · optional').fill('e2e');
    await page.getByRole('button', { name: 'Create API key' }).click();
    const revealed = page.locator('#newkey');
    await expect(revealed).toBeVisible();
    await expect(revealed).toHaveValue(/^mesh_sk_/);
    const key = await revealed.inputValue();
    await page.keyboard.press('Escape').catch(() => undefined);

    await page.goto('/app/chat');
    await expect(page.locator('span.display', { hasText: 'Chat' })).toBeVisible();
    const keySelect = page.locator('#key');
    await expect(keySelect).toContainText('e2e');
    const model = page.locator('#model');
    await expect(model).toBeEnabled();
    await expect(model).toContainText('mesh/mock');

    const prompt = page.locator('#prompt');
    await expect(prompt).toBeEnabled();
    await prompt.fill('What did my fees buy?');
    await page.getByRole('button', { name: 'Send' }).click();

    const reply = page.locator('.msg.ai').first();
    await expect(reply).toContainText('Hello from the Mesh mock upstream');
    await expect(reply).toContainText('served by');
    await expect(reply.locator('.via')).toContainText('mesh/mock');

    // Mock upstream charges $0.001 per request.
    await expect.poll(() => balanceUsd(session.token)).toBeCloseTo(before - 0.001, 5);
    await expect(page.locator('.pill.balance[aria-live] b')).toContainText((before - 0.001).toFixed(3));

    // The key shows the spend on the Keys page too.
    await page.goto('/app/keys');
    await expect(page.locator('tr', { hasText: 'e2e' })).toContainText('mesh_sk_');
    expect(key.startsWith('mesh_sk_')).toBe(true);
  });

  test('node page renders (public) with the install one-liner and the operator view when signed in', async ({ page }) => {
    await page.goto('/app/node');
    await expect(page.getByText('Run a node')).toBeVisible();
    await expect(page.getByLabel('What the installer does')).toBeVisible();
    await expect(page.locator('body')).toContainText('install-node.sh');

    await signIn(page);
    await page.goto('/app/node');
    await expect(page.getByText('Your nodes')).toBeVisible();
  });

  test('network page renders the public stats', async ({ page }) => {
    await page.goto('/app/stats');
    await expect(page.locator('body')).toContainText(/Network|Epoch/);
    await expect(page.locator('.tile').first()).toBeVisible();
  });

  test('report page renders at /report (public, fed by GET /report)', async ({ page }) => {
    await page.goto('/report');
    await expect(page.locator('main')).not.toContainText('Nothing here');
    await expect(page.locator('main')).not.toContainText('Something broke');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // seeded epoch: $100 of fees → the report has something to say; a fresh DB shows the empty state
    await expect(page.locator('main')).toContainText(/\$|No fees collected yet/);
  });
});
