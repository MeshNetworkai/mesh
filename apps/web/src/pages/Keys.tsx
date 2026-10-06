import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Empty, Modal, Notice, Skeleton, Spinner } from '../components/ui';
import * as api from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtCost, fmtDate, fmtInt } from '../lib/format';
import { useCopy, useKeys } from '../lib/hooks';
import { errorMessage, useToast } from '../lib/toast';
import { forgetSecret, rememberSecret } from '../lib/keystore';
import { PRIVACY_TIERS, PRIVACY_TIER_INFO, type ApiKey, type CreatedKey, type KeyUsage, type PrivacyTier } from '../lib/types';

/** '' = gateway default (trusted). */
type PrivacyChoice = PrivacyTier | '';
const asPrivacy = (v: string): PrivacyChoice => ((PRIVACY_TIERS as string[]).includes(v) ? (v as PrivacyTier) : '');

function PrivacySelect({ id, value, onChange }: { id: string; value: PrivacyChoice; onChange: (v: PrivacyChoice) => void }) {
  return (
    <select id={id} className="input sm" value={value} onChange={(e) => onChange(asPrivacy(e.target.value))} title={value ? PRIVACY_TIER_INFO[value].blurb : 'Use the gateway default (trusted nodes)'}>
      <option value="">Gateway default (trusted)</option>
      {PRIVACY_TIERS.map((t) => (
        <option key={t} value={t}>
          {PRIVACY_TIER_INFO[t].label}
        </option>
      ))}
    </select>
  );
}

function privacyCell(k: ApiKey) {
  const p = k.privacy ?? null;
  if (!p) return <span className="muted" title="Requests without an explicit tier use the gateway default: trusted nodes">default · trusted</span>;
  return <span title={PRIVACY_TIER_INFO[p].blurb}>{PRIVACY_TIER_INFO[p].label}</span>;
}

/** GET /keys/:id/usage — all-time requests + 24h spend, with a 7d/top-model tooltip. */
function KeyUsageCell({ id, bump }: { id: number; bump: number }) {
  const { token } = useAuth();
  const [usage, setUsage] = useState<KeyUsage | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    if (!token) return;
    api
      .keyUsage(token, id)
      .then((u) => alive && setUsage(u))
      .catch(() => alive && setUsage(null));
    return () => {
      alive = false;
    };
  }, [token, id, bump]);
  if (usage === undefined) return <Skeleton w="9ch" />;
  if (usage === null) return <span className="muted" title="Usage unavailable">—</span>;
  const top = usage.topModels[0];
  const title = [
    `24h: ${fmtInt(usage.last24h.requests)} req · ${fmtCost(usage.last24h.spendUsd)}`,
    `7d: ${fmtInt(usage.last7d.requests)} req · ${fmtCost(usage.last7d.spendUsd)}`,
    top ? `top model: ${top.model}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span title={title}>
      {fmtInt(usage.requestCount)} req · {fmtCost(usage.allTime.spendUsd)}
    </span>
  );
}

function limitCell(k: ApiKey) {
  if (k.spendLimitUsd === null) return <span className="muted">none</span>;
  const pct = k.spendLimitUsd > 0 ? Math.min(100, (k.spentUsd / k.spendLimitUsd) * 100) : 0;
  const exhausted = k.spentUsd >= k.spendLimitUsd;
  return (
    <span className={exhausted ? 'neg' : undefined} title={`${fmtCost(k.spentUsd)} of ${fmtCost(k.spendLimitUsd)} spent (${pct.toFixed(0)}%)`}>
      {fmtCost(k.spentUsd)} / {fmtCost(k.spendLimitUsd)}
      {exhausted ? ' · reached' : ''}
    </span>
  );
}

function RevealModal({ created, onClose }: { created: CreatedKey; onClose: () => void }) {
  const [copied, copy] = useCopy();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <Modal title="Your API key" onClose={onClose}>
      <Notice kind="warn">{created.note ?? 'Store this key now; it is not shown again.'}</Notice>
      <div className="field">
        <label htmlFor="newkey">API key · shown once</label>
        <div className="keybox">
          <input id="newkey" ref={ref} className="input mono" value={created.key} readOnly onFocus={(e) => e.currentTarget.select()} />
          <button
            className="btn secondary sm"
            onClick={() => {
              void copy(created.key);
              ref.current?.select();
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <p className="small muted">
        Use it as an OpenAI key: set <code className="mono">OPENAI_API_KEY</code> to this value and{' '}
        <code className="mono">OPENAI_BASE_URL</code> to the gateway's <code className="mono">/v1</code>.
      </p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary" onClick={onClose}>
          I've stored it
        </button>
      </div>
    </Modal>
  );
}

export function Keys() {
  const { token } = useAuth();
  const toast = useToast();
  const keys = useKeys();
  const [label, setLabel] = useState('');
  const [newLimit, setNewLimit] = useState('');
  const [newPrivacy, setNewPrivacy] = useState<PrivacyChoice>('');
  const [creating, setCreating] = useState(false);
  const [usageBump, setUsageBump] = useState(0);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setCreating(true);
    try {
      const res = await api.createKey(token, { name: label.trim() || undefined, spendLimitUsd: parseLimit(newLimit), privacy: newPrivacy || undefined });
      rememberSecret(res.id, res.key);
      setCreated(res);
      setLabel('');
      setNewLimit('');
      setNewPrivacy('');
      await keys.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const onRevoke = async (k: ApiKey) => {
    if (!token) return;
    if (!window.confirm(`Revoke ${k.name ?? k.masked}? Requests using it will fail immediately.`)) return;
    setBusyId(k.id);
    try {
      await api.revokeKey(token, k.id);
      forgetSecret(k.id);
      toast.ok('Key revoked');
      await keys.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const list = (keys.data ?? []).filter((k) => showRevoked || !k.revoked);
  const revokedCount = (keys.data ?? []).filter((k) => k.revoked).length;

  return (
    <>
      <div className="row between">
        <span className="display d-s">API keys</span>
        <span className="small muted">Each key spends from the same credit balance. Spent: {fmtCost((keys.data ?? []).reduce((a, k) => a + k.spentUsd, 0))}</span>
      </div>

      <form className="row" onSubmit={onCreate} aria-label="Create API key">
        <div className="field" style={{ flex: '1 1 220px' }}>
          <label htmlFor="label">Name · optional</label>
          <input id="label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={64} placeholder="laptop, cursor, ci…" />
        </div>
        <div className="field" style={{ flex: '0 1 180px' }}>
          <label htmlFor="newlimit">Spend limit · USD · optional</label>
          <input id="newlimit" className="input num" inputMode="decimal" value={newLimit} onChange={(e) => setNewLimit(e.target.value)} placeholder="none" />
        </div>
        <div className="field" style={{ flex: '0 1 220px' }}>
          <label htmlFor="newprivacy">Default privacy</label>
          <PrivacySelect id="newprivacy" value={newPrivacy} onChange={setNewPrivacy} />
        </div>
        <button className="btn primary" type="submit" disabled={creating || !token} style={{ alignSelf: 'end' }}>
          {creating ? <Spinner /> : null}
          Create API key
        </button>
      </form>

      {keys.error && !keys.data ? <Notice kind="bad">Could not load keys: {keys.error}</Notice> : null}

      {keys.loading && !keys.data ? (
        <div className="tblwrap">
          <table className="tbl">
            <tbody>
              {[0, 1].map((i) => (
                <tr key={i}>
                  <td>
                    <Skeleton w="8ch" />
                  </td>
                  <td>
                    <Skeleton w="22ch" />
                  </td>
                  <td>
                    <Skeleton w="8ch" />
                  </td>
                  <td>
                    <Skeleton w="10ch" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : list.length === 0 ? (
        <Empty title={revokedCount ? 'All keys revoked' : 'No API keys yet'}>
          Create one above. It works anywhere an OpenAI key works.
        </Empty>
      ) : (
        <div className="tblwrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Created</th>
                <th>Privacy</th>
                <th>Usage</th>
                <th className="num">Spent / limit</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.map((k) => {
                const name = k.name ?? k.label ?? null;
                return (
                  <tr key={k.id} style={k.revoked ? { opacity: 0.55 } : undefined}>
                    <td>
                      {name ?? <span className="muted">untitled</span>}
                      {k.revoked ? (
                        <span className="pill off sm" style={{ marginLeft: 8 }}>
                          <span className="dot" />
                          revoked
                        </span>
                      ) : null}
                    </td>
                    <td className="mono">{k.masked}</td>
                    <td className="date">{fmtDate(k.created_at)}</td>
                    <td style={{ fontSize: 13 }}>{privacyCell(k)}</td>
                    <td className="num" style={{ textAlign: 'left' }}>
                      <KeyUsageCell id={k.id} bump={usageBump} />
                    </td>
                    <td className="num">
                      {limitCell(k)}
                    </td>
                    <td className="actions">
                      <button className="btn ghost sm" onClick={() => setEditing(k)} disabled={k.revoked}>
                        Edit
                      </button>
                      <button className="btn danger sm" onClick={() => onRevoke(k)} disabled={k.revoked || busyId === k.id}>
                        {busyId === k.id ? <Spinner /> : null}
                        Revoke
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {revokedCount > 0 ? (
        <div className="row">
          <button className="btn ghost sm" onClick={() => setShowRevoked((v) => !v)}>
            {showRevoked ? 'Hide' : 'Show'} {revokedCount} revoked
          </button>
        </div>
      ) : null}

      <p className="small muted">
        Names, spend limits and the default privacy tier are stored by the gateway. A spend limit is a lifetime cap on what the key can spend;
        requests over it get <span className="mono">429 key_spend_limit_reached</span> until you raise or clear it. The default privacy tier
        applies when a request sends neither <span className="mono">X-Mesh-Privacy</span> nor <span className="mono">mesh.privacy</span>; the
        gateway default is trusted nodes.
      </p>

      {created ? <RevealModal created={created} onClose={() => setCreated(null)} /> : null}
      {editing ? (
        <EditModal
          k={editing}
          onClose={() => setEditing(null)}
          onSave={async (newName, limit, privacy) => {
            if (!token) return;
            const patch: api.KeyInput = {};
            if (newName !== (editing.name ?? '')) patch.name = newName || null;
            if (limit !== editing.spendLimitUsd) patch.spendLimitUsd = limit;
            if (privacy !== (editing.privacy ?? '')) patch.privacy = privacy || null;
            if (Object.keys(patch).length === 0) {
              setEditing(null);
              return;
            }
            try {
              await api.updateKey(token, editing.id, patch);
              toast.ok('Key updated');
              setEditing(null);
              setUsageBump((n) => n + 1);
              await keys.reload();
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        />
      ) : null}
    </>
  );
}

/** "" → null (no limit); otherwise a positive finite number or null when unparsable. */
function parseLimit(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function EditModal({ k, onClose, onSave }: { k: ApiKey; onClose: () => void; onSave: (name: string, limit: number | null, privacy: PrivacyChoice) => Promise<void> }) {
  const [label, setLabel] = useState(k.name ?? '');
  const [limit, setLimit] = useState(k.spendLimitUsd !== null ? String(k.spendLimitUsd) : '');
  const [privacy, setPrivacy] = useState<PrivacyChoice>(k.privacy ?? '');
  const [saving, setSaving] = useState(false);
  return (
    <Modal title="Edit key" onClose={onClose}>
      <p className="mono small muted">{k.masked}</p>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          await onSave(label.trim(), parseLimit(limit), privacy);
          setSaving(false);
        }}
      >
        <div className="field">
          <label htmlFor="elabel">Name</label>
          <input id="elabel" className="input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={64} />
        </div>
        <div className="field">
          <label htmlFor="elimit">Spend limit · USD · lifetime · blank for none</label>
          <input id="elimit" className="input num" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="0.50" />
        </div>
        <div className="field">
          <label htmlFor="eprivacy">Default privacy · when a request does not pick a tier</label>
          <PrivacySelect id="eprivacy" value={privacy} onChange={setPrivacy} />
          <p className="small muted" style={{ margin: '4px 0 0' }}>{privacy ? PRIVACY_TIER_INFO[privacy].blurb : PRIVACY_TIER_INFO.trusted.blurb}</p>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? <Spinner /> : null}
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
