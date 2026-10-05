import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { parse } from 'yaml';
import { Terminal } from '../components/ui';
import { PUBLIC_API_URL, TOKENOMICS } from '../config';
import { getCatalogue } from '../lib/api';
import { fmtCost, fmtUsd } from '../lib/format';
import type { Catalogue, CatalogueModel } from '../lib/types';
import modelPolicy from '../../../../config/model-policy.json';
import specYaml from '../../../gateway/openapi.yaml?raw';

/*
 * /api — renders apps/gateway/openapi.yaml with a small inline renderer. No external scripts: the YAML
 * is bundled at build time (same file the gateway serves at GET /openapi.json) and parsed here.
 */

type Json = Record<string, unknown>;
interface Operation {
  method: string;
  path: string;
  op: Json;
  id: string;
}

const METHOD_ORDER = ['get', 'post', 'patch', 'put', 'delete'];
const spec = parse(specYaml) as Json;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}
function arr<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Resolve a local `$ref` (`#/components/...`). Returns the input when it is not a ref. */
function deref(node: unknown, depth = 0): Json {
  const o = obj(node);
  const ref = str(o.$ref);
  if (!ref || depth > 8) return o;
  const parts = ref.replace(/^#\//, '').split('/');
  let cur: unknown = spec;
  for (const p of parts) cur = obj(cur)[p];
  return deref(cur, depth + 1);
}

/** Flatten `allOf` into one schema for display. */
function flatten(schema: Json): Json {
  const s = deref(schema);
  if (!Array.isArray(s.allOf)) return s;
  const out: Json = { ...s, properties: {} as Json };
  const props: Json = {};
  const required: string[] = [];
  for (const part of s.allOf) {
    const p = flatten(obj(part));
    Object.assign(props, obj(p.properties));
    required.push(...arr<string>(p.required));
    if (p.description && !out.description) out.description = p.description;
  }
  out.properties = props;
  out.required = required;
  delete out.allOf;
  return out;
}

function typeOf(schema: Json): string {
  const s = flatten(schema);
  if (s.const !== undefined) return `const ${JSON.stringify(s.const)}`;
  if (Array.isArray(s.enum)) return (s.enum as unknown[]).map((e) => JSON.stringify(e)).join(' | ');
  if (Array.isArray(s.oneOf)) return (s.oneOf as unknown[]).map((o) => typeOf(obj(o))).join(' | ');
  const t = Array.isArray(s.type) ? (s.type as string[]).join(' | ') : str(s.type);
  if (t === 'array' || t.startsWith('array')) return `${typeOf(obj(s.items))}[]`;
  if (!t && s.properties) return 'object';
  return t || 'any';
}

function Inline({ text }: { text: string }) {
  // `code`, **bold**, [label](url)
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
        if (p.startsWith('**')) return <b key={i}>{p.slice(2, -2)}</b>;
        const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p);
        if (m) {
          return (
            <a key={i} href={m[2]}>
              {m[1]}
            </a>
          );
        }
        return <Fragment key={i}>{p}</Fragment>;
      })}
    </>
  );
}

/** Minimal Markdown: paragraphs, `* ` bullets, inline code/bold/links. */
function Md({ text, className }: { text: string; className?: string }) {
  const blocks = text.trim().split(/\n\s*\n/);
  return (
    <div className={`md ${className ?? ''}`}>
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        if (lines.every((l) => /^\s*[*-]\s/.test(l) || /^\s{2,}\S/.test(l))) {
          const items: string[] = [];
          for (const l of lines) {
            if (/^\s*[*-]\s/.test(l)) items.push(l.replace(/^\s*[*-]\s/, ''));
            else items[items.length - 1] += ` ${l.trim()}`;
          }
          return (
            <ul key={i}>
              {items.map((it, j) => (
                <li key={j}>
                  <Inline text={it} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            <Inline text={lines.join(' ')} />
          </p>
        );
      })}
    </div>
  );
}

function Schema({ schema, depth = 0 }: { schema: Json; depth?: number }) {
  const s = flatten(schema);
  const props = obj(s.properties);
  const required = new Set(arr<string>(s.required));
  const names = Object.keys(props);
  if (!names.length) {
    const items = s.items ? flatten(obj(s.items)) : null;
    if (items && obj(items.properties) && Object.keys(obj(items.properties)).length) {
      return (
        <div className="schema">
          <span className="small muted">array of</span>
          <Schema schema={items} depth={depth + 1} />
        </div>
      );
    }
    return (
      <p className="small muted">
        {typeOf(s)}
        {s.description ? ` · ${str(s.description)}` : ''}
      </p>
    );
  }
  return (
    <table className="schema" aria-label="Fields">
      <tbody>
        {names.map((n) => {
          const p = flatten(obj(props[n]));
          const nested = Object.keys(obj(p.properties)).length > 0 || (p.items && Object.keys(obj(flatten(obj(p.items)).properties)).length > 0);
          return (
            <tr key={n}>
              <td className="k">
                <code>{n}</code>
                {required.has(n) ? <span className="req">required</span> : null}
              </td>
              <td className="t mono">{typeOf(p)}</td>
              <td className="d">
                {p.description ? <Inline text={str(p.description)} /> : null}
                {p.example !== undefined ? <span className="ex mono">e.g. {JSON.stringify(p.example)}</span> : null}
                {nested && depth < 2 ? (
                  <details>
                    <summary>fields</summary>
                    <Schema schema={p.items ? obj(p.items) : p} depth={depth + 1} />
                  </details>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function pickExample(media: Json): { body: string; lang: 'json' | 'text' } | null {
  if (media.example !== undefined) {
    return typeof media.example === 'string' ? { body: media.example, lang: 'text' } : { body: JSON.stringify(media.example, null, 2), lang: 'json' };
  }
  const examples = obj(media.examples);
  const first = Object.values(examples)[0];
  if (first) {
    const v = obj(first).value;
    return typeof v === 'string' ? { body: v, lang: 'text' } : { body: JSON.stringify(v, null, 2), lang: 'json' };
  }
  return null;
}

function securityOf(op: Json): string[] {
  const sec = op.security === undefined ? arr(spec.security) : arr(op.security);
  return sec.flatMap((s) => Object.keys(obj(s)));
}

const AUTH_HEADER: Record<string, string> = {
  session: 'Authorization: Bearer $MESH_JWT',
  apiKey: 'Authorization: Bearer $MESH_API_KEY',
  nodeToken: 'Authorization: Bearer $MESH_NODE_TOKEN',
};
const AUTH_LABEL: Record<string, string> = { session: 'Session JWT', apiKey: 'API key', nodeToken: 'Node token' };

function curlFor(o: Operation): string {
  const method = o.method.toUpperCase();
  const params = arr<Json>(o.op.parameters).map((p) => deref(p));
  let path = o.path;
  for (const p of params) {
    if (p.in === 'path') {
      const ex = obj(p.schema).example ?? (str(obj(p.schema).type) === 'integer' ? 3 : `<${str(p.name)}>`);
      path = path.replace(`{${str(p.name)}}`, String(ex));
    }
  }
  const query = params.filter((p) => p.in === 'query' && obj(p.schema).default !== undefined).map((p) => `${str(p.name)}=${String(obj(p.schema).default)}`);
  const url = `${PUBLIC_API_URL}${path}${query.length ? `?${query.join('&')}` : ''}`;
  const lines = [`curl ${method === 'GET' ? '' : `-X ${method} `}${url}`];
  const sec = securityOf(o.op);
  if (sec.length) lines.push(`  -H "${AUTH_HEADER[sec[0]] ?? 'Authorization: Bearer <token>'}"`);
  const body = obj(o.op.requestBody);
  const json = obj(obj(body.content)['application/json']);
  const ex = Object.keys(json).length ? pickExample(json) : null;
  if (ex && ex.lang === 'json') {
    lines.push(`  -H "Content-Type: application/json"`);
    lines.push(`  -d '${ex.body.replace(/\n\s*/g, ' ').replace(/'/g, "'\\''")}'`);
  }
  return lines.join(' \\\n');
}

function Endpoint({ o }: { o: Operation }) {
  const op = o.op;
  const params = arr<Json>(op.parameters).map((p) => deref(p));
  const body = obj(op.requestBody);
  const bodyJson = obj(obj(body.content)['application/json']);
  const bodyExample = Object.keys(bodyJson).length ? pickExample(bodyJson) : null;
  const responses = Object.entries(obj(op.responses)).map(([code, r]) => [code, deref(r)] as const);
  const sec = securityOf(op);
  const [resp, setResp] = useState(0);
  const [tab, setTab] = useState<'example' | 'schema'>('example');
  const current = responses[resp];
  const content = current ? obj(current[1].content) : {};
  const mediaTypes = Object.keys(content);
  const [media, setMedia] = useState(0);
  const mediaKey = mediaTypes[Math.min(media, Math.max(0, mediaTypes.length - 1))];
  const mediaObj = mediaKey ? obj(content[mediaKey]) : null;
  const example = mediaObj ? pickExample(mediaObj) : null;
  const headers = current ? obj(current[1].headers) : {};

  return (
    <article className="ep" id={o.id}>
      <header className="ep-head">
        <a className="ep-sig" href={`#${o.id}`}>
          <span className={`method ${o.method}`}>{o.method.toUpperCase()}</span>
          <code className="path">{o.path}</code>
        </a>
        <span className="eyebrow">{sec.length ? sec.map((s) => AUTH_LABEL[s] ?? s).join(' or ') : 'Public'}</span>
      </header>
      <div className="ep-body">
        <div className="stack ep-text">
          <h3 className="display d-s">{str(op.summary)}</h3>
          {op.description ? <Md text={str(op.description)} /> : null}
          {params.length ? (
            <div className="stack sm">
              <span className="eyebrow">Parameters</span>
              <table className="schema" aria-label="Parameters">
                <tbody>
                  {params.map((p) => (
                    <tr key={`${str(p.in)}-${str(p.name)}`}>
                      <td className="k">
                        <code>{str(p.name)}</code>
                        <span className="req">{str(p.in)}</span>
                        {p.required ? <span className="req">required</span> : null}
                      </td>
                      <td className="t mono">{typeOf(obj(p.schema))}</td>
                      <td className="d">
                        {p.description ? <Inline text={str(p.description)} /> : null}
                        {obj(p.schema).default !== undefined ? <span className="ex mono">default {JSON.stringify(obj(p.schema).default)}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {Object.keys(bodyJson).length ? (
            <div className="stack sm">
              <span className="eyebrow">Request body{body.required ? '' : ' · optional'}</span>
              <Schema schema={obj(bodyJson.schema)} />
            </div>
          ) : null}
          <div className="stack sm">
            <span className="eyebrow">Responses</span>
            <div className="tabs" role="tablist" aria-label="Response codes">
              {responses.map(([code, r], i) => (
                <button key={code} role="tab" aria-selected={i === resp} className={i === resp ? 'on' : ''} onClick={() => (setResp(i), setMedia(0))} title={str(r.description)}>
                  {code}
                </button>
              ))}
            </div>
            {current ? <Md text={str(current[1].description)} className="small" /> : null}
            {Object.keys(headers).length ? (
              <table className="schema" aria-label="Response headers">
                <tbody>
                  {Object.entries(headers).map(([h, v]) => (
                    <tr key={h}>
                      <td className="k">
                        <code>{h}</code>
                      </td>
                      <td className="t mono">{typeOf(obj(obj(v).schema))}</td>
                      <td className="d">{obj(v).description ? <Inline text={str(obj(v).description)} /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        </div>
        <div className="stack ep-code">
          <div className="stack sm">
            <span className="eyebrow">curl</span>
            <Terminal code={curlFor(o)} label={`curl ${o.method.toUpperCase()} ${o.path}`} />
          </div>
          {bodyExample ? (
            <div className="stack sm">
              <span className="eyebrow">Request example</span>
              <Terminal code={bodyExample.body} label="Request body example" />
            </div>
          ) : null}
          {current ? (
            <div className="stack sm">
              <div className="row between">
                <span className="eyebrow">Response · {current[0]}</span>
                <div className="row" style={{ gap: 4 }}>
                  {mediaTypes.length > 1
                    ? mediaTypes.map((m, i) => (
                        <button key={m} className={`btn ghost sm${i === media ? ' on' : ''}`} onClick={() => setMedia(i)} aria-pressed={i === media}>
                          {m.replace('application/', '').replace('text/', '')}
                        </button>
                      ))
                    : null}
                  {mediaObj?.schema ? (
                    <>
                      <button className={`btn ghost sm${tab === 'example' ? ' on' : ''}`} onClick={() => setTab('example')} aria-pressed={tab === 'example'}>
                        Example
                      </button>
                      <button className={`btn ghost sm${tab === 'schema' ? ' on' : ''}`} onClick={() => setTab('schema')} aria-pressed={tab === 'schema'}>
                        Fields
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
              {tab === 'schema' && mediaObj?.schema ? (
                <Schema schema={obj(mediaObj.schema)} />
              ) : example ? (
                <Terminal code={example.body} label={`Response example ${current[0]}`} wrap={example.lang === 'text'} />
              ) : (
                <p className="small muted">No body{mediaKey ? ` (${mediaKey})` : ''}.</p>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

/* ---------- "Switch in a minute": for developers already on an OpenAI-compatible gateway (docs/SWITCHING.md) ---------- */

const BASE = `${PUBLIC_API_URL}/v1`;
const EXAMPLE_MODEL = 'anthropic/claude-sonnet-4.5';

const SWITCH_SNIPPETS: Record<string, { label: string; code: string; wrap?: boolean }> = {
  curl: {
    label: 'curl',
    code: `# Two edits: the host and the key. Everything else is the request you already send.
export OPENAI_BASE_URL=${BASE}
export OPENAI_API_KEY=mesh_sk_...

curl $OPENAI_BASE_URL/chat/completions \\
  -H "Authorization: Bearer $OPENAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${EXAMPLE_MODEL}",
    "messages": [{"role": "user", "content": "Hello from Mesh"}],
    "stream": false
  }'

# Same usage object; three extra response headers tell you how it was served:
#   x-mesh-route, x-mesh-privacy, x-mesh-served-by`,
  },
  python: {
    label: 'Python',
    code: `from openai import OpenAI

client = OpenAI(
    base_url="${BASE}",   # was: your old gateway's base_url
    api_key="mesh_sk_...",                 # was: your old key
)

r = client.chat.completions.create(
    model="${EXAMPLE_MODEL}",     # OpenRouter-style ids work unchanged
    messages=[{"role": "user", "content": "Hello from Mesh"}],
    # optional, the one Mesh-specific knob:
    extra_headers={"X-Mesh-Privacy": "upstream_zdr"},
)
print(r.choices[0].message.content)
print(r.usage)   # prompt_tokens, completion_tokens, total_tokens, cost`,
  },
  node: {
    label: 'Node',
    code: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${BASE}",            // was: your old gateway's baseURL
  apiKey: process.env.MESH_API_KEY,               // mesh_sk_...
  defaultHeaders: { "X-Mesh-Privacy": "trusted" } // optional
});

const r = await client.chat.completions.create({
  model: "${EXAMPLE_MODEL}",
  messages: [{ role: "user", content: "Hello from Mesh" }],
});
console.log(r.choices[0].message.content, r.usage);`,
  },
  langchain: {
    label: 'LangChain',
    code: `# Python (langchain-openai)
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="${EXAMPLE_MODEL}",
    base_url="${BASE}",
    api_key="mesh_sk_...",
    default_headers={"X-Mesh-Privacy": "upstream_zdr"},  # optional
)
print(llm.invoke("Hello from Mesh").content)

# JavaScript (@langchain/openai)
# const llm = new ChatOpenAI({
#   model: "${EXAMPLE_MODEL}",
#   apiKey: process.env.MESH_API_KEY,
#   configuration: { baseURL: "${BASE}" },
# });`,
  },
  vercel: {
    label: 'Vercel AI SDK',
    code: `import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText } from "ai";

const mesh = createOpenAICompatible({
  name: "mesh",
  baseURL: "${BASE}",
  apiKey: process.env.MESH_API_KEY, // mesh_sk_...
  headers: { "X-Mesh-Privacy": "trusted" }, // optional
});

const { text, usage } = await generateText({
  model: mesh("${EXAMPLE_MODEL}"),
  prompt: "Hello from Mesh",
});

// streaming is the same SSE your current provider sends:
const stream = streamText({ model: mesh("llama-3.1-8b"), prompt: "..." });`,
  },
  editors: {
    label: 'Cursor / Continue',
    wrap: true,
    code: `# Cursor  ->  Settings > Models
#   OpenAI API Key:            mesh_sk_...
#   Override OpenAI Base URL:  ${BASE}
#   + Add model:               ${EXAMPLE_MODEL}   (any id from GET /v1/models)
#   Turn off the OpenAI models you no longer want so Cursor only sends to Mesh.

# Continue  ->  ~/.continue/config.yaml
models:
  - name: Claude Sonnet 4.5 via Mesh
    provider: openai
    model: ${EXAMPLE_MODEL}
    apiBase: ${BASE}
    apiKey: mesh_sk_...
    requestOptions:
      headers:
        X-Mesh-Privacy: upstream_zdr   # optional
  - name: Llama 3.1 8B on the Mesh network
    provider: openai
    model: llama-3.1-8b
    apiBase: ${BASE}
    apiKey: mesh_sk_...`,
  },
};

const MESH_HEADERS: Array<[string, string]> = [
  ['x-mesh-route', 'Who answered: `node:<id>` when a Mesh node served it, else the upstream name (`openrouter`).'],
  ['x-mesh-privacy', 'The privacy tier the request ended up under: `trusted`, `network` or `upstream_zdr`.'],
  ['x-mesh-served-by', 'Human label for the chat UI: `your node`, `trusted node`, `network node` or `upstream (ZDR)`.'],
  ['x-mesh-cost-usd', 'What the request cost, in USD (non-streamed replies; streamed replies carry `usage.cost` in the final chunk).'],
  ['x-mesh-balance-usd', 'Your credit balance after the request (non-streamed replies).'],
];

/** Short alias <-> full OpenRouter id pairs for the models Mesh nodes serve, from config/model-policy.json (same Ollama tag). */
function aliasPairs(): Array<{ full: string; short: string }> {
  const nm = (modelPolicy as { networkModels: Record<string, string> }).networkModels;
  const byTag = new Map<string, { full?: string; short?: string }>();
  for (const [name, tag] of Object.entries(nm)) {
    if (name.startsWith('mesh/')) continue;
    const e = byTag.get(tag) ?? {};
    if (name.includes('/')) e.full = name;
    else e.short = name;
    byTag.set(tag, e);
  }
  return [...byTag.values()].filter((e): e is { full: string; short: string } => Boolean(e.full && e.short));
}

function priceCell(p: { promptUsdPerM: number; completionUsdPerM: number }): string {
  return p.promptUsdPerM === p.completionUsdPerM ? `${fmtCost(p.promptUsdPerM)} flat` : `${fmtCost(p.promptUsdPerM)} / ${fmtCost(p.completionUsdPerM)}`;
}

/** What upstream (frontier/fast) models cost on Mesh relative to list: the live catalogue's pricing block, else config. */
function upstreamPricingPhrase(pricing: { upstreamDiscountBps: number; upstreamMarkupBps: number }): string {
  if (pricing.upstreamDiscountBps > 0) return `list minus ${pricing.upstreamDiscountBps / 100}%`;
  if (pricing.upstreamMarkupBps > 0) return `list plus ${pricing.upstreamMarkupBps / 100}%`;
  return 'exactly list, no markup';
}

/** Upstream-only rows shown in the mapping table before "and N more". */
const MAX_UPSTREAM_ROWS = 6;

function SwitchInAMinute() {
  const [tab, setTab] = useState<keyof typeof SWITCH_SNIPPETS>('curl');
  const [cat, setCat] = useState<Catalogue | null>(null);
  useEffect(() => {
    let cancelled = false;
    getCatalogue()
      .then((c) => !cancelled && setCat(c))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const pairs = useMemo(aliasPairs, []);
  const { rows, more } = useMemo(() => {
    const byId = new Map<string, CatalogueModel>((cat?.data ?? []).map((m) => [m.id, m]));
    const seen = new Set<string>();
    const out: Array<{ theirs: string; ours: string[]; model: CatalogueModel | null; network: boolean }> = [];
    for (const p of pairs) {
      seen.add(p.full);
      seen.add(p.short);
      out.push({ theirs: p.full, ours: [p.full, p.short], model: byId.get(p.full) ?? byId.get(p.short) ?? null, network: true });
    }
    let more = 0;
    for (const m of cat?.data ?? []) {
      if (seen.has(m.id) || !m.id.includes('/') || m.served !== 'upstream') continue;
      seen.add(m.id);
      if (out.filter((r) => !r.network).length >= MAX_UPSTREAM_ROWS) {
        more += 1;
        continue;
      }
      out.push({ theirs: m.id, ours: [m.id], model: m, network: false });
    }
    return { rows: out, more };
  }, [cat, pairs]);

  const frontier = cat?.data.find((m) => m.tier === 'frontier' && m.served === 'upstream') ?? null;
  const networkPrice = cat?.pricing.networkPricePerMTokens ?? TOKENOMICS.networkPricePerMTokens;
  const upstreamPricing = cat?.pricing ?? { upstreamDiscountBps: TOKENOMICS.upstreamDiscountBps, upstreamMarkupBps: TOKENOMICS.upstreamMarkupBps };
  const starter = TOKENOMICS.starterCredits;

  return (
    <section id="switch" className="switch">
      <div className="sec-head">
        <div className="stack sm">
          <p className="eyebrow">Switch in a minute</p>
          <p className="small muted">
            Written for a developer who already uses an OpenAI-compatible endpoint. The full version is <code>docs/SWITCHING.md</code> in the repo.
          </p>
        </div>
        <div className="stack">
          <h2>
            Change two strings. <span className="muted">Keep every line of code you already have.</span>
          </h2>
          <div className="steps">
            <div className="step">
              <span className="n">01 · Base URL</span>
              <p>
                Replace your gateway's base URL with <code>{BASE}</code>. <code>/chat/completions</code> and <code>/models</code> are where your SDK expects them.
              </p>
            </div>
            <div className="step">
              <span className="n">02 · Key</span>
              <p>
                Replace the key with a <code>mesh_sk_…</code> key from <Link to="/app/keys">Keys</Link>. It goes in the same <code>Authorization: Bearer</code> header.
                {starter.enabled && starter.amountUsd > 0 ? <> Your first sign-in is credited {fmtUsd(starter.amountUsd)} so you can test before holding anything.</> : null}
              </p>
            </div>
            <div className="step">
              <span className="n">03 · Model ids</span>
              <p>
                Nothing to rename. OpenRouter-style ids like <code>{EXAMPLE_MODEL}</code> are accepted unchanged, and the open models Mesh nodes serve also answer to short aliases. <code>GET /v1/models</code> is the source of truth.
              </p>
            </div>
          </div>

          <div className="stack sm">
            <div className="tabs" role="tablist" aria-label="Client">
              {(Object.keys(SWITCH_SNIPPETS) as Array<keyof typeof SWITCH_SNIPPETS>).map((k) => (
                <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                  {SWITCH_SNIPPETS[k].label}
                </button>
              ))}
            </div>
            <Terminal code={SWITCH_SNIPPETS[tab].code} label={`${SWITCH_SNIPPETS[tab].label} switch example`} wrap={SWITCH_SNIPPETS[tab].wrap} />
          </div>

          <div className="stack sm">
            <span className="eyebrow">Model names · theirs → ours</span>
            <table className="schema" aria-label="Model id mapping">
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td className="d muted">Loading the catalogue from GET /v1/models…</td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.theirs}>
                      <td className="k">
                        <code>{r.theirs}</code>
                      </td>
                      <td className="t">→</td>
                      <td className="d">
                        {r.ours.map((o, i) => (
                          <Fragment key={o}>
                            {i > 0 ? <span className="muted"> or </span> : null}
                            <code>{o}</code>
                          </Fragment>
                        ))}
                        {r.model ? (
                          <span className="ex">
                            {r.network ? `Mesh nodes first (${r.model.online} online), upstream fallback` : 'upstream, ZDR providers only'} · {priceCell(r.model.meshPrice)} per 1M tokens
                            {r.network ? ' on a node' : ''}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))
                )}
                <tr>
                  <td className="k">
                    <code>anything else</code>
                  </td>
                  <td className="t">→</td>
                  <td className="d">
                    {more > 0 ? `${more} more curated upstream models, and anything else, are forwarded` : 'Forwarded'} to the upstream unchanged, if the model policy allows it. The list is <code>GET {BASE}/models</code>; each row carries <code>served</code>, <code>listPrice</code>, <code>meshPrice</code> and <code>privacy</code>.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="stack sm">
            <span className="eyebrow">What is identical · what is added · the one difference</span>
            <ul>
              <li>
                <b>Identical:</b> request body, <code>stream: true</code> SSE chunks and <code>[DONE]</code>, the <code>usage</code> object (<code>prompt_tokens</code>, <code>completion_tokens</code>, <code>total_tokens</code>) plus <code>usage.cost</code> in USD like OpenRouter, OpenAI-shaped errors (<code>402 insufficient_quota</code> when you are out of credits, <code>429</code> on the per-key rate limit).
              </li>
              <li>
                <b>Added:</b> response headers that say how the request was served. Ignore them or log them.
              </li>
              <li>
                <b>The one difference:</b> an optional <code>X-Mesh-Privacy</code> request header (<code>trusted</code> | <code>network</code> | <code>upstream_zdr</code>) picks which machines may see the prompt. Leave it out and the key's default applies (<code>trusted</code>). Also accepted as <code>mesh.privacy</code> in the body. See <Link to="/docs#privacy">Privacy tiers</Link>.
              </li>
            </ul>
            <table className="schema" aria-label="Headers Mesh adds">
              <tbody>
                {MESH_HEADERS.map(([h, d]) => (
                  <tr key={h}>
                    <td className="k">
                      <code>{h}</code>
                    </td>
                    <td className="d">
                      <Inline text={d} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="stack sm">
            <span className="eyebrow">What changes on your bill</span>
            <p>
              Two prices, both read from the catalogue. Models served by Mesh nodes (the open models above) bill a flat {fmtCost(networkPrice)} per million tokens,
              prompt and reply together, whatever the model. Frontier and fast models go to the upstream and bill {upstreamPricingPhrase(upstreamPricing)}
              {frontier ? (
                <>
                  : {frontier.displayName} lists at {fmtCost(frontier.listPrice.promptUsdPerM)} in / {fmtCost(frontier.listPrice.completionUsdPerM)} out per 1M and costs{' '}
                  {fmtCost(frontier.meshPrice.promptUsdPerM)} / {fmtCost(frontier.meshPrice.completionUsdPerM)} here
                </>
              ) : null}
              . Credits are US dollars, so one credit dollar buys one dollar of inference; every reply says what it cost and, on a node, what it saved versus list.
              {starter.enabled && starter.amountUsd > 0 ? <> The first {fmtUsd(starter.amountUsd)} is on us when you connect a wallet for the first time.</> : null}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function ApiDocs() {
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (el) el.scrollIntoView({ block: 'start' });
  }, [hash]);

  const groups = useMemo(() => {
    const tags = arr<Json>(spec.tags);
    const byTag = new Map<string, Operation[]>();
    for (const t of tags) byTag.set(str(t.name), []);
    for (const [path, item] of Object.entries(obj(spec.paths))) {
      const it = obj(item);
      for (const method of METHOD_ORDER) {
        const op = obj(it[method]);
        if (!Object.keys(op).length) continue;
        const tag = arr<string>(op.tags)[0] ?? 'Other';
        if (!byTag.has(tag)) byTag.set(tag, []);
        const id = str(op.operationId) || `${method}-${path.replace(/[^a-z0-9]+/gi, '-')}`;
        byTag.get(tag)!.push({ method, path, op: { ...op, parameters: [...arr(it.parameters), ...arr(op.parameters)] }, id });
      }
    }
    return [...byTag.entries()]
      .filter(([, ops]) => ops.length)
      .map(([name, ops]) => ({ name, description: str(tags.find((t) => t.name === name)?.description), ops }));
  }, []);

  const info = obj(spec.info);
  const schemes = obj(obj(spec.components).securitySchemes);

  return (
    <div className="wrap docs apidocs">
      <section className="hero" style={{ paddingBlock: '32px 0' }}>
        <p className="eyebrow">API · OpenAPI {str(spec.openapi)} · v{str(info.version)}</p>
        <h1 className="display d-xl" style={{ fontSize: 'clamp(40px,7vw,88px)' }}>
          Every endpoint.
          <br />
          One page.
        </h1>
        <p className="lede" style={{ textAlign: 'center' }}>
          {str(info.summary)} <span className="dim">Base URL {PUBLIC_API_URL}. The same document is served at /openapi.json.</span>
        </p>
        <div className="chips">
          <a className="chip on" href="#switch">
            Switch in a minute
          </a>
          {groups.map((g) => (
            <a key={g.name} className="chip" href={`#tag-${g.name.toLowerCase()}`}>
              {g.name}
            </a>
          ))}
          <a className="chip" href={`${PUBLIC_API_URL}/openapi.json`}>
            openapi.json
          </a>
        </div>
      </section>

      <SwitchInAMinute />

      <section id="overview">
        <div className="sec-head">
          <p className="eyebrow">Overview</p>
          <div className="stack">
            <h2>
              Three kinds of bearer. <span className="muted">Public routes need none.</span>
            </h2>
            <Md text={str(info.description)} />
            <div className="rows">
              {Object.entries(schemes).map(([name, s]) => (
                <div className="bigrow" key={name}>
                  <span className="display d-s">{AUTH_LABEL[name] ?? name}</span>
                  <p className="desc">
                    <Inline text={str(obj(s).description)} />
                  </p>
                  <code>{AUTH_HEADER[name]}</code>
                </div>
              ))}
            </div>
            <p className="small muted">
              Looking for a walkthrough instead? The <Link to="/docs">Docs</Link> page covers credits, keys and running a node in prose, with
              Python and JavaScript snippets.
            </p>
          </div>
        </div>
      </section>

      {groups.map((g) => (
        <section key={g.name} id={`tag-${g.name.toLowerCase()}`}>
          <div className="sec-head">
            <div className="stack sm tagnav">
              <p className="eyebrow">{g.name}</p>
              <ul className="plain toc">
                {g.ops.map((o) => (
                  <li key={o.id}>
                    <a href={`#${o.id}`}>
                      <span className={`method ${o.method}`}>{o.method.toUpperCase()}</span> <span className="mono">{o.path}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div className="stack">
              {g.description ? <h2>{g.description}</h2> : null}
              <div className="eps">
                {g.ops.map((o) => (
                  <Endpoint key={o.id} o={o} />
                ))}
              </div>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
