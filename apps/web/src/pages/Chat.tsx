import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Notice, Spinner } from '../components/ui';
import { STORAGE } from '../config';
import * as api from '../lib/api';
import { ApiError, type ChatMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtCost, fmtLatency, fmtUsd } from '../lib/format';
import { useKeys, useLocalStorage, useMe, useStats } from '../lib/hooks';
import { loadSecrets } from '../lib/keystore';
import { errorMessage, useToast } from '../lib/toast';
import { PRIVACY_TIERS, PRIVACY_TIER_INFO, type Model, type PrivacyTier } from '../lib/types';

interface Turn {
  id: number;
  role: 'user' | 'assistant' | 'error';
  content: string;
  streaming?: boolean;
  via?: { servedBy: string; model: string; cost: number | null; latencyMs: number; savedUsd: number | null };
}

const PASTE = '__paste__';

export function Chat() {
  const toast = useToast();
  const { token } = useAuth();
  const keys = useKeys();
  const me = useMe(0);
  const stats = useStats(0);
  const [secrets, setSecrets] = useState<Record<string, string>>(() => loadSecrets());
  useEffect(() => setSecrets(loadSecrets()), [keys.data]);

  const usable = useMemo(() => (keys.data ?? []).filter((k) => !k.revoked && secrets[String(k.id)]), [keys.data, secrets]);

  const [keyChoice, setKeyChoice] = useLocalStorage<string>(STORAGE.chatKey, '');
  const [pasted, setPasted] = useState('');
  const apiKey = keyChoice === PASTE ? pasted.trim() : (secrets[keyChoice] ?? '');

  // default to the newest usable key once keys load
  useEffect(() => {
    if (!keyChoice && usable.length) setKeyChoice(String(usable[0].id));
    if (keyChoice && keyChoice !== PASTE && !secrets[keyChoice] && usable.length) setKeyChoice(String(usable[0].id));
  }, [usable, keyChoice, secrets, setKeyChoice]);

  // Privacy tier for this chat (docs/PRIVACY.md). Sent as X-Mesh-Privacy; trusted by default.
  const [privacyRaw, setPrivacy] = useLocalStorage<string>(STORAGE.chatPrivacy, 'trusted');
  const privacy: PrivacyTier = (PRIVACY_TIERS as string[]).includes(privacyRaw) ? (privacyRaw as PrivacyTier) : 'trusted';

  const [models, setModels] = useState<Model[] | null>(null);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [model, setModel] = useLocalStorage<string>(STORAGE.chatModel, '');
  useEffect(() => {
    if (!apiKey || !apiKey.startsWith('mesh_sk_')) {
      setModels(null);
      return;
    }
    let alive = true;
    setModelsErr(null);
    api
      .listModels(apiKey)
      .then((ms) => {
        if (!alive) return;
        setModels(ms);
        if (ms.length && !ms.some((m) => m.id === model)) setModel(ms[0].id);
      })
      .catch((err) => alive && setModelsErr(errorMessage(err)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || busy || !apiKey || !model) return;
    setInput('');
    const userTurn: Turn = { id: idRef.current++, role: 'user', content: text };
    const aiId = idRef.current++;
    const history: ChatMessage[] = [
      ...turns.filter((t) => t.role !== 'error').map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content })),
      { role: 'user', content: text },
    ];
    setTurns((ts) => [...ts, userTurn, { id: aiId, role: 'assistant', content: '', streaming: true }]);
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await api.streamChat(
        { apiKey, model, messages: history, signal: ctrl.signal, upstreamName: stats.data?.upstream, privacy },
        (delta) => setTurns((ts) => ts.map((t) => (t.id === aiId ? { ...t, content: t.content + delta } : t))),
      );
      setTurns((ts) =>
        ts.map((t) =>
          t.id === aiId
            ? {
                ...t,
                streaming: false,
                via: {
                  servedBy: res.servedBy,
                  model: res.model,
                  cost: typeof res.usage?.cost === 'number' ? res.usage.cost : null,
                  latencyMs: res.latencyMs,
                  // Network credits: only present when a Mesh node served the reply and savings are shown.
                  savedUsd: res.mesh && typeof res.mesh.savedUsd === 'number' ? res.mesh.savedUsd : null,
                },
              }
            : t,
        ),
      );
      void me.reload();
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      setTurns((ts) =>
        ts
          .map((t) => (t.id === aiId && t.content ? { ...t, streaming: false } : t))
          .filter((t) => !(t.id === aiId && !t.content))
          .concat(aborted ? [] : [{ id: idRef.current++, role: 'error' as const, content: friendlyError(err) }]),
      );
      if (!aborted && !(err instanceof ApiError && err.status === 402)) toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const noKeys = !keys.loading && usable.length === 0 && keyChoice !== PASTE;

  return (
    <>
      <div className="row between">
        <span className="display d-s">Chat</span>
        <span className="pill balance" aria-live="polite">
          Credits <b>{me.data ? fmtUsd(me.data.balance.usd, 3) : '…'}</b>
        </span>
      </div>

      <div className="chat-controls">
        <div className="field">
          <label htmlFor="key">API key</label>
          <select id="key" className="input sm mono" value={keyChoice} onChange={(e) => setKeyChoice(e.target.value)}>
            {usable.length === 0 ? <option value="">No key available</option> : null}
            {usable.map((k) => (
              <option key={k.id} value={String(k.id)}>
                {k.name ?? 'untitled'} · {k.masked.slice(0, 14)}…
              </option>
            ))}
            <option value={PASTE}>Paste a key…</option>
          </select>
        </div>
        {keyChoice === PASTE ? (
          <div className="field">
            <label htmlFor="paste">Key</label>
            <input id="paste" className="input sm mono" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="mesh_sk_…" autoComplete="off" />
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="model">Model</label>
          <select id="model" className="input sm mono" value={model} onChange={(e) => setModel(e.target.value)} disabled={!models}>
            {!models ? <option>{apiKey ? (modelsErr ? 'Could not load models' : 'Loading…') : 'Select a key first'}</option> : null}
            {(models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name ? `${m.name} · ${m.id}` : m.id}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="privacy">Privacy</label>
          <select id="privacy" className="input sm" value={privacy} onChange={(e) => setPrivacy(e.target.value)} aria-describedby="privacy-help">
            {PRIVACY_TIERS.map((t) => (
              <option key={t} value={t}>
                {PRIVACY_TIER_INFO[t].label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p id="privacy-help" className="small muted" style={{ margin: 0 }}>
        {PRIVACY_TIER_INFO[privacy].blurb} Whoever serves a reply sees your prompt in plaintext while it runs; the gateway never stores it.{' '}
        <Link to="/docs#privacy">How the tiers work</Link>.
      </p>
      {modelsErr ? <Notice kind="bad">{modelsErr}</Notice> : null}

      {noKeys ? (
        <Empty
          title="No key in this browser"
          action={
            <div className="row">
              <Link className="btn accent sm" to="/app/keys">
                Create a key
              </Link>
              <button className="btn secondary sm" onClick={() => setKeyChoice(PASTE)}>
                Paste one
              </button>
            </div>
          }
        >
          Keys are shown once when created, so chat can only use keys created here or pasted in.
        </Empty>
      ) : null}

      <div className="chat">
        <div className="chat-scroll" ref={scrollRef} aria-live="polite" aria-busy={busy}>
          {turns.length === 0 ? (
            <p className="small muted" style={{ padding: '24px 0' }}>
              Ask anything. Each reply shows which tier served it (trusted node, network node or ZDR upstream), the model, what it cost, what
              you saved versus list price and how long it took.
            </p>
          ) : null}
          {turns.map((t) => (
            <div key={t.id} className={`msg ${t.role === 'user' ? 'user' : t.role === 'error' ? 'err' : 'ai'}`}>
              {t.content}
              {t.streaming ? <span className="caret" aria-hidden="true" /> : null}
              {t.via ? (
                <span className="via">
                  served by {t.via.servedBy} · {t.via.model} · {t.via.cost === null ? 'cost n/a' : fmtCost(t.via.cost)}
                  {t.via.savedUsd !== null && t.via.savedUsd > 0 ? <> · saved {fmtCost(t.via.savedUsd)} vs list</> : null} · {fmtLatency(t.via.latencyMs)}
                </span>
              ) : null}
            </div>
          ))}
        </div>
        <form className="composer" onSubmit={send}>
          <label className="sr-only" htmlFor="prompt">
            Message
          </label>
          <textarea
            id="prompt"
            className="input"
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={apiKey ? 'Message… (Enter to send, Shift+Enter for newline)' : 'Select or paste an API key to start'}
            disabled={!apiKey || !model}
          />
          {busy ? (
            <button type="button" className="btn secondary" onClick={() => abortRef.current?.abort()}>
              <Spinner /> Stop
            </button>
          ) : (
            <button type="submit" className="btn primary" disabled={!input.trim() || !apiKey || !model || !token}>
              Send
            </button>
          )}
        </form>
      </div>
    </>
  );
}

function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 402) return `Out of credits. ${err.message}`;
    if (err.status === 401) return 'That API key was rejected. Create a new one under Keys.';
    if (err.status === 429) return 'Rate limited. Wait a moment and try again.';
    return err.message;
  }
  return errorMessage(err);
}
