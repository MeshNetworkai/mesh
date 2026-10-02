import { randomUUID } from 'node:crypto';
import { cpus, hostname, totalmem } from 'node:os';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:8787';
const NODE_ID = process.env.NODE_ID ?? `${hostname()}-${randomUUID().slice(0, 8)}`;
const NODE_WALLET = process.env.NODE_WALLET ?? 'mockwallet_node_1';
const NODE_URL = process.env.NODE_URL ?? 'http://localhost:11434';
const NODE_MODELS = (process.env.NODE_MODELS ?? 'llama3.1:8b').split(',').map((s) => s.trim()).filter(Boolean);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 30_000);

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const reg = await post('/nodes/register', {
    nodeId: NODE_ID,
    wallet: NODE_WALLET,
    url: NODE_URL,
    models: NODE_MODELS,
  });
  console.log('[node-agent] registered', reg);

  const beat = async () => {
    try {
      await post(`/nodes/${encodeURIComponent(NODE_ID)}/heartbeat`, {
        models: NODE_MODELS,
        ramGb: Math.round(totalmem() / 1024 ** 3),
        chip: process.env.NODE_CHIP ?? cpus()[0]?.model ?? 'unknown',
        busy: false,
      });
      console.log(`[node-agent] heartbeat ok ${new Date().toISOString()}`);
    } catch (err) {
      console.error('[node-agent] heartbeat failed', (err as Error).message);
    }
  };
  await beat();
  const timer = setInterval(beat, HEARTBEAT_MS);
  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('[node-agent] fatal', err);
  process.exit(1);
});
