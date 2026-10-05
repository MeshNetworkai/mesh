import { expect, test } from '@playwright/test';
import { GATEWAY_URL } from '../playwright.config';
import { balanceUsd, parseUsd, signIn } from './helpers';

test.describe('landing', () => {
  test('centred hero with the wide guest chat, two-engine diagram, four ways in, live numbers from the gateway', async ({ page }) => {
    await page.goto('/');
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toContainText('Trades fund it.');
    await expect(h1).toContainText('Macs serve it.');
    // config/tokenomics.json ships usageShare.enabled=false → the third line is the holders one, and the
    // engine-2 arrow into the pool is dashed with a "coming" label (never claimed live).
    await expect(h1).toContainText('Holders use it.');
    await expect(h1).not.toContainText('Usage funds it.');
    const engines = page.locator('.engines');
    await expect(engines).toHaveAttribute('data-usage-share', 'off');
    await expect(engines.locator('svg.wide')).toBeVisible();
    await expect(engines.locator('svg.wide')).toContainText('30% share · coming');
    await expect(engines.locator('svg.wide')).toContainText('1.5% fee');
    await expect(page.getByText('Nothing is minted to pay anyone.')).toBeVisible();
    // Lede names the four things the product does.
    const lede = page.locator('.home-hero .lede');
    await expect(lede).toContainText('every hour');
    await expect(lede).toContainText('Macs');
    await expect(lede).toContainText('marketplace');
    await expect(lede).toContainText('frontier models');
    // One centred column: headline and chat card share the viewport's centre line; the chat is the wide object.
    const h1Box = (await h1.boundingBox())!;
    const chat = page.getByLabel('Try the network');
    await expect(chat).toBeVisible();
    const chatBox = (await chat.boundingBox())!;
    const vw = page.viewportSize()!.width;
    expect(Math.abs(h1Box.x + h1Box.width / 2 - vw / 2)).toBeLessThan(8);
    expect(Math.abs(chatBox.x + chatBox.width / 2 - vw / 2)).toBeLessThan(8);
    expect(chatBox.width).toBeGreaterThan(800);
    // Live guest chat: quota pill from GET /v1/guest/quota, model picker, suggested prompts, composer.
    await expect(chat).toContainText('Live · Mesh network');
    await expect(chat.locator('.pill.num')).toContainText(/\d+ \/ \d+ free/);
    await expect(chat.getByLabel('Model')).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Explain how Mesh pays for AI' })).toBeVisible();
    await expect(chat.getByLabel('Message')).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Send' })).toBeDisabled();
    // Key figures come from config/tokenomics.json (+ the marketplace fee).
    const figures = page.getByLabel('Key figures');
    await expect(figures).toContainText('1.5%');
    await expect(figures).toContainText('1,000 MESH');
    await expect(figures).toContainText('2.5%');
    // Numbered sections in order.
    for (const t of ['01 · How the money moves', '02 · Four ways in', "03 · Why it's different", '04 · Privacy, stated plainly', '05 · Live numbers']) {
      await expect(page.getByText(t, { exact: true })).toBeVisible();
    }
    // Four ways in, with the live liquidity book (GET /market/book) in the "sell" column.
    await expect(page.locator('.pillars.four .pillar')).toHaveCount(4);
    await expect(page.getByLabel('Credit market, live')).toBeVisible();
    await expect(page.locator('.pillar').filter({ hasText: "Sell what you don't use" }).getByRole('link', { name: 'Open the market' })).toHaveAttribute('href', '/app/market');
    // Switch strip points at the API page's guide.
    await expect(page.getByRole('link', { name: /Snippets for curl/ })).toHaveAttribute('href', '/api#switch');
    // Seeded epoch: $100 of fees → "Fees collected" tile shows $100, one epoch run; the numbers link goes to /numbers.
    await expect(page.getByText('Fees collected', { exact: true }).locator('..')).toContainText('$100');
    await expect(page.getByText(/1 epochs run/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'All the numbers' })).toHaveAttribute('href', '/numbers');
    await expect(page.getByRole('heading', { name: /Four doors/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect wallet' }).first()).toBeVisible();
  });

  test('open beta: pill next to the logo and in the hero, normal connect CTA (no waitlist form), waitlist API still open', async ({ page }) => {
    await page.goto('/');
    // config/tokenomics.json: beta.enabled + inviteRequired=false → pill shown, but the hero keeps the
    // big connect button instead of the waitlist form. (The gated flow is covered by apps/gateway/test/beta.test.ts.)
    const pills = page.locator('.pill.beta');
    await expect(pills.first()).toBeVisible();
    await expect(pills).toHaveCount(2);
    await expect(pills.first()).toHaveText('Beta');
    await expect(pills.first()).toHaveAttribute('title', 'Public beta');
    await expect(page.locator('form#waitlist')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Connect wallet' }).first()).toBeVisible();

    // The public waitlist endpoint stays open while beta.enabled (idempotent per e-mail).
    const first = await page.request.post(`${GATEWAY_URL}/waitlist`, { data: { email: 'e2e-first@example.com' } });
    expect(first.status()).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, alreadyListed: false, beta: { inviteRequired: false } });
    const again = await page.request.post(`${GATEWAY_URL}/waitlist`, { data: { email: 'e2e-first@example.com' } });
    expect(await again.json()).toMatchObject({ alreadyListed: true });

    // Sign-in modal opens; no invite field (only ever shown after a 403 invite_required, which open beta never sends).
    await page.getByRole('button', { name: 'Connect wallet' }).first().click();
    await expect(page.getByRole('dialog')).toContainText('Sign in with a wallet');
    await expect(page.getByLabel('Invite code')).toHaveCount(0);
  });
});

test.describe('beta admin', () => {
  test('admin page: waitlist section lists the entry, "Admit next" mints a code, sign-in needs no code in open beta, invites mint codes', async ({ page }) => {
    await page.request.post(`${GATEWAY_URL}/waitlist`, { data: { email: 'e2e-admit@example.com' } });
    await page.goto('/admin');
    await page.getByLabel('Admin token').fill('e2e-admin-token');
    await page.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByText(/beta · open/)).toBeVisible();
    await expect(page.getByText('Waitlist · admit the next batch')).toBeVisible();
    await expect(page.getByLabel('Waitlist entries')).toContainText('e2e-admit@example.com');
    await page.getByLabel('How many to admit').fill('50');
    await page.getByRole('button', { name: /Admit next/ }).click();
    const admitted = page.getByLabel('Waitlist', { exact: true });
    await expect(admitted).toContainText('admitted. Send each code');
    const code = await admitted.locator('tbody tr', { hasText: 'e2e-admit@example.com' }).locator('td').nth(1).textContent();
    expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    // Open beta (inviteRequired=false): a never-admitted wallet signs in WITHOUT a code (mock adapter signature).
    // The gated variant (403 invite_required until a code is supplied) lives in apps/gateway/test/beta.test.ts.
    const sign = (wallet: string, message: string) => Buffer.from(`${wallet}:${message}`, 'utf8').toString('base64'); // MockAdapter.sign
    let nonce = await (await page.request.post(`${GATEWAY_URL}/auth/nonce`, { data: { wallet: 'e2e_open' } })).json();
    const open = await page.request.post(`${GATEWAY_URL}/auth/verify`, { data: { wallet: 'e2e_open', signature: sign('e2e_open', nonce.message), message: nonce.message } });
    expect(open.status()).toBe(200);
    expect(await open.json()).toMatchObject({ wallet: 'e2e_open', admitted: true });
    // Supplying a minted code in open beta is harmless: the gate is skipped and the sign-in succeeds.
    nonce = await (await page.request.post(`${GATEWAY_URL}/auth/nonce`, { data: { wallet: 'e2e_invited' } })).json();
    const withCode = await page.request.post(`${GATEWAY_URL}/auth/verify`, { data: { wallet: 'e2e_invited', signature: sign('e2e_invited', nonce.message), message: nonce.message, invite: code } });
    expect(withCode.status()).toBe(200);
    expect(await withCode.json()).toMatchObject({ wallet: 'e2e_invited', admitted: true });

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
    // The picker defaults to the network's Llama 3.1 8B; pick the offline mock so the reply is deterministic.
    const model = page.locator('#model');
    await expect(model).toBeEnabled();
    await expect(model).toContainText('Llama 3.1 8B');
    await model.click();
    await page.getByRole('option', { name: /Mesh mock/ }).click();
    await expect(model).toContainText('Mesh mock');

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

  test('top nav: Chat · Market · Run a node · Numbers · Docs, market and node readable signed out', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    const labels = await nav.getByRole('link').allInnerTexts();
    expect(labels.map((l) => l.trim()).filter((l) => l !== 'Mesh' && !l.startsWith('Mesh'))).toEqual(['Chat', 'Market', 'Run a node', 'Numbers', 'Docs']);
    await expect(nav.getByRole('link', { name: 'Download' })).toHaveCount(0);
    await expect(page.locator('footer').getByRole('link', { name: 'Download for Mac' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
    await nav.getByRole('link', { name: 'Market' }).click();
    await expect(page).toHaveURL(/\/app\/market$/);
    await expect(page.locator('span.display', { hasText: 'Credit market' })).toBeVisible();
    await expect(page.getByText('Connect a wallet to see your credits')).toHaveCount(0);
    await nav.getByRole('link', { name: 'Run a node' }).click();
    await expect(page).toHaveURL(/\/app\/node$/);
  });

  test('numbers page: live tiles, epochs, weekly report, treasury/market/usage-share; /stats and /report redirect with the hash', async ({ page }) => {
    await page.goto('/numbers');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('main')).toContainText(/\$|No fees collected yet/);
    for (const id of ['live', 'epochs', 'report', 'treasury']) await expect(page.locator(`section#${id}`)).toBeVisible();
    await expect(page.locator('#live .tile').first()).toBeVisible();
    await expect(page.locator('#live')).toContainText('Fees all time');
    await expect(page.locator('#epochs table tbody tr')).toHaveCount(1); // the seeded epoch
    await expect(page.locator('#report')).toContainText('Weekly report');
    await expect(page.locator('#treasury')).toContainText('Treasury ledger');
    await expect(page.locator('#treasury')).toContainText('Credit marketplace');
    await expect(page.locator('#treasury')).toContainText('Usage-revenue share');
    await expect(page.locator('#treasury .pill', { hasText: 'off' })).toBeVisible(); // usageShare ships disabled
    await expect(page.locator('main')).not.toContainText('Something broke');
    // Old addresses redirect and keep their hash.
    await page.goto('/report#treasury');
    await expect(page).toHaveURL(/\/numbers#treasury$/);
    await page.goto('/stats');
    await expect(page).toHaveURL(/\/numbers$/);
    await page.goto('/app/stats');
    await expect(page).toHaveURL(/\/numbers$/);
  });

  test('download page: three options, checksum + version from /downloads/latest.json, Open Anyway walkthrough, nav + footer links', async ({ page }) => {
    await page.goto('/');
    // Download lives in the footer only (the top nav is Chat · Market · Run a node · Numbers · Docs).
    await page.locator('footer').getByRole('link', { name: 'Download for Mac' }).click();
    await expect(page).toHaveURL(/\/download$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Run a node');
    // The sample latest.json in apps/web/public feeds version + hashes.
    const latest = await (await page.request.get('/downloads/latest.json')).json();
    await expect(page.getByLabel('Current release')).toContainText(`Latest v${latest.version}`);
    await expect(page.getByLabel('Current release')).toContainText('Apple Silicon only');
    await expect(page.getByLabel('DMG SHA-256')).toContainText(latest.dmgSha256);
    await expect(page.getByLabel('Tarball SHA-256')).toContainText(latest.tarballSha256);
    await expect(page.getByRole('link', { name: /Download MeshNode-.*-arm64\.dmg/ })).toHaveAttribute('href', latest.dmgUrl);
    // Three options, each with its own steps.
    await expect(page.locator('#terminal pre.term')).toContainText('install-node.sh | sh -s -- --link <code>');
    await expect(page.locator('#homebrew pre.term')).toContainText('brew install meshnetworkai/tap/mesh-node');
    await expect(page.locator('#homebrew pre.term')).toContainText('mesh-node setup --link <code>');
    const steps = page.getByLabel('Open Anyway walkthrough');
    await expect(steps.locator('li')).toHaveCount(5);
    await expect(steps).toContainText('Privacy & Security');
    await expect(steps).toContainText('Open Anyway');
    await expect(page.locator('#app')).toContainText('Right-click → Open no longer bypasses');
    await expect(page.locator('#warning')).toContainText('unsigned beta');
    // Typing a link code fills it into both command blocks.
    await page.getByRole('textbox', { name: 'Link code' }).fill('k7qm-2xda');
    await expect(page.locator('#terminal pre.term')).toContainText('--link K7QM2XDA');
    await expect(page.locator('#homebrew pre.term')).toContainText('--link K7QM2XDA');
    // Node page links back here.
    await page.goto('/app/node');
    await expect(page.locator('main').getByRole('link', { name: 'Download for Mac' })).toHaveCount(2); // the Node page's hint + the footer
  });
});
