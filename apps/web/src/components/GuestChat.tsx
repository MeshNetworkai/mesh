import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { TOKENOMICS } from '../config';
import { ApiError, getCatalogue, getGuestQuota, onGuestRemaining, streamGuestChat, type ChatMessage, type ChatResult } from '../lib/api';
import { fmtLatency } from '../lib/format';
import type { CatalogueModel } from '../lib/types';
import { ModelPicker } from './ModelPicker';
import { Notice, Spinner } from './ui';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  result?: ChatResult | null;
}

const PROMPTS = ['Explain how Mesh pays for AI', 'Write a tweet about privacy', 'What runs on my Mac?'];
const DEFAULT_GUEST_MODEL = 'llama-3.1-8b';

/**
 * Free homepage chat (POST /v1/guest/chat, a few messages per day, no sign-in). Same bubbles, caret and
 * "served by" line as /app/chat (pages/Chat.tsx) so the hero and the app read as one product.
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
  const logRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || streaming || exhausted) return;
      setError(null);
      setInput('');
      const history: ChatMessage[] = [...turns.map((t) => ({ role: t.role, content: t.content })), { role: 'user', content }];
      setTurns((prev) => [...prev, { role: 'user', content }, { role: 'assistant', content: '', result: null }]);
      setStreaming(true);
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const result = await streamGuestChat({ messages: history, model, signal: ac.signal }, (delta) => {
          setTurns((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + delta };
            return next;
          });
        });
        setTurns((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last?.role === 'assistant') next[next.length - 1] = { ...last, result };
          return next;
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        // drop the empty assistant turn
        setTurns((prev) => (prev[prev.length - 1]?.role === 'assistant' && !prev[prev.length - 1].content ? prev.slice(0, -1) : prev));
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

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };
  const stop = () => abortRef.current?.abort();
  const locked = exhausted || !enabled;

  return (
    <div className="readout guestchat" id={id} aria-label="Try the network">
      <div className="head">
        <span className="eyebrow">Live · {TOKENOMICS.name} network</span>
        <span className="pill sm num" aria-live="polite">
          <span className="dot dot-live" aria-hidden="true" />
          {remaining === null ? '— free' : `${remaining}${limit ? ` / ${limit}` : ''} free`}
        </span>
      </div>

      <div className="chat-scroll" ref={logRef} role="log" aria-live="polite" aria-relevant="additions text" aria-busy={streaming}>
        {turns.length === 0 ? (
          <div className="guestchat-empty">
            <p className="display d-s">
              Ask the network anything. <span className="muted">No key, no wallet.</span>
            </p>
            <div className="chips" aria-label="Suggested prompts">
              {PROMPTS.map((p) => (
                <button key={p} type="button" className="chip" onClick={() => void send(p)} disabled={streaming || locked}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((t, i) => {
            const live = i === turns.length - 1 && t.role === 'assistant' && streaming;
            return (
              <div className={`msg ${t.role === 'user' ? 'user' : 'ai'}`} key={i}>
                {t.content}
                {live ? <span className="caret" aria-hidden="true" /> : null}
                {t.role === 'assistant' && t.result ? (
                  <span className="via">
                    served by {t.result.servedBy} · {t.result.model} · {fmtLatency(t.result.latencyMs)}
                  </span>
                ) : null}
              </div>
            );
          })
        )}
        {exhausted ? (
          <Notice kind="ok">
            You have used your free messages. <Link to="/app/chat">Connect a wallet</Link> to keep going.
          </Notice>
        ) : null}
        {error ? <Notice kind="bad">{error}</Notice> : null}
      </div>

      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor={`${id}-model`}>Model</label>
        <ModelPicker id={`${id}-model`} models={models} value={model} onChange={setModel} disabled={locked} />
      </div>
      <form className="composer" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor={`${id}-prompt`}>
          Message
        </label>
        <textarea
          id={`${id}-prompt`}
          className="input"
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={exhausted ? 'Free messages used for today' : 'Ask the network… (Enter to send, Shift+Enter for newline)'}
          disabled={locked}
        />
        {streaming ? (
          <button type="button" className="btn secondary" onClick={stop}>
            <Spinner /> Stop
          </button>
        ) : (
          <button type="submit" className="btn primary" disabled={!input.trim() || locked}>
            Send
          </button>
        )}
      </form>
      <p className="small muted">
        {limit ?? 5} free messages a day, no sign-up. Network models run on a Mac in the {TOKENOMICS.name} network; the rest go upstream with
        zero-data-retention providers. Nothing is stored after the reply. Frontier models need a wallet.
      </p>
    </div>
  );
}
