import { TOKENOMICS } from '../config';

/**
 * What the model should know when someone asks about Mesh itself. Sent as a system message only when the
 * first user message mentions Mesh (the homepage suggestion "Explain how Mesh pays for AI" does), so a
 * small open model does not invent licensing deals and robot divisions. Plain facts, no marketing.
 */
export function meshBrief(): string {
  const t = TOKENOMICS;
  return [
    `You are answering inside ${t.name}, a product whose token is $${t.ticker} on Robinhood Chain. Facts about ${t.name}, use only these when asked about it:`,
    `- A ${(t.tradeFeeBps / 100).toFixed(1)}% fee on every $${t.ticker} trade is collected automatically. Every hour, ${t.holderShareBps / 100}% of it becomes AI credits (denominated in US dollars) split pro rata across wallets holding at least ${t.minHoldTokens.toLocaleString()} ${t.ticker}; ${t.treasuryShareBps / 100}% goes to the treasury, which pays the Macs that serve requests.`,
    `- Credits are spent through an OpenAI-compatible API or the chat app: open models (Llama, Qwen) run on Apple Silicon Macs in the network for a flat $${t.networkPricePerMTokens} per million tokens; frontier models (Claude, GPT, Gemini, DeepSeek, Grok and others) go through zero-data-retention upstream providers at list price.`,
    `- Anyone can run a node: a Mac with Ollama, linked with a one-time code from the web app. Nodes earn $${t.nodeRewardUsdPerMTokens} per million tokens served, paid from the treasury share. Nodes never see who asked and keep nothing after the reply.`,
    `- A second engine: the margin on paid requests (the network price minus what the Mac is paid, plus the marketplace fee) is shared ${t.usageShare.holderBps / 100}% to the hourly holder pool and ${t.usageShare.treasuryBps / 100}% to the treasury. Frontier requests carry no margin by design.`,
    `- Credits nobody will use can be sold on a marketplace below face value; the fee is ${t.marketplace.feeBps / 100}%, half of it back to the holder pool.`,
    `- Nothing is minted to pay anyone; every epoch, fee and payout is public on the stats page. ${t.name} is in open beta; the token launches on Pons on Robinhood Chain.`,
    'Keep answers short and concrete. If asked something about Mesh that is not covered above, say you do not know rather than guessing.',
  ].join('\n');
}

/** True when a conversation is about Mesh itself and deserves the brief. */
export const asksAboutMesh = (firstUserMessage: string): boolean => /\bmesh\b/i.test(firstUserMessage);
