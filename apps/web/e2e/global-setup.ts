import { ADMIN_TOKEN, GATEWAY_URL } from '../playwright.config';

/**
 * Seed the throwaway gateway (the `e2e` script deletes e2e/.tmp before the servers start, so the
 * DB is empty here): $100 of fake fees → one epoch → mockwallet_alice holds credits.
 */
export default async function globalSetup() {
  const admin = { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' };
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${GATEWAY_URL}${path}`, { method: 'POST', headers: admin, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
    return res.json() as Promise<Record<string, unknown>>;
  };
  await post('/admin/fake-fees', { amountUsd: 100 });
  const epoch = await post('/admin/run-epoch', {});
  // The gateway may run the same epoch itself right after boot (cron catch-up); the admin call then loses the
  // per-DB lock and answers `skipped` with the stored figures. Seeded either way as long as holders were paid.
  const seeded = epoch.status === 'complete' || (epoch.status === 'skipped' && Number(epoch.eligibleHolders) > 0 && Number(epoch.holderPoolUsdMicros) > 0);
  if (!seeded) throw new Error(`seed epoch not complete: ${JSON.stringify(epoch)}`);
}
