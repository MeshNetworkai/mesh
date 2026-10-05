import { expect, test } from '@playwright/test';
import { GATEWAY_URL } from '../playwright.config';
import { balanceUsd, devLogin, parseUsd, signIn } from './helpers';

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
    // The 3D backdrop (components/Hero3D.tsx) is decorative: hidden from AT, behind the copy, never catches clicks.
    // It mounts only where WebGL 2 exists, so its presence is not asserted; its behaviour is.
    const backdrop = page.getByTestId('hero-3d');
    if ((await backdrop.count()) > 0) {
      await expect(backdrop).toHaveAttribute('aria-hidden', 'true');
      const style = await backdrop.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { pointerEvents: cs.pointerEvents, zIndex: cs.zIndex, position: cs.position };
      });
      expect(style).toEqual({ pointerEvents: 'none', zIndex: '-1', position: 'absolute' });
      const box = (await backdrop.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(vw - 1); // bleeds to the viewport edges
    }
    // Live guest chat: quota pill from GET /v1/guest/quota, model picker, suggested prompts, composer.
    await expect(chat).toContainText('Live · Mesh network');
    await expect(chat.locator('.head .pill.num')).toContainText(/\d+ \/ \d+ free/);
    // The composer bar reads like the app's: model pill, free counter, Send.
    await expect(chat.locator('.composer .pill.counter')).toContainText(/\d+ of \d+ free today/);
    await expect(chat.getByLabel('Model')).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Explain how Mesh pays for AI' })).toBeVisible();
    await expect(chat.getByLabel('Message')).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Send' })).toBeDisabled();
    // Key figures come from config/tokenomics.json (+ the marketplace fee).
    const figures = page.getByLabel('Key figures');
    await expect(figures).toContainText('1.5%');
    await expect(figures).toContainText('1,000 MESH');
    await expect(figures).toContainText('2.5%');
    // "Same models. Less spend." between the figures and the engines: live catalogue, list vs Mesh per 1M tokens.
    const spend = page.locator('#spend');
    await expect(spend.getByRole('heading', { name: /Same models\. Less spend\./ })).toBeVisible();
    const figBox = (await figures.boundingBox())!;
    const spendBox = (await spend.boundingBox())!;
    const enginesBox = (await engines.boundingBox())!;
    expect(spendBox.y).toBeGreaterThan(figBox.y + figBox.height);
    expect(spendBox.y + spendBox.height).toBeLessThan(enginesBox.y);
    await expect(spend.locator('.spend-vendors')).toContainText(/GPT|Claude|Gemini|Llama|Qwen|DeepSeek/);
    await expect(spend.locator('.spend-col.mesh .n')).not.toHaveText('—');
    // Default pick is an open model that is cheaper on Mesh: the saving bar is shown and never invented.
    await expect(spend.locator('.spend-bar[data-state="saving"]')).toContainText(/You save \$[\d.]+ · \d+% less/);
    const listPrice = Number((await spend.locator('.spend-col').first().locator('.n').innerText()).replace('$', ''));
    const meshPrice = Number((await spend.locator('.spend-col.mesh .n').innerText()).replace('$', ''));
    expect(meshPrice).toBeLessThan(listPrice);
    // A frontier model at list (config upstreamDiscountBps = 0): the parity line, no saving bar.
    await spend.locator('#spend-model').click();
    const frontier = page.getByRole('option', { name: /GPT-5|Claude|Gemini/ }).first();
    if (await frontier.isVisible({ timeout: 3000 }).catch(() => false)) {
      await frontier.click();
      await expect(spend.locator('.spend-bar[data-state="parity"]')).toContainText('At list price today — served privately with zero data retention');
      await expect(spend.locator('.spend-bar[data-state="parity"]')).toContainText('Discounts on frontier models switch on with the pricing decision');
      await expect(spend.locator('.spend-bar[data-state="saving"]')).toHaveCount(0);
      await expect(spend.locator('.spend-served')).toContainText('Served by upstream, privacy upstream · zero data retention');
    } else {
      // The e2e gateway may serve a catalogue without frontier entries; the parity copy is covered by the mock screenshots.
      await page.keyboard.press('Escape');
    }
    // Numbered sections in order.
    for (const t of ['01 · How the money moves', '02 · Four ways in', "03 · Why it's different", '04 · Privacy, stated plainly', '05 · Live stats']) {
      await expect(page.getByText(t, { exact: true })).toBeVisible();
    }
    // Four ways in, with the live liquidity book (GET /market/book) in the "sell" column.
    await expect(page.locator('.pillars.four .pillar')).toHaveCount(4);
    await expect(page.getByLabel('Credit market, live')).toBeVisible();
    await expect(page.locator('.pillar').filter({ hasText: "Sell what you don't use" }).getByRole('link', { name: 'Open the market' })).toHaveAttribute('href', '/app/market');
    // Switch strip points at the API page's guide.
    await expect(page.getByRole('link', { name: /Snippets for curl/ })).toHaveAttribute('href', '/api#switch');
    // Seeded epoch: $100 of fees → "Fees collected" tile shows $100, one epoch run; the stats link goes to /stats.
    await expect(page.getByText('Fees collected', { exact: true }).locator('..')).toContainText('$100');
    await expect(page.getByText(/1 epochs run/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'All the stats' })).toHaveAttribute('href', '/stats');
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
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Connect a wallet');
    await expect(dialog).toContainText('Sign a message to prove you own the wallet. No transaction, no gas.');
    await expect(page.getByLabel('Invite code')).toHaveCount(0);
    // Launching on Robinhood Chain: no Solana/EVM toggle, no hard-coded wallet names. Headless Chromium has
    // no wallet extension, so the list says so and offers plain links only (nothing navigates by itself).
    await expect(dialog.getByRole('tablist', { name: 'Chain' })).toHaveCount(0);
    await expect(dialog.getByLabel('Wallets')).toContainText('No wallet detected');
    await expect(dialog.getByRole('link', { name: 'Phantom' })).toHaveAttribute('target', '_blank');
    await expect(dialog.getByRole('link', { name: 'MetaMask' })).toHaveAttribute('href', /metamask\.io/);
    await expect(dialog.locator('.wallet-btn')).toHaveCount(0);
    await expect(page).toHaveURL(/127\.0\.0\.1/);
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

test.describe('chat without a wallet', () => {
  // The free quota is per visitor per day (GET /v1/guest/quota), so these two tests share the budget: the
  // first spends one message, the second reads the counter and spends the rest.
  test("a guest conversation carries on after sign-in, on the wallet's credits", async ({ page }) => {
    await page.goto('/app/chat');
    await expect(page.getByRole('heading', { name: 'What do you want to ask?' })).toBeVisible();
    await expect(page.locator('.pill.counter')).toHaveText('5 of 5 free today');
    await page.locator('#prompt').fill('Remember this one');
    await page.keyboard.press('Enter');
    await expect(page.locator('.msg.ai .via').first()).toContainText('free');
    await expect(page.locator('.pill.counter')).toHaveText('4 of 5 free today');
    // Sign in (cookie + hint) and reload: the guest history moves to the wallet's key.
    await signIn(page);
    await page.reload();
    await page.locator('.chat-item-title', { hasText: 'Remember this one' }).click();
    await expect(page.locator('.msg.user')).toContainText('Remember this one');
    await expect(page.locator('.chat-rail-foot')).not.toContainText('Sign in to save history');
    await expect(page.locator('.pill.balance[aria-live]')).toBeVisible();
    await expect(page.locator('#privacy')).toHaveCount(1);
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('mesh.chat.history.')));
    expect(keys).toEqual(['mesh.chat.history.mockwallet_alice']);
    // No key in this browser yet: the first message creates one named "Chat" and the reply is billed to the wallet.
    await page.locator('#model').click();
    await page.getByRole('option', { name: /Mesh mock/ }).click();
    await page.locator('#prompt').fill('And now on credits');
    await page.keyboard.press('Enter');
    const reply = page.locator('.msg.ai').nth(1);
    await expect(reply).toContainText('Hello from the Mesh mock upstream');
    await expect(reply.locator('.via')).toContainText('mesh/mock');
    await expect(reply.locator('.via')).not.toContainText('free');
    await expect(page.locator('.chat-rail-keys')).toContainText('Using key: Chat');
  });

  test('/app/chat works as a guest: welcome, free counter, a streamed reply, history in the rail, connect card when the free messages run out', async ({ page }) => {
    await page.goto('/app/chat');
    await expect(page.getByRole('heading', { name: 'What do you want to ask?' })).toBeVisible();
    await expect(page.getByText('Answers come from Macs in the Mesh network or zero-data-retention providers.')).toBeVisible();
    await expect(page.locator('.chips.suggest .chip')).toHaveCount(4);
    // Guest mode: the counter from GET /v1/guest/quota, the model pill, no privacy pill (the guest route picks the tier), no footer.
    const counter = page.locator('.pill.counter');
    await expect(counter).toHaveText(/^\d of 5 free today$/);
    const left = Number((await counter.textContent())!.trim()[0]);
    expect(left).toBeGreaterThan(1);
    await expect(page.locator('#model')).toBeEnabled();
    await expect(page.locator('#privacy')).toHaveCount(0);
    await expect(page.locator('footer')).toHaveCount(0);
    await expect(page.locator('.chat-rail-foot')).toContainText('Sign in to save history and use frontier models.');

    const prompt = page.locator('#prompt');
    await prompt.fill('What did my fees buy?');
    await page.getByRole('button', { name: 'Send' }).click();
    const reply = page.locator('.msg.ai').first();
    await expect(reply).toContainText(/\S+/);
    await expect(reply.locator('.via')).toContainText('served by');
    await expect(reply.locator('.via')).toContainText('free');
    await expect(reply.getByRole('button', { name: 'Copy reply' })).toBeVisible();
    await expect(counter).toHaveText(`${left - 1} of 5 free today`);
    // The conversation is titled by its first message and survives a reload (localStorage, guest key).
    await expect(page.locator('.chat-item-title')).toHaveText('What did my fees buy?');
    await page.reload();
    await page.locator('.chat-item-title').click();
    await expect(page.locator('.msg.user')).toContainText('What did my fees buy?');
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('mesh.chat.history.')))).toEqual(['mesh.chat.history.guest']);

    // Use the rest of today's free messages: the inline connect card appears and the composer locks.
    for (let i = left - 1; i > 0; i--) {
      await prompt.fill(`Message ${i}`);
      await page.keyboard.press('Enter');
      await expect(counter).toHaveText(`${i - 1} of 5 free today`);
      await expect(page.locator('.msg.ai .via')).toHaveCount(left - i + 1);
    }
    const card = page.locator('.connect-card');
    await expect(card).toContainText('Connect a wallet to keep going');
    await expect(card).toContainText("You have used today's 5 free messages.");
    await expect(prompt).toBeDisabled();
    await card.getByRole('button', { name: 'Connect wallet' }).click();
    await expect(page.getByRole('dialog')).toContainText('Connect a wallet');
  });

  test('a pasted key alone lets a visitor chat on its credits: no wallet, no free counter, the rail says which key', async ({ page }) => {
    // Mint a key for alice through the API; the visitor only ever has the key string.
    const session = await devLogin();
    const res = await fetch(`${GATEWAY_URL}/keys`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'visitor-paste' }) });
    expect(res.ok).toBe(true);
    const { key } = (await res.json()) as { key: string };
    expect(key.startsWith('mesh_sk_')).toBe(true);

    await page.goto('/app/chat');
    const rail = page.locator('.chat-rail-keys');
    await expect(rail).toContainText('Have a key? Paste it to chat on your credits.');
    // Validation: the prefix is checked before anything is stored.
    await page.locator('#paste-key').fill('sk-not-a-mesh-key');
    await rail.getByRole('button', { name: 'Use' }).click();
    await expect(rail.getByRole('alert')).toContainText('Mesh keys start with mesh_sk_');
    expect(await page.evaluate(() => localStorage.getItem('mesh.chat.key.secrets'))).toBeNull();

    await page.locator('#paste-key').fill(key);
    await rail.getByRole('button', { name: 'Use' }).click();
    await expect(rail).toContainText('Using key: Pasted · mesh_sk_');
    await expect(rail).not.toContainText(key.slice(8, 24)); // only the mask is shown
    // The composer no longer counts free messages; it names the key instead. No wallet session exists.
    await expect(page.locator('.pill.counter')).toHaveCount(0);
    await expect(page.locator('.pill.keyed')).toContainText('mesh_sk_');
    expect(await page.evaluate(() => localStorage.getItem('mesh.session'))).toBeNull();
    await expect(page.locator('#privacy')).toHaveCount(1);

    const before = await balanceUsd(session.token);
    await page.locator('#model').click();
    await page.getByRole('option', { name: /Mesh mock/ }).click();
    await page.locator('#prompt').fill('Billed to the pasted key');
    await page.keyboard.press('Enter');
    const reply = page.locator('.msg.ai').first();
    await expect(reply).toContainText('Hello from the Mesh mock upstream');
    await expect(reply.locator('.via')).toContainText('mesh/mock');
    await expect(reply.locator('.via')).not.toContainText('free');
    await expect.poll(() => balanceUsd(session.token)).toBeCloseTo(before - 0.001, 5);
    // Forget drops it and the free counter returns.
    await rail.getByRole('button', { name: 'Forget' }).click();
    await expect(rail).toContainText('Have a key?');
    await expect(page.locator('.pill.counter')).toBeVisible();
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
    // The chat uses the newest key kept in this browser (the one just created); the rail says which.
    await expect(page.locator('.chat-rail-keys')).toContainText('Using key: e2e');
    await expect(page.getByRole('heading', { name: 'What do you want to ask?' })).toBeVisible();
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

  test('node page: 3-step flow (connect → link code → install), no "key" to fetch; signed in moves to step 2 and lists nodes', async ({ page }) => {
    await page.goto('/app/node');
    await expect(page.locator('span.display', { hasText: 'Run a node' })).toBeVisible();
    const flow = page.getByLabel('How to link a Mac');
    await expect(flow.getByRole('listitem')).toHaveCount(3);
    await expect(flow.getByRole('listitem').nth(0)).toHaveAttribute('aria-current', 'step');
    await expect(flow).toContainText('Connect your wallet');
    await expect(flow).toContainText('Click “Link a Mac”');
    await expect(flow).toContainText('No API key needed');
    await expect(flow).toContainText('Run the install command on the Mac');
    await expect(page.getByLabel('What the installer does')).toBeVisible();
    // The one-liner carries the gateway URL and the --link placeholder before any code exists.
    const term = page.locator('pre.term', { hasText: 'install-node.sh' });
    await expect(term).toContainText(`--link <code> --gateway ${GATEWAY_URL}`);
    await expect(page.getByRole('button', { name: 'Connect wallet to link a Mac' })).toBeVisible();

    await signIn(page);
    await page.goto('/app/node');
    await expect(flow.getByRole('listitem').nth(1)).toHaveAttribute('aria-current', 'step');
    await expect(page.getByRole('button', { name: 'Link a Mac' })).toBeVisible();
    await expect(page.getByText('Your nodes')).toBeVisible();
  });

  test('market: gate when signed out, then the wallet strip, balance card and the depth ladder; listing shows on the book and pre-fills Buy', async ({ page }) => {
    await page.goto('/app/market');
    const gate = page.getByRole('region', { name: 'Connect a wallet to see the book' });
    await expect(gate).toBeVisible();
    await expect(gate.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
    await expect(gate.locator('.gate-teaser')).toContainText(/Best discount right now|Nothing listed right now/);
    await expect(page.locator('.mkt')).toHaveCount(0); // nothing else renders before the wallet

    const session = await signIn(page);
    await page.goto('/app/market');
    await expect(page.locator('.mkt')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Connect a wallet to see the book' })).toHaveCount(0);
    // Wallet strip: short address + chain label from config.
    const strip = page.locator('.mkt-strip');
    await expect(strip).toContainText('Credit market');
    await expect(strip.locator('.pill.mono')).toContainText('mockwa');
    await expect(strip).toContainText(/Robinhood Chain|Solana|Base/);
    // Balance card matches GET /me; the key block offers the base URL and the Keys link.
    const balance = await balanceUsd(session.token);
    expect(balance).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => parseUsd(await page.getByTestId('credit-balance').textContent())).toBeCloseTo(balance, 2);
    await expect(page.getByLabel('API base URL')).toHaveValue(/\/v1$/);
    await expect(page.getByRole('link', { name: /Create a key|Manage keys/ })).toHaveAttribute('href', '/app/keys');

    // Sell: the preview is live and uses the gateway's fee (2.5% → $1 at 30% off: buyer pays $0.70, seller gets $0.68).
    const book = page.getByRole('region', { name: 'Order book' });
    await expect(book).toContainText('Nothing listed from this wallet.');
    await expect(book.getByRole('tab', { name: 'Sell credits' })).toHaveAttribute('aria-selected', 'true');
    await page.locator('#sell-amount').fill('1');
    await expect(page.locator('#sell-discount')).toHaveValue('30');
    await expect(page.getByTestId('sell-preview')).toContainText('Buyer pays $0.70 · you receive $0.68 after the 2.5% fee');
    await page.getByRole('button', { name: 'Raise the discount' }).click();
    await expect(page.locator('#sell-discount')).toHaveValue('30.5');
    await page.getByRole('button', { name: 'Lower the discount' }).click();
    await page.getByRole('button', { name: 'List on the book' }).click();
    await expect(book).toContainText('Your listings · 1 open · $1.00 left');
    // Depth ladder: one row per tier, with the dollar depth; the best tier carries the accent border.
    const rows = book.getByRole('option');
    await expect(rows.first()).toContainText('30% off');
    await expect(rows.first()).toContainText('$1.00');
    await expect(rows.first()).toHaveClass(/best/);
    await expect(rows.first().locator('.ladder-mine')).toHaveText('yours');
    await expect(book.getByTestId('book-total')).toContainText('$1');
    // Picking a row switches to Buy at that tier; my own listing is not for sale to me.
    await rows.first().click();
    await expect(book.getByRole('tab', { name: 'Buy credits' })).toHaveAttribute('aria-selected', 'true');
    await expect(book.locator('.mkt-tier')).toContainText('30% off');
    await expect(book.locator('.mkt-tier')).toContainText('$0.00 available');
    await expect(book.getByRole('button', { name: 'Buy', exact: true })).toBeDisabled();
    // Cancel returns the credit.
    await book.getByRole('button', { name: 'Cancel' }).click();
    await expect(book).toContainText('Nothing listed from this wallet.');
    await expect.poll(() => balanceUsd(session.token)).toBeCloseTo(balance, 5);
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

  test('top nav: Chat · Market · Run a node · Stats · Docs, market and node readable signed out', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    const labels = await nav.getByRole('link').allInnerTexts();
    expect(labels.map((l) => l.trim()).filter((l) => l !== 'Mesh' && !l.startsWith('Mesh'))).toEqual(['Chat', 'Market', 'Run a node', 'Stats', 'Docs']);
    await expect(nav.getByRole('link', { name: 'Chat' })).toHaveAttribute('href', '/app/chat');
    await expect(nav.getByRole('link', { name: 'App', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Download' })).toHaveCount(0);
    await expect(page.locator('footer').getByRole('link', { name: 'Download for Mac' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Your credits' })).toHaveCount(0);
    await nav.getByRole('link', { name: 'Market' }).click();
    await expect(page).toHaveURL(/\/app\/market$/);
    // Signed out, the market is only its gate card (the public teaser reads GET /market/book).
    await expect(page.getByRole('heading', { name: 'Connect a wallet to see the book' })).toBeVisible();
    await expect(page.getByText('Connect a wallet to see your credits')).toHaveCount(0);
    await nav.getByRole('link', { name: 'Run a node' }).click();
    await expect(page).toHaveURL(/\/app\/node$/);
  });

  test('top nav signed in: the balance pill opens the account menu (Overview · Keys · Node · Stake · Market · Sign out), keyboard and outside click', async ({ page }) => {
    await signIn(page);
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    const pill = nav.getByRole('button', { name: 'Your credits' });
    await expect(pill).toContainText('Credits');
    await expect(pill).toHaveAttribute('aria-expanded', 'false');
    await expect(nav.getByRole('button', { name: 'Connect wallet' })).toHaveCount(0);
    await pill.click();
    const menu = page.getByRole('menu', { name: 'Account' });
    await expect(menu).toBeVisible();
    await expect(pill).toHaveAttribute('aria-expanded', 'true');
    expect(await menu.getByRole('menuitem').allInnerTexts()).toEqual(['Overview', 'Keys', 'Node', 'Stake', 'Market', 'Sign out']);
    for (const [name, href] of [
      ['Overview', '/app'],
      ['Keys', '/app/keys'],
      ['Node', '/app/node'],
      ['Stake', '/app/stake'],
      ['Market', '/app/market'],
    ]) {
      await expect(menu.getByRole('menuitem', { name })).toHaveAttribute('href', href);
    }
    // Arrow keys move focus, Escape closes and returns focus to the pill.
    await expect(menu.getByRole('menuitem', { name: 'Overview' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Keys' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(pill).toBeFocused();
    // Outside click closes it.
    await pill.click();
    await expect(menu).toBeVisible();
    await page.getByRole('heading', { level: 1 }).click();
    await expect(menu).toHaveCount(0);
    // Following an item closes it on the route change.
    await pill.click();
    await menu.getByRole('menuitem', { name: 'Keys' }).click();
    await expect(page).toHaveURL(/\/app\/keys$/);
    await expect(menu).toHaveCount(0);
    // Sign out from the menu: back to the connect button.
    await pill.click();
    await menu.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(nav.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
    await expect.poll(async () => (await page.context().cookies()).map((c) => c.name)).not.toContain('mesh_session');
  });

  test('stats page: live tiles, epochs, weekly report, treasury/market/usage-share; /numbers and /report redirect with the hash', async ({ page }) => {
    await page.goto('/stats');
    await expect(page.locator('.statement .eyebrow')).toContainText('Stats ·');
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
    await expect(page).toHaveURL(/\/stats#treasury$/);
    await page.goto('/numbers');
    await expect(page).toHaveURL(/\/stats$/);
    await page.goto('/app/stats');
    await expect(page).toHaveURL(/\/stats$/);
  });

  test('download page: three options, checksum + version from /downloads/latest.json, Open Anyway walkthrough, nav + footer links', async ({ page }) => {
    await page.goto('/');
    // Download lives in the footer only (the top nav is App · Market · Run a node · Stats · Docs).
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
