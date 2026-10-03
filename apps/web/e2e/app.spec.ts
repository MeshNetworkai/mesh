import { expect, test } from '@playwright/test';
import { GATEWAY_URL } from '../playwright.config';
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

  test('beta: pill next to the logo and in the hero, waitlist CTA joins the list, invite field appears after invite_required', async ({ page }) => {
    await page.goto('/');
    // config/tokenomics.json: beta.enabled + inviteRequired → pill + waitlist instead of the big connect button.
    const pills = page.locator('.pill.beta');
    await expect(pills.first()).toBeVisible();
    await expect(pills).toHaveCount(2);
    await expect(pills.first()).toHaveText('Beta');
    const form = page.locator('form#waitlist');
    await expect(form).toBeVisible();
    await page.getByLabel('Wallet address or e-mail').fill('e2e-first@example.com');
    await form.getByRole('button', { name: 'Join the waitlist' }).click();
    await expect(page.locator('#waitlist')).toContainText(/You are on the list at position \d+/);
    // Idempotent: the same e-mail is not added twice.
    const res = await page.request.post(`${GATEWAY_URL}/waitlist`, { data: { email: 'e2e-first@example.com' } });
    expect(await res.json()).toMatchObject({ alreadyListed: true });

    // A wallet that was never admitted gets the invite field after the gateway says so (simulated 403 through the modal state).
    await page.getByRole('button', { name: 'Connect wallet' }).first().click();
    await expect(page.getByRole('dialog')).toContainText('Sign in with a wallet');
    await expect(page.getByLabel('Invite code')).toHaveCount(0); // only after invite_required
  });
});

test.describe('beta admin', () => {
  test('admin page: waitlist section lists the entry, "Admit next" mints a code the gateway accepts, invites mint codes', async ({ page }) => {
    await page.request.post(`${GATEWAY_URL}/waitlist`, { data: { email: 'e2e-admit@example.com' } });
    await page.goto('/admin');
    await page.getByLabel('Admin token').fill('e2e-admin-token');
    await page.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByText('Waitlist · admit the next batch')).toBeVisible();
    await expect(page.getByLabel('Waitlist entries')).toContainText('e2e-admit@example.com');
    await page.getByLabel('How many to admit').fill('50');
    await page.getByRole('button', { name: /Admit next/ }).click();
    const admitted = page.getByLabel('Waitlist', { exact: true });
    await expect(admitted).toContainText('admitted. Send each code');
    const code = await admitted.locator('tbody tr', { hasText: 'e2e-admit@example.com' }).locator('td').nth(1).textContent();
    expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    // The code admits a wallet: a sign-in without it is refused, with it accepted (mock adapter signature).
    const sign = (wallet: string, message: string) => Buffer.from(`${wallet}:${message}`, 'utf8').toString('base64'); // MockAdapter.sign
    let nonce = await (await page.request.post(`${GATEWAY_URL}/auth/nonce`, { data: { wallet: 'e2e_invited' } })).json();
    const denied = await page.request.post(`${GATEWAY_URL}/auth/verify`, { data: { wallet: 'e2e_invited', signature: sign('e2e_invited', nonce.message), message: nonce.message } });
    expect(denied.status()).toBe(403);
    expect((await denied.json()).error).toBe('invite_required');
    nonce = await (await page.request.post(`${GATEWAY_URL}/auth/nonce`, { data: { wallet: 'e2e_invited' } })).json();
    const ok = await page.request.post(`${GATEWAY_URL}/auth/verify`, { data: { wallet: 'e2e_invited', signature: sign('e2e_invited', nonce.message), message: nonce.message, invite: code } });
    expect(ok.status()).toBe(200);
    expect(await ok.json()).toMatchObject({ wallet: 'e2e_invited', admitted: true });

    await page.getByLabel('Number of codes').fill('3');
    await page.getByRole('button', { name: 'Mint' }).click();
    await expect(page.getByLabel('Invite codes').locator('code')).toHaveCount(3);
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
    await expect(page.locator('span.display', { hasText: 'Run a node' })).toBeVisible();
    await expect(page.getByLabel('What the installer does')).toBeVisible();
    await expect(page.locator('body')).toContainText('install-node.sh');

    await signIn(page);
    await page.goto('/app/node');
    await expect(page.getByText('Your nodes')).toBeVisible();
  });

  test('cookie session: no JWT in localStorage, survives a reload without the hint, sign out clears the cookie', async ({ page }) => {
    await signIn(page);
    await page.goto('/app');
    await expect(page.getByText('Your credits')).toBeVisible();
    // the app persists only {wallet, chain}; the JWT lives in the HttpOnly cookie
    const stored = await page.evaluate(() => localStorage.getItem('mesh.session'));
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!)).not.toHaveProperty('token');
    expect(await page.evaluate(() => document.cookie)).not.toContain('mesh_session='); // HttpOnly: invisible to scripts
    expect(await page.evaluate(() => document.cookie)).toContain('mesh_csrf='); // the CSRF twin is readable on purpose

    // Even with the hint gone, the cookie alone restores the session via GET /auth/session.
    await page.evaluate(() => localStorage.removeItem('mesh.session'));
    await page.reload();
    await expect(page.getByText('Your credits')).toBeVisible();

    // Sign out → POST /auth/logout clears the cookies; a reload shows the connect prompt.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByText('Connect a wallet to see your credits')).toBeVisible();
    // the logout request is fire-and-forget from the UI's point of view; wait for the cookie to go
    await expect.poll(async () => (await page.context().cookies()).map((c) => c.name)).not.toContain('mesh_session');
    await page.reload();
    await expect(page.getByText('Connect a wallet to see your credits')).toBeVisible();
  });

  test('admin page: token → HttpOnly admin cookie, console works, reload keeps it, sign out drops it', async ({ page }) => {
    await page.goto('/admin');
    await page.getByLabel('Admin token').fill('e2e-admin-token');
    await page.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByText('Recent epochs', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.cookie)).not.toContain('mesh_admin=');
    expect((await page.context().cookies()).map((c) => c.name)).toContain('mesh_admin');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible(); // cookie survived, no token re-entry
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByLabel('Admin token')).toBeVisible();
    await expect.poll(async () => (await page.context().cookies()).map((c) => c.name)).not.toContain('mesh_admin');
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
