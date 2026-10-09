/**
 * Public-page switches that are decided by hand, not by the gateway.
 *
 * STATS_LOCKED: /stats is blurred behind a "coming soon" card until the token is live and the network has
 * users (there is nothing worth reading on an empty ledger). Flip it with VITE_STATS_LOCKED=0 at build time
 * or by changing the default below; `/stats?preview=1` shows the real page meanwhile.
 */
export const STATS_LOCKED = (import.meta.env.VITE_STATS_LOCKED ?? '1') !== '0';
