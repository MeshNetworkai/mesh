import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { MODEL_TIER_INFO, type CatalogueModel, type ModelTier } from '../lib/types';

/**
 * Model picker shared by /app/chat (pages/Chat.tsx) and the homepage guest chat (GuestChat.tsx). Rows come
 * from GET /v1/models and are grouped Network (Macs) / Frontier / Fast / Open weights; every row shows what
 * Mesh bills against the upstream list price and where the prompt is processed (docs/PRICING.md).
 */

type GroupKey = 'network' | ModelTier;

const GROUPS: Array<{ key: GroupKey; label: string; blurb: string }> = [
  { key: 'network', label: 'Network (Macs)', blurb: 'Served by Mesh nodes at the flat network price. Falls back to the upstream when no node is free.' },
  { key: 'frontier', label: MODEL_TIER_INFO.frontier.label, blurb: MODEL_TIER_INFO.frontier.blurb },
  { key: 'fast', label: MODEL_TIER_INFO.fast.label, blurb: MODEL_TIER_INFO.fast.blurb },
  { key: 'open', label: MODEL_TIER_INFO.open.label, blurb: MODEL_TIER_INFO.open.blurb },
];

function groupOf(m: CatalogueModel): GroupKey {
  if (m.served !== 'upstream') return 'network';
  return m.tier ?? 'open';
}

/** "$0.02" / "$2.40" / "$15": trailing zeros trimmed, at most 3 decimals for sub-dollar prices. */
export function fmtPerM(n: number): string {
  if (n === 0) return '$0';
  const digits = n < 0.1 ? 3 : n < 10 ? 2 : 0;
  return `$${Number(n.toFixed(digits)).toString()}`;
}

/** "in $0.05 · out $0.08" or, when both match, "$0.02 per M". */
function fmtPair(p: { promptUsdPerM: number; completionUsdPerM: number }): string {
  if (p.promptUsdPerM === p.completionUsdPerM) return `${fmtPerM(p.promptUsdPerM)} per M`;
  return `${fmtPerM(p.promptUsdPerM)} in · ${fmtPerM(p.completionUsdPerM)} out`;
}

function pctOff(m: CatalogueModel): number | null {
  const list = m.listPrice.promptUsdPerM + m.listPrice.completionUsdPerM;
  const mesh = m.meshPrice.promptUsdPerM + m.meshPrice.completionUsdPerM;
  if (list <= 0 || mesh >= list) return null;
  return Math.round((1 - mesh / list) * 100);
}

/** Privacy tier badge: where the prompt is processed. */
export function PrivacyBadge({ privacy, compact = false }: { privacy: CatalogueModel['privacy']; compact?: boolean }) {
  const network = privacy === 'network';
  return (
    <span
      className="pill sm"
      title={network ? 'Processed on a Mesh node; nothing is stored after the reply.' : 'Processed upstream by zero-data-retention providers only.'}
      style={{ gap: 6, padding: compact ? '2px 8px' : undefined, fontSize: compact ? 11 : undefined, flex: 'none' }}
    >
      <span className="dot" aria-hidden="true" style={{ background: network ? 'var(--accent)' : 'var(--info)' }} />
      {network ? 'Mesh nodes' : 'Upstream · ZDR'}
    </span>
  );
}

/** The panel is position: fixed and placed from the button's rect so an `overflow: hidden` card (the homepage readout) cannot clip it. */
const panelStyle: CSSProperties = {
  position: 'fixed',
  zIndex: 40,
  overflowY: 'auto',
  background: 'var(--bg)',
  border: '1px solid var(--line-2)',
  borderRadius: 'var(--r)',
  boxShadow: '0 16px 40px rgba(5, 9, 18, 0.16)',
  padding: 6,
};

export function ModelPicker({
  id,
  models,
  value,
  onChange,
  disabled,
  placeholder = 'Loading…',
  size = 'sm',
  variant = 'input',
  label,
}: {
  id: string;
  models: CatalogueModel[] | null;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  placeholder?: string;
  size?: 'sm' | 'md';
  /** `pill`: a compact pill for the chat composer bar (name + a price hint); `input`: the full-width field. */
  variant?: 'input' | 'pill';
  /** Accessible name when there is no visible <label> (the pill variant). */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = models?.find((m) => m.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(Math.max(r.width, 520), vw - 32);
      const left = Math.max(16, Math.min(r.left, vw - width - 16));
      const below = vh - r.bottom - 12;
      const above = r.top - 12;
      const openUp = below < 280 && above > below;
      const maxHeight = Math.min(440, openUp ? above : below);
      setPlace(openUp ? { left, width, bottom: vh - r.top + 6, maxHeight } : { left, width, top: r.bottom + 6, maxHeight });
    };
    measure();
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !document.getElementById(listId)?.contains(t)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // Page scroll or resize moves the anchor: close rather than float away. The panel's own scrolling is fine.
    const onMove = (e?: Event) => {
      if (e && e.target instanceof Node && document.getElementById(listId)?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, listId]);

  const groups = useMemo(() => {
    const by = new Map<GroupKey, CatalogueModel[]>();
    for (const m of models ?? []) {
      const g = groupOf(m);
      by.set(g, [...(by.get(g) ?? []), m]);
    }
    return GROUPS.filter((g) => (by.get(g.key) ?? []).length > 0).map((g) => ({ ...g, rows: by.get(g.key)! }));
  }, [models]);

  const off = current ? pctOff(current) : null;
  const pill = variant === 'pill';

  return (
    <div ref={wrapRef} style={{ position: 'relative', minWidth: 0 }}>
      <button
        id={id}
        type="button"
        className={pill ? 'pill sm chat-pill' : `input ${size}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={label}
        disabled={disabled || !models}
        onClick={() => setOpen((o) => !o)}
        style={pill ? undefined : { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, textAlign: 'left', cursor: disabled || !models ? 'default' : 'pointer' }}
      >
        {pill ? (
          current ? (
            <>
              <span className="dot" aria-hidden="true" style={{ background: current.privacy === 'network' ? 'var(--accent)' : 'var(--info)' }} />
              <span className="chat-pill-name">{current.displayName}</span>
              <span className="muted chat-pill-hint">{fmtPair(current.meshPrice)}</span>
              <span className="chat-pill-caret" aria-hidden="true" />
            </>
          ) : (
            <span className="muted">{models ? 'Pick a model' : placeholder}</span>
          )
        ) : current ? (
          <>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
              <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{current.displayName}</span>
              <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                {fmtPair(current.meshPrice)}
                {off !== null ? ` · ${off}% below list` : ''}
              </span>
            </span>
            <PrivacyBadge privacy={current.privacy} compact />
          </>
        ) : (
          <span className="muted">{models ? 'Pick a model' : placeholder}</span>
        )}
      </button>

      {open && models ? (
        <div id={listId} role="listbox" aria-labelledby={id} style={{ ...panelStyle, ...place }}>
          {groups.map((g) => (
            <div key={g.key} role="group" aria-label={g.label} style={{ padding: '6px 0' }}>
              <div style={{ padding: '6px 10px 4px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)', whiteSpace: 'nowrap' }}>{g.label}</span>
                <span className="muted" style={{ fontSize: 11, textAlign: 'right' }}>
                  {g.blurb}
                </span>
              </div>
              {g.rows.map((m) => {
                const selected = m.id === value;
                const pct = pctOff(m);
                const sameAsList = m.meshPrice.promptUsdPerM === m.listPrice.promptUsdPerM && m.meshPrice.completionUsdPerM === m.listPrice.completionUsdPerM;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onChange(m.id);
                      setOpen(false);
                    }}
                    style={{
                      width: '100%',
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) auto',
                      alignItems: 'center',
                      gap: 12,
                      padding: '8px 10px',
                      border: 0,
                      borderRadius: 8,
                      background: selected ? 'var(--accent-soft)' : 'transparent',
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => {
                      if (!selected) e.currentTarget.style.background = 'var(--bg-2)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = selected ? 'var(--accent-soft)' : 'transparent';
                    }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                        <span style={{ fontWeight: 500, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.displayName}</span>
                        <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                          {m.vendor}
                          {m.served !== 'upstream' ? ` · ${m.online} ${m.online === 1 ? 'Mac' : 'Macs'} online` : ''}
                        </span>
                      </span>
                      <span style={{ display: 'block', fontSize: 12, marginTop: 2, color: 'var(--fg-2)' }}>
                        <span style={{ fontWeight: 500, color: 'var(--fg)' }}>{fmtPair(m.meshPrice)}</span>
                        {sameAsList ? (
                          <span className="muted"> · list price</span>
                        ) : (
                          <>
                            <span className="muted"> vs </span>
                            <span className="muted" style={{ textDecoration: pct !== null ? 'line-through' : undefined }}>
                              {fmtPair(m.listPrice)}
                            </span>
                            {pct !== null ? <span style={{ color: 'var(--accent)' }}> · {pct}% below list</span> : null}
                          </>
                        )}
                      </span>
                    </span>
                    <PrivacyBadge privacy={m.privacy} compact />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
