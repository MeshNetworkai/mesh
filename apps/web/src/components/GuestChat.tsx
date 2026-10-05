import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { TOKENOMICS } from '../config';
import { ApiError, getCatalogue, getGuestQuota, onGuestRemaining, streamGuestChat, type ChatMessage } from '../lib/api';
import type { CatalogueModel } from '../lib/types';
import { Composer, MessageList, Suggestions, turnId, viaFromResult, type Turn } from './ChatThread';
import { ModelPicker } from './ModelPicker';
import { Notice } from './ui';

const PROMPTS = ['Explain how Mesh pays for AI', 'Write a tweet about privacy', 'What runs on my Mac?'];
const DEFAULT_GUEST_MODEL = 'llama-3.1-8b';

/**
 * Free homepage chat (POST /v1/guest/chat, a few messages per day, no sign-in). The compact card
 * version of /app/chat: same message list, composer, pills and "served by" line (components/ChatThread.tsx),
 * so the hero and the app read as one product. The app page picks the conversation up with more room.
 */
export function GuestChat({ id = 'guest-chat' }: { id?: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Guests pick from the network models and the cheaper tiers (GET /v1/models?guest=1; config guest.allowedTiers).
  const [models, setModels] = useState<CatalogueModel[] | null>(null);
  const [model, setModel] = useState(DEFAULT_GUEST_MODEL);

  useEffect(() => {
    let alive = true;
    getCatalogue({ guest: true })
      .then((c) => {
        if (!alive) return;
        setModels(c.data);
        if (c.data.length && !c.data.some((m) => m.id === model)) setModel((c.data.find((m) => m.served !== 'upstream') ?? c.data[0]).id);
      })
      .catch(() => {
        /* picker stays on the default model */
      });
    getGuestQuota()
      .then((q) => {
        if (!alive) return;
        setRemaining(q.remaining);
        setLimit(q.limit);
        setEnabled(q.enabled);
        if (q.remaining <= 0) setExhausted(true);
      })
      .catch(() => {
        /* quota unknown: the first send will tell us */
      });
    const off = onGuestRemaining((n) => {
      if (!alive) return;
      setRemaining(n);
      if (n <= 0) setExhausted(true);
    });
    return () => {
      alive = false;
      off();
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || streaming || exhausted) return;
      setError(null);
      setInput('');
      const history: ChatMessage[] = [...turns.filter((t) => t.role !== 'error').map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content })), { role: 'user', content }];
      const aiId = turnId();
      setTurns((prev) => [...prev, { id: turnId(), role: 'user', content }, { id: aiId, role: 'assistant', content: '', streaming: true }]);
      setStreaming(true);
      const ac = new AbortController();
      abortRef.current = ac;
      const patch = (fn: (t: Turn) => Turn) => setTurns((prev) => prev.map((t) => (t.id === aiId ? fn(t) : t)));
      try {
        const result = await streamGuestChat({ messages: history, model, signal: ac.signal }, (delta) => patch((t) => ({ ...t, content: t.content + delta })));
        patch((t) => ({ ...t, streaming: false, via: viaFromResult(result, true) }));
      } catch (err) {
        // keep what streamed, drop an empty reply
        setTurns((prev) => prev.map((t) => (t.id === aiId ? { ...t, streaming: false } : t)).filter((t) => !(t.id === aiId && !t.content)));
        if ((err as Error).name === 'AbortError') return;
        if (err instanceof ApiError && (err.code === 'guest_quota_exhausted' || err.status === 429)) {
          setExhausted(true);
          setRemaining(0);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [turns, streaming, exhausted, model],
  );

  const stop = () => abortRef.current?.abort();
  const locked = exhausted || !enabled;

  const empty = (
    <div className="guestchat-empty">
      <p className="display d-s">
        Ask the network anything. <span className="muted">No key, no wallet.</span>
      </p>
      <Suggestions prompts={PROMPTS} onPick={(p) => void send(p)} disabled={streaming || locked} />
    </div>
  );

  const after = (
    <>
      {exhausted ? (
        <Notice kind="ok">
          You have used your free messages. <Link to="/app/chat">Connect a wallet</Link> to keep going.
        </Notice>
      ) : null}
      {error ? <Notice kind="bad">{error}</Notice> : null}
    </>
  );

  return (
    <div className="readout guestchat" id={id} aria-label="Try the network">
      <div className="head">
        <span className="eyebrow">Live · {TOKENOMICS.name} network</span>
        <span className="pill sm num" aria-live="polite">
          <span className="dot dot-live" aria-hidden="true" />
          {remaining === null ? '— free' : `${remaining}${limit ? ` / ${limit}` : ''} free`}
        </span>
      </div>

      <MessageList turns={turns} busy={streaming} empty={empty} after={after} className="chat-scroll" />

      <div className="guestchat-composer">
        <Composer
          id={`${id}-prompt`}
          value={input}
          onChange={setInput}
          onSend={(t) => void send(t)}
          onStop={stop}
          busy={streaming}
          disabled={locked}
          placeholder={exhausted ? 'Free messages used for today' : 'Ask the network…'}
          tools={<ModelPicker id={`${id}-model`} variant="pill" label="Model" models={models} value={model} onChange={setModel} disabled={locked} />}
          status={
            <span className="pill sm num counter" aria-live="polite" title={`${limit ?? TOKENOMICS.guest.messagesPerDay} free messages a day, no sign-in`}>
              {remaining === null ? `${limit ?? TOKENOMICS.guest.messagesPerDay} free a day` : `${Math.max(0, remaining)} of ${limit ?? TOKENOMICS.guest.messagesPerDay} free today`}
            </span>
          }
        />
        <p className="small muted composer-help">
          Free messages run on Macs in the {TOKENOMICS.name} network or zero-data-retention providers; nothing is stored after the reply.{' '}
          <Link className="openapp" to="/app/chat">
            Open the app
          </Link>
        </p>
      </div>
    </div>
  );
}
