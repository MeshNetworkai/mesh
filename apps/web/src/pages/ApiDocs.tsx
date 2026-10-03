import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { parse } from 'yaml';
import { Terminal } from '../components/ui';
import { PUBLIC_API_URL } from '../config';
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
