import type { FetchLike } from '../rpc.js';

/**
 * Jupiter swap API (v6 shape: GET /quote, POST /swap). The default base is Jupiter's free
 * tier; set `baseUrl` to https://api.jup.ag/swap/v1 with an `apiKey` for the paid tier, or to
 * https://quote-api.jup.ag/v6 for the legacy host while it is still served.
 */
export interface JupiterOptions {
  baseUrl?: string;
  apiKey?: string;
  fetch?: FetchLike;
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct?: string;
  routePlan?: unknown[];
  [k: string]: unknown;
}

export const DEFAULT_JUPITER_BASE = 'https://lite-api.jup.ag/swap/v1';

export class JupiterClient {
  private readonly base: string;
  private readonly f: FetchLike;
  constructor(private readonly opts: JupiterOptions = {}) {
    this.base = (opts.baseUrl ?? DEFAULT_JUPITER_BASE).replace(/\/$/, '');
    this.f = opts.fetch ?? ((i, init) => fetch(i, init));
  }

  private headers(): Record<string, string> {
    return this.opts.apiKey ? { 'x-api-key': this.opts.apiKey } : {};
  }

  async quote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): Promise<JupiterQuote> {
    const url = new URL(`${this.base}/quote`);
    url.searchParams.set('inputMint', p.inputMint);
    url.searchParams.set('outputMint', p.outputMint);
    url.searchParams.set('amount', p.amount.toString());
    url.searchParams.set('slippageBps', String(p.slippageBps));
    url.searchParams.set('swapMode', 'ExactIn');
    const res = await this.f(url.toString(), { headers: this.headers() });
    if (!res.ok) throw new Error(`jupiter quote HTTP ${res.status}: ${await safeText(res)}`);
    const q = (await res.json()) as JupiterQuote & { error?: string };
    if (q.error) throw new Error(`jupiter quote: ${q.error}`);
    return q;
  }

  /** Returns a base64 VersionedTransaction to sign with `userPublicKey`. */
  async swapTransaction(quote: JupiterQuote, userPublicKey: string): Promise<string> {
    const res = await this.f(`${this.base}/swap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers() },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });
    if (!res.ok) throw new Error(`jupiter swap HTTP ${res.status}: ${await safeText(res)}`);
    const body = (await res.json()) as { swapTransaction?: string; error?: string };
    if (!body.swapTransaction) throw new Error(`jupiter swap: ${body.error ?? 'no swapTransaction in response'}`);
    return body.swapTransaction;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}
