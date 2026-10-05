import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Composer, MessageList, Suggestions, turnId, viaFromResult, type Turn } from '../components/ChatThread';
import { ModelPicker } from '../components/ModelPicker';
import { Notice } from '../components/ui';
import { STORAGE, TOKENOMICS } from '../config';
import * as api from '../lib/api';
import { ApiError, type ChatMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { GUEST_OWNER, loadHistory, migrateGuestHistory, newConversationId, saveHistory, titleFor, type Conversation } from '../lib/chatHistory';
import { fmtUsd, shortAddr } from '../lib/format';
import { useKeys, useLocalStorage, useMe, useStats } from '../lib/hooks';
import { PASTED_ID, forgetPastedKey, isMeshKey, loadActiveKeyId, loadSecrets, maskKey, rememberPastedKey, rememberSecret, saveActiveKeyId } from '../lib/keystore';
import { errorMessage, useToast } from '../lib/toast';
import { PRIVACY_TIERS, PRIVACY_TIER_INFO, type CatalogueModel, type PrivacyTier } from '../lib/types';

/**
 * /app/chat: the chat app. Works without a wallet (the gateway's free guest messages, POST
 * /v1/guest/chat: network and fast tiers only, a few a day) and with one (the wallet's credits
 * through an API key kept in this browser; one is created on first use). History lives in
 * localStorage per wallet (lib/chatHistory.ts) and the guest list is folded in on sign-in, so a
 * conversation started before connecting carries on after.
 */

/** Default model: the network's own Llama 3.1 8B (docs/PRICING.md); the first network model if the catalogue renamed it. */
const DEFAULT_MODEL = 'llama-3.1-8b';
const PROMPTS = ['Explain how Mesh pays for AI', 'Write a tweet about privacy', 'Draft a polite follow-up email', 'Explain public-key cryptography simply'];
const WELCOME = 'Answers come from Macs in the Mesh network or zero-data-retention providers. Nothing is stored after the reply.';

interface KeyChoice {
  /** Key id as a string, or PASTED_ID. */
  id: string;
  name: string;
  key: string;
}

export function pickDefaultModel(ms: CatalogueModel[]): string {
  return (ms.find((m) => m.id === DEFAULT_MODEL) ?? ms.find((m) => m.served !== 'upstream') ?? ms[0])?.id ?? '';
}

export function Chat() {
  const toast = useToast();
  const { session, token, openModal } = useAuth();
  const owner = session?.wallet ?? GUEST_OWNER;
  const keys = useKeys();
  const me = useMe(0);
  const stats = useStats(0);

  // Full-height shell: the page (not the window) scrolls, the composer stays put.
  useEffect(() => {
    document.body.dataset.chatPage = '1';
    return () => {
      delete document.body.dataset.chatPage;
    };
  }, []);

  /* ---------- history (this browser only) ---------- */
  // Mounting already signed in (reload after connecting): fold any guest history in right away.
  const [convs, setConvs] = useState<Conversation[]>(() => (owner === GUEST_OWNER ? loadHistory(owner) : migrateGuestHistory(owner)));
  const [activeId, setActiveId] = useState<string | null>(null);
  const ownerRef = useRef(owner);
  const convsRef = useRef(convs);
  convsRef.current = convs;
  const dirty = useRef(false);

  useEffect(() => {
    if (ownerRef.current === owner) return;
    const prev = ownerRef.current;
    ownerRef.current = owner;
    if (prev === GUEST_OWNER) {
      // Signed in mid-conversation: the guest list becomes the wallet's and the open chat stays open.
      setConvs(migrateGuestHistory(owner));
    } else {
      setConvs(loadHistory(owner));
      setActiveId(null);
    }
  }, [owner]);

  const commit = useCallback((fn: (prev: Conversation[]) => Conversation[]) => {
    dirty.current = true;
    setConvs(fn);
  }, []);
  const flush = useCallback(() => {
    if (!dirty.current) return;
    dirty.current = false;
    saveHistory(ownerRef.current, convsRef.current);
  }, []);
  // Streaming deltas arrive every few ms: write a little after they pause, and at once when a reply ends,
  // when the tab is hidden or unloaded, and when the page is left.
  useEffect(() => {
    if (!dirty.current) return;
    const t = window.setTimeout(flush, 250);
    return () => window.clearTimeout(t);
  }, [convs, flush]);
  useEffect(() => {
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
      flush();
    };
  }, [flush]);

  const active = convs.find((c) => c.id === activeId) ?? null;
  const turns = active?.turns ?? [];

  /* ---------- models + settings ---------- */
  const [models, setModels] = useState<CatalogueModel[] | null>(null);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [model, setModel] = useLocalStorage<string>(STORAGE.chatModel, '');
  useEffect(() => {
    let alive = true;
    api
      .getCatalogue()
      .then((c) => {
        if (!alive) return;
        setModels(c.data);
        if (c.data.length && !c.data.some((m) => m.id === model)) setModel(pickDefaultModel(c.data));
      })
      .catch((err) => alive && setModelsErr(errorMessage(err)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const current = models?.find((m) => m.id === model) ?? null;

  // Privacy tier (docs/PRIVACY.md), sent as X-Mesh-Privacy on wallet chats. Guest messages take the gateway's guest route.
  const [privacyRaw, setPrivacy] = useLocalStorage<string>(STORAGE.chatPrivacy, 'trusted');
  const privacy: PrivacyTier = (PRIVACY_TIERS as string[]).includes(privacyRaw) ? (privacyRaw as PrivacyTier) : 'trusted';

  /* ---------- guest quota ---------- */
  const [remaining, setRemaining] = useState<number | null>(null);
  const [limit, setLimit] = useState<number>(TOKENOMICS.guest.messagesPerDay);
  const [guestEnabled, setGuestEnabled] = useState(TOKENOMICS.guest.enabled);
  const [exhausted, setExhausted] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .getGuestQuota()
      .then((q) => {
        if (!alive) return;
        setRemaining(q.remaining);
        setLimit(q.limit);
        setGuestEnabled(q.enabled);
        if (q.remaining <= 0) setExhausted(true);
      })
      .catch(() => {
        /* quota unknown until the first send */
      });
    const off = api.onGuestRemaining((n) => {
      if (!alive) return;
      setRemaining(n);
      if (n <= 0) setExhausted(true);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  /* ---------- the key the chat sends with ---------- */
  // Keys created in this browser (secret kept, see lib/keystore.ts) plus one pasted by hand. A pasted key
  // alone is enough to chat on its credits without a wallet: the gateway accepts bearer keys on /v1.
  const [secrets, setSecrets] = useState<Record<string, string>>(() => loadSecrets());
  useEffect(() => setSecrets(loadSecrets()), [keys.data]);
  const [activeKeyId, setActiveKeyIdState] = useState<string | null>(() => loadActiveKeyId());
  const setActiveKeyId = (id: string | null) => {
    setActiveKeyIdState(id);
    saveActiveKeyId(id);
  };
  const choices = useMemo<KeyChoice[]>(() => {
    const kept = (session ? (keys.data ?? []) : [])
      .filter((k) => !k.revoked && secrets[String(k.id)])
      .sort((a, b) => b.created_at - a.created_at)
      .map((k) => ({ id: String(k.id), name: k.name ?? k.masked, key: secrets[String(k.id)] }));
    const pasted = secrets[PASTED_ID];
    return pasted ? [...kept, { id: PASTED_ID, name: `Pasted · ${maskKey(pasted)}`, key: pasted }] : kept;
  }, [keys.data, secrets, session]);
  const activeKey: KeyChoice | null = choices.find((c) => c.id === activeKeyId) ?? choices[0] ?? null;
  // Guest = no wallet AND no key. A visitor with a pasted key chats on that key's credits.
  const guest = !session && !activeKey;

  const ensureKey = async (): Promise<string> => {
    if (activeKey) return activeKey.key;
    if (!token) throw new Error('Connect a wallet or paste a key first');
    const created = await api.createKey(token, { name: 'Chat' });
    rememberSecret(created.id, created.key);
    setActiveKeyId(String(created.id));
    void keys.reload();
    return created.key;
  };

  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteErr, setPasteErr] = useState<string | null>(null);
  const submitPaste = (e: FormEvent) => {
    e.preventDefault();
    const k = pasteText.trim();
    if (!isMeshKey(k)) {
      setPasteErr(k.startsWith('mesh_sk_') ? 'That key looks incomplete.' : 'Mesh keys start with mesh_sk_.');
      return;
    }
    rememberPastedKey(k);
    setSecrets(loadSecrets());
    setActiveKeyId(PASTED_ID);
    setPasteText('');
    setPasteErr(null);
    setPasteOpen(false);
    toast.ok('Key saved in this browser. It is sent only as the Authorization header of your chats.');
  };
  const forgetPasted = () => {
    forgetPastedKey();
    setSecrets(loadSecrets());
    if (activeKeyId === PASTED_ID) setActiveKeyId(null);
  };

  /* ---------- sending ---------- */
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const needsWallet = guest && current !== null && !current.guestAllowed;
  const locked = guest && (exhausted || needsWallet || !guestEnabled);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy || !model || locked) return;
    setInput('');
    const userTurn: Turn = { id: turnId(), role: 'user', content };
    const aiId = turnId();
    const aiTurn: Turn = { id: aiId, role: 'assistant', content: '', streaming: true };
    const history: ChatMessage[] = [
      ...turns.filter((t) => t.role !== 'error').map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content })),
      { role: 'user', content },
    ];
    let convId = activeId;
    const now = Date.now();
    if (!convId || !convs.some((c) => c.id === convId)) {
      convId = newConversationId();
      const id = convId;
      commit((cs) => [{ id, title: titleFor(content), createdAt: now, updatedAt: now, turns: [userTurn, aiTurn] }, ...cs]);
      setActiveId(id);
    } else {
      const id = convId;
      commit((cs) => cs.map((c) => (c.id === id ? { ...c, updatedAt: now, turns: [...c.turns, userTurn, aiTurn] } : c)));
    }
    const id = convId;
    const patch = (fn: (t: Turn) => Turn) => commit((cs) => cs.map((c) => (c.id === id ? { ...c, turns: c.turns.map((t) => (t.id === aiId ? fn(t) : t)) } : c)));

    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const onDelta = (delta: string) => patch((t) => ({ ...t, content: t.content + delta }));
    try {
      let res: api.ChatResult;
      if (guest) {
        res = await api.streamGuestChat({ messages: history, model, signal: ctrl.signal, upstreamName: stats.data?.upstream }, onDelta);
      } else {
        const apiKey = await ensureKey();
        res = await api.streamChat({ apiKey, model, messages: history, signal: ctrl.signal, upstreamName: stats.data?.upstream, privacy }, onDelta);
        void me.reload();
      }
      patch((t) => ({ ...t, streaming: false, via: viaFromResult(res, guest) }));
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      const quota = err instanceof ApiError && (err.code === 'guest_quota_exhausted' || (guest && err.status === 429));
      if (quota) {
        setExhausted(true);
        setRemaining(0);
      }
      commit((cs) =>
        cs.map((c) =>
          c.id === id
            ? {
                ...c,
                turns: c.turns
                  .map((t) => (t.id === aiId && t.content ? { ...t, streaming: false } : t))
                  .filter((t) => !(t.id === aiId && !t.content))
                  .concat(aborted || quota ? [] : [{ id: turnId(), role: 'error' as const, content: friendlyError(err) }]),
              }
            : c,
        ),
      );
      if (!aborted && !quota && !(err instanceof ApiError && err.status === 402)) toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };
  useEffect(() => {
    if (!busy) flush();
  }, [busy, flush]);

  const stop = () => abortRef.current?.abort();

  /* ---------- rail ---------- */
  const [railOpen, setRailOpen] = useState(false);
  const openChat = (id: string | null) => {
    abortRef.current?.abort();
    setActiveId(id);
    setRailOpen(false);
  };
  const deleteChat = (id: string) => {
    if (id === activeId) abortRef.current?.abort();
    commit((cs) => cs.filter((c) => c.id !== id));
    if (id === activeId) setActiveId(null);
  };

  /* ---------- render ---------- */
  const starter = TOKENOMICS.starterCredits.enabled;
  const connectCard = locked ? (
    <div className="connect-card" role="note">
      <div className="connect-copy">
        <span className="display d-s">Connect a wallet to keep going</span>
        <p className="small">
          {!guestEnabled
            ? 'Free messages are paused on this gateway right now.'
            : needsWallet && current
              ? `${current.displayName} is a ${current.tier ?? 'frontier'} model; it needs a wallet.`
              : `You have used today's ${limit} free messages.`}{' '}
          {starter ? 'Starter credits are on us.' : 'Signing a message proves you hold the wallet. No transaction, no fee.'}
        </p>
      </div>
      <button type="button" className="btn primary" onClick={openModal}>
        Connect wallet
      </button>
    </div>
  ) : null;

  const tools = (
    <>
      <ModelPicker id="model" variant="pill" label="Model" models={models} value={model} onChange={setModel} placeholder={modelsErr ? 'Could not load models' : 'Loading…'} />
      {guest ? null : (
        <label className="pill sm chat-pill select" title={PRIVACY_TIER_INFO[privacy].blurb}>
          <span className="dot" aria-hidden="true" style={{ background: privacy === 'upstream_zdr' ? 'var(--info)' : 'var(--accent)' }} />
          <span className="chat-pill-name">{PRIVACY_TIER_INFO[privacy].label}</span>
          <span className="chat-pill-caret" aria-hidden="true" />
          {/* The real control sits over the pill, invisible: native menu, keyboard and screen-reader behaviour for free. */}
          <select id="privacy" aria-label="Privacy" value={privacy} onChange={(e) => setPrivacy(e.target.value)}>
            {PRIVACY_TIERS.map((t) => (
              <option key={t} value={t}>
                {PRIVACY_TIER_INFO[t].label}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );

  const status = guest ? (
    <span className="pill sm num counter" aria-live="polite" title={`${limit} free messages a day, no sign-in`}>
      {remaining === null ? `${limit} free a day` : `${Math.max(0, remaining)} of ${limit} free today`}
    </span>
  ) : !session && activeKey ? (
    <span className="pill sm keyed" aria-live="polite" title="Chatting on a pasted key's credits">
      Key <b className="mono">{maskKey(activeKey.key)}</b>
    </span>
  ) : (
    <span className="pill sm balance num" aria-live="polite">
      Credits <b>{me.data ? fmtUsd(me.data.balance.usd, 3) : '…'}</b>
    </span>
  );

  const welcome = (
    <div className="chat-welcome">
      <h1 className="display d-m">What do you want to ask?</h1>
      <p className="lede">{WELCOME}</p>
      <Suggestions prompts={PROMPTS} onPick={(p) => void send(p)} disabled={busy || locked || !model} />
    </div>
  );

  return (
    <div className="chatapp">
      {railOpen ? <div className="chat-scrim" onClick={() => setRailOpen(false)} aria-hidden="true" /> : null}
      <aside id="chat-rail" className={`chat-rail${railOpen ? ' open' : ''}`} aria-label="Conversations">
        <div className="chat-rail-head">
          <button type="button" className="btn secondary sm new-chat" onClick={() => openChat(null)}>
            New chat
          </button>
          <button type="button" className="btn ghost sm rail-close" onClick={() => setRailOpen(false)} aria-label="Close conversations">
            Close
          </button>
        </div>
        <nav className="chat-list" aria-label="Past conversations">
          {convs.length === 0 ? <p className="small muted">Your chats stay in this browser. Nothing is kept on the gateway.</p> : null}
          {convs.map((c) => (
            <div key={c.id} className={`chat-item${c.id === activeId ? ' on' : ''}`}>
              <button type="button" className="chat-item-title" onClick={() => openChat(c.id)} aria-current={c.id === activeId ? 'page' : undefined}>
                {c.title}
              </button>
              <button type="button" className="chat-item-del" onClick={() => deleteChat(c.id)} aria-label={`Delete “${c.title}”`} title="Delete">
                ×
              </button>
            </div>
          ))}
        </nav>
        <div className="chat-rail-keys" aria-label="Keys">
          <span className="eyebrow">Keys</span>
          {activeKey ? (
            <p className="key-line">
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                Using key: <b title={activeKey.name}>{activeKey.name}</b>
              </span>
              {session || choices.length > 1 ? (
                <label className="btn ghost sm key-switch" title="Switch key">
                  Switch
                  <select
                    aria-label="Switch key"
                    value={activeKey.id}
                    onChange={(e) => {
                      if (e.target.value === '__paste') setPasteOpen(true);
                      else setActiveKeyId(e.target.value);
                    }}
                  >
                    {choices.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                    <option value="__paste">Paste a key…</option>
                  </select>
                </label>
              ) : (
                <button type="button" className="btn ghost sm" onClick={forgetPasted}>
                  Forget
                </button>
              )}
            </p>
          ) : session ? (
            <p className="key-line">
              <span className="muted">{keys.loading && !keys.data ? 'Loading keys…' : 'A key is created on your first message'}</span>
              <button type="button" className="btn ghost sm" onClick={() => setPasteOpen((v) => !v)} aria-expanded={pasteOpen}>
                Paste a key
              </button>
            </p>
          ) : (
            <p className="small muted">Have a key? Paste it to chat on your credits.</p>
          )}
          {pasteOpen || (!session && !activeKey) ? (
            <form className="key-paste" onSubmit={submitPaste} aria-label="Paste an API key">
              <div className="keybox">
                <input
                  id="paste-key"
                  className="input sm mono"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="mesh_sk_…"
                  aria-label="API key"
                  value={pasteText}
                  onChange={(e) => {
                    setPasteText(e.target.value);
                    if (pasteErr) setPasteErr(null);
                  }}
                />
                <button type="submit" className="btn secondary sm" disabled={!pasteText.trim()}>
                  Use
                </button>
              </div>
              {pasteErr ? (
                <span className="err" role="alert">
                  {pasteErr}
                </span>
              ) : (
                <span className="small muted" style={{ fontSize: 12 }}>
                  Stays in this browser; sent only as the Authorization header.
                </span>
              )}
            </form>
          ) : null}
          {activeKey?.id === PASTED_ID && (session || choices.length > 1) ? (
            <button type="button" className="linkbtn small" onClick={forgetPasted} style={{ alignSelf: 'flex-start' }}>
              Forget the pasted key
            </button>
          ) : null}
          <p className="small">
            <Link to="/app/keys">Create / manage keys →</Link>
          </p>
        </div>
        <div className="chat-rail-foot">
          {session ? (
            <div className="row" style={{ gap: 8 }}>
              <span className="pill sm mono" title={session.wallet}>
                {shortAddr(session.wallet, 5, 4)}
              </span>
            </div>
          ) : (
            <>
              <p className="small muted">{activeKey ? 'Connect a wallet to save history across devices and manage keys.' : 'Sign in to save history and use frontier models.'}</p>
              <button type="button" className="btn secondary sm" onClick={openModal} style={{ alignSelf: 'flex-start' }}>
                Connect wallet
              </button>
            </>
          )}
          <nav className="chat-applinks small" aria-label="App sections">
            <Link to="/app">Overview</Link>
            <Link to="/app/keys">Keys</Link>
            <Link to="/app/node">Node</Link>
            <Link to="/app/stake">Stake</Link>
            <Link to="/app/market">Market</Link>
          </nav>
        </div>
      </aside>

      <section className={`chat-main${turns.length === 0 ? ' is-empty' : ''}`} aria-label="Chat">
        <div className="chat-topbar">
          <button type="button" className="btn ghost sm rail-toggle" onClick={() => setRailOpen(true)} aria-expanded={railOpen} aria-controls="chat-rail">
            Chats
          </button>
          <span className="small muted chat-title">{active ? active.title : 'New chat'}</span>
        </div>
        {modelsErr ? <Notice kind="bad">{modelsErr}</Notice> : null}
        <MessageList turns={turns} busy={busy} empty={welcome} after={connectCard} />
        <div className="chat-composer">
          <Composer
            id="prompt"
            value={input}
            onChange={setInput}
            onSend={(t) => void send(t)}
            onStop={stop}
            busy={busy}
            disabled={locked || !model}
            placeholder={locked ? 'Connect a wallet to keep chatting' : 'Ask anything…'}
            tools={tools}
            status={status}
          />
          <p className="small muted composer-help">
            {guest
              ? `Free messages run on network nodes or zero-data-retention providers. Frontier models need a wallet or a key.`
              : `${PRIVACY_TIER_INFO[privacy].blurb} Whoever serves a reply sees the prompt while it runs; the gateway never stores it.`}{' '}
            <Link to="/docs#privacy">How the tiers work</Link>
          </p>
        </div>
      </section>
    </div>
  );
}

function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 402) return `Out of credits. ${err.message}`;
    if (err.status === 401) return 'That API key was rejected. Switch key in the rail, paste another, or create one under Keys.';
    if (err.status === 403 && err.code === 'model_not_allowed_for_guests') return 'That model needs a wallet. Connect one to use it.';
    if (err.status === 429) return 'Rate limited. Wait a moment and try again.';
    return err.message;
  }
  return errorMessage(err);
}
