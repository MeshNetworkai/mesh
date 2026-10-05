import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { ChatResult } from '../lib/api';
import { fmtCost, fmtLatency } from '../lib/format';
import { useCopy } from '../lib/hooks';
import { Markdown } from './Markdown';
import { Spinner } from './ui';

/**
 * The chat surface shared by /app/chat (pages/Chat.tsx) and the homepage card (GuestChat.tsx):
 * the message list (bubbles, streaming caret, Markdown replies, "served by …" line, copy) and the
 * composer (auto-growing textarea, Enter to send, Shift+Enter for a newline, Stop while streaming,
 * compact pills for model and privacy). The two pages differ only in layout and what they put in
 * the pills, so they read as one product.
 */

export interface TurnVia {
  servedBy: string;
  model: string;
  /** USD charged for the reply; null when unknown. */
  cost: number | null;
  latencyMs: number;
  /** Network credits only: what the upstream list price would have been minus what was billed. */
  savedUsd: number | null;
  /** Guest replies: the treasury paid, the visitor paid nothing. */
  free?: boolean;
}

export interface Turn {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  streaming?: boolean;
  via?: TurnVia | null;
}

export function viaFromResult(res: ChatResult, free = false): TurnVia {
  return {
    servedBy: res.servedBy,
    model: res.model,
    cost: typeof res.usage?.cost === 'number' ? res.usage.cost : null,
    latencyMs: res.latencyMs,
    savedUsd: res.mesh && typeof res.mesh.savedUsd === 'number' ? res.mesh.savedUsd : null,
    free,
  };
}

let seq = 0;
export const turnId = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

function Via({ via }: { via: TurnVia }) {
  const cost = via.free ? 'free' : via.cost === null ? 'cost n/a' : fmtCost(via.cost);
  return (
    <span className="via">
      served by {via.servedBy} · {via.model} · {cost}
      {!via.free && via.savedUsd !== null && via.savedUsd > 0 ? <> · saved {fmtCost(via.savedUsd)} vs list</> : null} · {fmtLatency(via.latencyMs)}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, copy] = useCopy();
  return (
    <button type="button" className="msg-copy" onClick={() => void copy(text)} aria-label={copied ? 'Copied' : 'Copy reply'}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function Message({ turn }: { turn: Turn }) {
  const cls = turn.role === 'user' ? 'user' : turn.role === 'error' ? 'err' : 'ai';
  const body =
    turn.role === 'assistant' ? (
      turn.content ? (
        <Markdown text={turn.content} />
      ) : null
    ) : (
      <span className="msg-text">{turn.content}</span>
    );
  return (
    <div className={`msg ${cls}`}>
      {body}
      {turn.streaming ? <span className="caret" aria-hidden="true" /> : null}
      {turn.role === 'assistant' && !turn.streaming && (turn.via || turn.content) ? (
        <div className="msg-foot">
          {turn.via ? <Via via={turn.via} /> : <span className="via" />}
          {turn.content ? <CopyButton text={turn.content} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Scrolling message list. Follows the newest message while the reader is at (or near) the bottom
 * and leaves them alone once they scroll up to re-read something.
 */
export function MessageList({ turns, busy, empty, after, className = '' }: { turns: Turn[]; busy: boolean; empty?: ReactNode; after?: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns, after]);
  return (
    <div className={`thread ${className}`.trim()} ref={ref} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions text" aria-busy={busy}>
      <div className="thread-col">
        {turns.length === 0 ? empty : null}
        {turns.map((t) => (
          <Message key={t.id} turn={t} />
        ))}
        {after}
      </div>
    </div>
  );
}

export function Composer({
  id,
  value,
  onChange,
  onSend,
  onStop,
  busy,
  disabled = false,
  placeholder,
  tools,
  status,
  autoFocus = false,
  maxRows = 8,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Left side of the bar under the textarea: model and privacy pills. */
  tools?: ReactNode;
  /** Right side of the bar, before the send button: a counter or a balance. */
  status?: ReactNode;
  autoFocus?: boolean;
  maxRows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [lineHeight, setLineHeight] = useState(22);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const lh = parseFloat(getComputedStyle(el).lineHeight);
    if (Number.isFinite(lh)) setLineHeight(lh);
  }, []);

  // Grow with the text up to maxRows, then scroll inside.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = lineHeight * maxRows + 8;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value, lineHeight, maxRows]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const text = value.trim();
    if (!text || busy || disabled) return;
    onSend(text);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form className="composer" onSubmit={submit}>
      <label className="sr-only" htmlFor={id}>
        Message
      </label>
      <textarea
        id={id}
        ref={ref}
        className="composer-input"
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
      />
      <div className="composer-bar">
        <div className="composer-tools">{tools}</div>
        <div className="composer-right">
          {status}
          {busy ? (
            <button type="button" className="btn secondary sm" onClick={onStop}>
              <Spinner /> Stop
            </button>
          ) : (
            <button type="submit" className="btn primary sm send" disabled={!value.trim() || disabled}>
              Send
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

/** Suggested prompts shown in the empty state; each sends itself. */
export function Suggestions({ prompts, onPick, disabled }: { prompts: string[]; onPick: (p: string) => void; disabled?: boolean }) {
  return (
    <div className="chips suggest" aria-label="Suggested prompts">
      {prompts.map((p) => (
        <button key={p} type="button" className="chip" onClick={() => onPick(p)} disabled={disabled}>
          {p}
        </button>
      ))}
    </div>
  );
}
