import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli.js';
import { GatewayClient, GatewayError } from '../src/gateway.js';
import { AGENT_VERSION } from '../src/paths.js';
import { explainRegisterError, normalizeLinkCode, registerInput } from '../src/setup.js';
import { fakeGateway } from './fakes.js';

const sys = { chip: 'Apple M3 Max', ramGb: 64 };
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (stops.length) await stops.pop()!();
});

describe('link-code registration', () => {
  it('builds the register body from --link (normalised) or, legacy, from --wallet', () => {
    expect(registerInput({ link: 'abcd-efgh' }, sys, ['llama3.1:8b'])).toEqual({
      linkCode: 'ABCDEFGH',
      chip: 'Apple M3 Max',
      ramGb: 64,
      models: ['llama3.1:8b'],
      agentVersion: AGENT_VERSION,
    });
    // a link code wins over a wallet: the code already carries the wallet
    expect(registerInput({ link: 'ABCDEFGH', wallet: 'w' }, sys, [])).not.toHaveProperty('wallet');
    expect(registerInput({ wallet: 'wallet_abc' }, sys, [])).toMatchObject({ wallet: 'wallet_abc' });
    expect(() => registerInput({}, sys, [])).toThrow(/--link <code>/);
    expect(normalizeLinkCode(' ab cd-ef gh ')).toBe('ABCDEFGH');
  });

  it('registers with a link code on a signed gateway and gets the wallet back; no wallet is needed locally', async () => {
    const gw = fakeGateway({ linkCode: 'MESH2K7Q', wallet: 'bob_wallet' });
    const url = await gw.start();
    stops.push(gw.stop);
    const reg = await new GatewayClient(url).register(registerInput({ link: 'mesh-2k7q' }, sys, ['llama3.1:8b']));
    expect(reg).toMatchObject({ nodeId: 'node_test', nodeToken: 'tok_test', wallet: 'bob_wallet', walletVerified: true, linked: true });
    expect(gw.state.registrations[0]).toMatchObject({ linkCode: 'MESH2K7Q' });
    expect(gw.state.registrations[0]).not.toHaveProperty('wallet');
  });

  it('a reused, unknown or missing code is refused with an actionable message', async () => {
    const gw = fakeGateway({ linkCode: 'MESH2K7Q', wallet: 'bob_wallet' });
    const url = await gw.start();
    stops.push(gw.stop);
    const client = new GatewayClient(url);
    await client.register(registerInput({ link: 'MESH2K7Q' }, sys, []));
    const reused = await client.register(registerInput({ link: 'MESH2K7Q' }, sys, [])).catch((e: GatewayError) => e);
    expect(reused).toMatchObject({ status: 400, code: 'link_code_used' });
    expect(explainRegisterError(reused, 'the web app')).toMatch(/already used/);

    const unknown = await client.register(registerInput({ link: 'NOPE1234' }, sys, [])).catch((e: GatewayError) => e);
    expect(unknown).toMatchObject({ status: 400, code: 'link_code_invalid' });
    expect(explainRegisterError(unknown, 'the web app')).toMatch(/unknown link code/);

    // legacy --wallet against a signed gateway
    const unsigned = await client.register(registerInput({ wallet: 'bob_wallet' }, sys, [])).catch((e: GatewayError) => e);
    expect(unsigned).toMatchObject({ status: 401, code: 'signature_required' });
    expect(explainRegisterError(unsigned, 'the web app')).toMatch(/Link a Mac.*--link <code>/);
    expect(explainRegisterError(new Error('boom'), 'x')).toBe('boom');
  });

  it('legacy --wallet still registers when the gateway allows unsigned registration', async () => {
    const gw = fakeGateway({ wallet: 'ignored' });
    const url = await gw.start();
    stops.push(gw.stop);
    const reg = await new GatewayClient(url).register(registerInput({ wallet: 'wallet_abc' }, sys, ['llama3.1:8b']));
    expect(reg.wallet).toBe('wallet_abc');
    expect(reg.linked).toBe(false);
  });

  it('CLI parses --link in both spellings alongside the other setup flags', () => {
    expect(parseArgs(['setup', '--link', 'ABCD-EFGH', '--gateway', 'https://gw'])).toEqual({ cmd: ['setup'], flags: { link: 'ABCD-EFGH', gateway: 'https://gw' } });
    expect(parseArgs(['setup', '--link=ABCDEFGH', '--skip-pull'])).toEqual({ cmd: ['setup'], flags: { link: 'ABCDEFGH', 'skip-pull': true } });
    expect(parseArgs(['setup', '--wallet', 'w']).flags).toEqual({ wallet: 'w' });
  });
});
