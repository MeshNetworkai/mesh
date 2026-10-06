import { afterEach, describe, expect, it } from 'vitest';
import { recordError } from '../src/db.js';
import { testServer } from './helpers.js';

type App = Awaited<ReturnType<typeof testServer>>['app'];
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe('GET /status (public status page + node explorer)', () => {
  it('reports components, hourly error counts without messages, and an anonymised fleet', async () => {
    const { app } = await testServer();
    apps.push(app);
    const reg = await app.inject({ method: 'POST', url: '/nodes/register', payload: { nodeId: 'mac-status-1', wallet: 'bob', models: ['llama3.1:8b'], chip: 'M3 Max', ramGb: 64 } });
    expect(reg.statusCode).toBe(200);
    recordError(app.ctx.db, { route: '/v1/chat/completions', status: 502, code: 'upstream_error', message: 'secret detail that must not leak' });

    const res = await app.inject({ method: 'GET', url: '/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(['operational', 'degraded']).toContain(body.overall);
    const keys = body.components.map((c: { key: string }) => c.key);
    expect(keys).toEqual(['gateway', 'database', 'upstream', 'network', 'epochs', 'token']);
    expect(body.components.find((c: { key: string }) => c.key === 'network')).toMatchObject({ state: 'ok', detail: '1 of 1 registered Mac online' });
    // the mock treasury before launch is a deliberate "off", not a fault
    expect(body.components.find((c: { key: string }) => c.key === 'token').state).toBe('off');

    expect(body.errors24h).toHaveLength(24);
    expect(body.errorTotal24h).toBe(1);
    expect(body.topErrorCodes).toEqual([{ code: 'upstream_error', n: 1 }]);
    expect(JSON.stringify(body)).not.toContain('secret detail');

    expect(body.fleet).toHaveLength(1);
    expect(body.fleet[0]).toMatchObject({ id: 'mac-stat', chip: 'M3 Max', ramGb: 64, models: ['llama3.1:8b'], state: 'online', jobs24h: 0 });
    expect(JSON.stringify(body.fleet)).not.toContain('bob'); // no wallets
    expect(body.fleet[0]).not.toHaveProperty('wallet');
    expect(body.fleet[0]).not.toHaveProperty('token');
  });

  it('answers 503 with the same body when the database is gone', async () => {
    const { app } = await testServer();
    apps.push(app);
    app.ctx.db.close();
    const res = await app.inject({ method: 'GET', url: '/status' });
    expect(res.statusCode).toBe(503);
    expect(res.json().overall).toBe('down');
  });
});
