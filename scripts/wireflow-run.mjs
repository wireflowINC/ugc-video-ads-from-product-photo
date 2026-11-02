#!/usr/bin/env node
// wireflow-run.mjs: run YOUR Wireflow workflow (or YOUR published app) from code, wait for it, download the files.
//
// Node 18 or newer, built-in fetch, no packages. The API key is read from the WIREFLOW_API_KEY environment
// variable and is never printed or written to disk. Create a key in Wireflow under Settings > API Keys.
//
//   node scripts/wireflow-run.mjs --workflow <workflow-id> --describe
//   node scripts/wireflow-run.mjs --workflow <workflow-id> --input prompt="a ceramic mug on a wooden table"
//   node scripts/wireflow-run.mjs --workflow <workflow-id> --input product-photo=@./mug.jpg --input scene="on marble"
//   node scripts/wireflow-run.mjs --app <your-app-slug> --input prompt="a ceramic mug on a wooden table"
//
// Options
//   --input <id>=<value>     one input; repeat it. A value that starts with @ is a local file: it is uploaded to
//                            the Wireflow CDN first and its URL is sent (needs the workflows:write scope).
//   --inputs <file.json>     inputs as a JSON object, merged under any --input values
//   --describe               print the inputs the workflow or app takes, then stop (spends nothing)
//   --out <dir>              where files go (default ./wireflow-outputs/<YYYY-MM-DD>)
//   --timeout <minutes>      stop waiting after this long (default 20; video can take 5+ minutes)
//   --idempotency-key <key>  workflow runs only: retrying with the same key replays the first run instead of
//                            billing a second one (POST /workflows/{id}/run). A random key is used if you omit it;
//                            it is printed before the run starts and repeated in any error from the start call.
//   --webhook <https-url>    workflow runs only: Wireflow also POSTs the result there when the run ends
//   --webhook-secret <s>     signs that POST (X-Wireflow-Signature, HMAC-SHA256 of the raw body)
//   --any-host               also download output URLs that are not on a wireflow.ai host
//   --poll <execution-id>    resume waiting for a run you already started (with --workflow or --app), then download
//
// Scopes: a workflow run needs workflows:execute and executions:read, an app run needs apps:execute, and a
// local @file upload needs workflows:write (or one Full access key).
//
// Endpoints used (https://www.wireflow.ai/docs/api/run, /docs/api/apps, /docs/api/media):
//   GET  /api/v1/workflows/{id}/run                  input schema (free)
//   POST /api/v1/workflows/{id}/run                  start a run of a workflow you own
//   GET  /api/v1/workflows/executions/{id}/poll      status and outputs
//   GET  /api/v1/apps/{slug}                         app input keys (free)
//   POST /api/v1/apps/{slug}/execute                 start an app run
//   GET  /api/v1/apps/{slug}/executions/{id}/poll    status and outputs
//   POST /api/v1/media/upload, /media/upload-url     local file to CDN URL

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const HOST = 'https://www.wireflow.ai';
export const API = `${HOST}/api/v1`;
const FINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

function apiKey() {
  const k = (process.env.WIREFLOW_API_KEY || '').trim();
  if (!k) throw new Error('Set WIREFLOW_API_KEY first (Wireflow > Settings > API Keys). The key is read from the environment only.');
  return k;
}

// The full URL for an API path. The key is only ever sent to the Wireflow API origin: an absolute URL on any
// other host (or any non-https URL) is refused before a request is made.
function apiUrl(p) {
  const u = new URL(/^https?:\/\//i.test(p) ? p : (p.startsWith('/api/') ? HOST + p : API + p));
  if (u.origin !== HOST || !u.pathname.startsWith('/api/')) throw new Error(`refusing to send the API key to ${u.origin}${u.pathname}: only ${HOST}/api/ is allowed`);
  return u.href;
}

// One API call. Retries 429 by Retry-After. Returns { status, json, headers }.
export async function call(method, p, { body, headers = {}, form } = {}) {
  const key = apiKey();
  const url = apiUrl(p);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(form ? {} : body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: form || (body === undefined ? undefined : JSON.stringify(body)),
    });
    if (res.status === 429 && attempt < 8) {
      const wait = Number(res.headers.get('retry-after')) || 5;
      console.error(`429 rate limited, waiting ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    const text = await res.text();
    if (text.includes(key)) throw new Error('response contained the API key; refusing to continue');
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
    return { status: res.status, json, headers: res.headers };
  }
}

function explain(r) {
  const j = r.json || {};
  const e = j.error;
  let msg = typeof e === 'string' ? e : e && (e.message || e.code) ? `${e.code ? e.code + ': ' : ''}${e.message || ''}` : JSON.stringify(j).slice(0, 400);
  if (r.status === 402) {
    msg += j.requiredCredits != null ? ` (required ${j.requiredCredits}, available ${j.availableCredits})` : '';
    if (Array.isArray(j.breakdown)) msg += '\n  ' + j.breakdown.map((b) => `${b.nodeLabel || b.nodeId}: ${b.credits} credits`).join('\n  ');
  }
  if (j.validKeys) msg += `\n  valid input keys: ${j.validKeys.join(', ')}`;
  return `HTTP ${r.status}: ${msg}`;
}

// ------------------------------------------------------------------ uploads (local file -> cdn.wireflow.ai URL)
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4' };

export async function upload(file) {
  const abs = path.resolve(file);
  const bytes = fs.readFileSync(abs);
  const contentType = TYPES[path.extname(abs).toLowerCase()];
  if (!contentType) throw new Error(`${file}: upload takes jpg, png, gif, webp, avif, mp4, webm, mov, mp3, wav or m4a`);
  const filename = path.basename(abs);
  if (bytes.length <= 4 * 1024 * 1024) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: contentType }), filename);
    const r = await call('POST', '/media/upload', { form });
    const m = r.json.data || r.json; // the live reply wraps the media in data (3 Nov 2026); the docs show it bare
    if (r.status >= 300 || !m.url) throw new Error(`upload of ${filename} failed, ${explain(r)}`);
    return m.url;
  }
  // Over 4 MB: ask for a signed URL, PUT the bytes with exactly the given headers, then complete.
  const a = await call('POST', '/media/upload-url', { body: { contentType, bytes: bytes.length, filename } });
  const signed = a.json.data || a.json;
  if (a.status >= 300 || !signed.uploadUrl) throw new Error(`upload-url for ${filename} failed, ${explain(a)}`);
  const put = await fetch(signed.uploadUrl, { method: signed.method || 'PUT', headers: signed.headers, body: bytes });
  if (!put.ok) throw new Error(`PUT of ${filename} failed: ${put.status} ${(await put.text()).slice(0, 200)}`);
  const c = await call('POST', '/media/upload-url/complete', { body: { mediaId: signed.mediaId } });
  const done = c.json.data || c.json;
  if (c.status >= 300 || !done.url) throw new Error(`upload complete for ${filename} failed, ${explain(c)}`);
  return done.url;
}

// Replace every "@./local/file" value with its uploaded URL. The cache avoids uploading one file twice.
export async function resolveInputs(inputs, cache = new Map()) {
  const out = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (typeof v === 'string' && v.startsWith('@')) {
      const f = v.slice(1);
      // Cache the promise, so rows running at the same time share one upload of the same file.
      if (!cache.has(f)) cache.set(f, upload(f).then((u) => { console.error(`uploaded ${f} -> ${u}`); return u; }));
      out[k] = await cache.get(f);
    } else out[k] = v;
  }
  return out;
}

// ------------------------------------------------------------------ describe
export async function describe({ workflow, app }) {
  if (workflow) {
    const r = await call('GET', `/workflows/${encodeURIComponent(workflow)}/run`);
    if (r.status !== 200) throw new Error(explain(r));
    const d = r.json.data || r.json;
    return { name: d.workflowName, inputs: (d.inputs || []).map((i) => ({ id: i.nodeId, key: i.key, label: i.label, type: i.type, required: i.required, default: i.default })), example: d.example };
  }
  const r = await call('GET', `/apps/${encodeURIComponent(app)}`);
  if (r.status !== 200) throw new Error(explain(r));
  return { name: r.json.title, inputs: (r.json.inputs || []).map((i) => ({ id: i.key, nodeId: i.nodeId, label: i.label, type: i.type })) };
}

// ------------------------------------------------------------------ outputs
// Every https URL in a node's output, wherever it sits (url, urls, images, video ...).
function collectUrls(v, found = []) {
  if (typeof v === 'string') { if (/^https:\/\/\S+$/.test(v)) found.push(v); }
  else if (Array.isArray(v)) v.forEach((x) => collectUrls(x, found));
  else if (v && typeof v === 'object') for (const x of Object.values(v)) collectUrls(x, found);
  return found;
}

function outputsOf(poll, mode) {
  const items = [];
  if (mode === 'workflow') {
    const runs = poll.result?.nodeRuns || poll.data?.result?.nodeRuns;
    if (Array.isArray(runs)) {
      // The poll may also list the graph's nodes with their type (optional field): use it to skip helper nodes.
      const typeOf = new Map((poll.nodes || []).map((x) => [x.id, x.data?.nodeType || '']));
      for (const n of runs) {
        // An input node (it received nothing) only echoes what you sent or saved, so it is not an output.
        if (String(typeOf.get(n.nodeId) || '').startsWith('input:')) continue;
        if (n.input && typeof n.input === 'object' && !Object.keys(n.input).length) continue;
        let text = typeof n.output?.text === 'string' && !String(typeOf.get(n.nodeId) || '').startsWith('utility:') ? n.output.text : null;
        if (text && /^".*"$/s.test(text)) { try { text = JSON.parse(text); } catch { /* keep as is */ } }
        items.push({ nodeId: n.nodeId, urls: [...new Set(collectUrls(n.output))], text });
      }
      return items;
    }
  }
  for (const o of poll.outputs || poll.data?.outputs || []) {
    if (typeof o === 'string') items.push({ nodeId: 'output', urls: [o], text: null });
    else items.push({ nodeId: o.nodeId || 'output', urls: [...new Set(o.urls || (o.url ? [o.url] : []))], text: typeof o.text === 'string' ? o.text : null });
  }
  return items;
}

const okHost = (u, anyHost) => { try { const h = new URL(u).hostname; return anyHost || h === 'wireflow.ai' || h.endsWith('.wireflow.ai'); } catch { return false; } };
const safeName = (s) => String(s).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);

async function download(items, dir, anyHost) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [], skipped = [], texts = {};
  for (const it of items) {
    if (it.text && !it.urls.length) texts[it.nodeId] = it.text;
    for (const [i, u] of it.urls.entries()) {
      if (!okHost(u, anyHost)) { skipped.push(u); continue; }
      const ext = path.extname(new URL(u).pathname).slice(0, 6) || '.bin';
      const f = path.join(dir, `${safeName(it.nodeId)}-${i}${ext}`);
      const res = await fetch(u);
      if (!res.ok) { skipped.push(`${u} (HTTP ${res.status})`); continue; }
      fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
      files.push({ nodeId: it.nodeId, url: u, file: f });
    }
  }
  return { files, skipped, texts };
}

// ------------------------------------------------------------------ one run, start to files
export async function runOnce({ workflow, app, inputs = {}, out, timeoutMin = 20, idempotencyKey, webhook, webhookSecret, metadata, anyHost = false, quiet = false, uploadCache } = {}) {
  if (!workflow === !app) throw new Error('pass exactly one of --workflow <id> or --app <slug>');
  const log = (...a) => { if (!quiet) console.error(...a); };
  const sent = await resolveInputs(inputs, uploadCache);
  const startedAt = new Date().toISOString();
  let executionId, pollPath;
  if (workflow) {
    const key = idempotencyKey || crypto.randomUUID();
    const body = { inputs: sent };
    if (webhook) body.webhook = { url: webhook, ...(webhookSecret ? { secret: webhookSecret } : {}) };
    if (metadata) body.metadata = metadata;
    // Printed before the POST: if the call times out or fails, the run may still have started, and retrying with
    // this same key replays it instead of billing a second run.
    const retry = `retry with --idempotency-key ${key} to replay the run instead of billing it twice`;
    log(`Idempotency-Key ${key}`);
    let r;
    try { r = await call('POST', `/workflows/${encodeURIComponent(workflow)}/run`, { body, headers: { 'Idempotency-Key': key } }); }
    catch (e) { throw new Error(`${e.message} (the run may have started: ${retry})`); }
    if (r.status !== 202 && r.status !== 200) throw new Error(`${explain(r)}${r.status >= 500 ? ` (the run may have started: ${retry})` : ` (Idempotency-Key ${key})`}`);
    executionId = r.json.data?.executionId;
    pollPath = r.json.data?.poll || `/api/v1/workflows/executions/${executionId}/poll`;
    log(`started run ${executionId} (Idempotency-Key ${key}: ${retry})`);
  } else {
    const r = await call('POST', `/apps/${encodeURIComponent(app)}/execute`, { body: { inputs: sent } });
    if (r.status !== 200 && r.status !== 202) throw new Error(explain(r));
    executionId = r.json.executionId;
    pollPath = r.json.pollUrl || `/api/v1/apps/${encodeURIComponent(app)}/executions/${executionId}/poll`;
    log(`started app run ${executionId}`);
  }
  if (!executionId) throw new Error('the start call returned no execution id');
  return waitAndSave({ workflow, app, executionId, pollPath, out, timeoutMin, anyHost, quiet, inputs: sent, startedAt });
}

// Wait for a run that has started (or resume waiting with --poll <executionId>), then save its files.
export async function waitAndSave({ workflow, app, executionId, pollPath, out, timeoutMin = 20, anyHost = false, quiet = false, inputs = null, startedAt = null }) {
  const log = (...a) => { if (!quiet) console.error(...a); };
  pollPath = pollPath || (workflow ? `/api/v1/workflows/executions/${encodeURIComponent(executionId)}/poll` : `/api/v1/apps/${encodeURIComponent(app)}/executions/${encodeURIComponent(executionId)}/poll`);
  const resume = `the run itself carries on; resume with --${workflow ? `workflow ${workflow}` : `app ${app}`} --poll ${executionId}`;
  const deadline = Date.now() + timeoutMin * 60 * 1000;
  let delay = 2000, poll, status = 'RUNNING', last = '';
  while (Date.now() < deadline) {
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.5), 10000);
    let r;
    try { r = await call('GET', pollPath); }
    catch (e) { throw new Error(`poll failed: ${e.message} (${resume})`); }
    if (r.status >= 500) throw new Error(`poll failed, ${explain(r)} (${resume})`);
    if (r.status !== 200) throw new Error(`poll failed, ${explain(r)}`);
    poll = r.json;
    status = String(poll.status || poll.data?.status || '').toUpperCase();
    if (status !== last) { log(`status ${status}`); last = status; }
    if (FINAL.has(status)) break;
  }
  if (!FINAL.has(status)) throw new Error(`still ${status} after ${timeoutMin} minutes. Nothing is lost: resume with --${workflow ? `workflow ${workflow}` : `app ${app}`} --poll ${executionId}`);

  const dir = path.resolve(out || path.join('wireflow-outputs', today()), safeName(executionId));
  const items = status === 'COMPLETED' ? outputsOf(poll, workflow ? 'workflow' : 'app') : [];
  const { files, skipped, texts } = await download(items, dir, anyHost);
  const error = poll.error || poll.data?.error || null;
  const manifest = {
    executionId, target: workflow ? { workflow } : { app }, status, startedAt, finishedAt: new Date().toISOString(),
    inputs, files: files.map((f) => ({ nodeId: f.nodeId, url: f.url || null, file: path.basename(f.file) })),
    texts, skippedUrls: skipped, error: typeof error === 'string' ? error : error ? JSON.stringify(error) : null,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { ...manifest, dir };
}

// ------------------------------------------------------------------ CLI
function parseArgs(argv) {
  const a = { inputs: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${t} needs a value`); return v; };
    if (t === '--workflow') a.workflow = next();
    else if (t === '--app') a.app = next();
    else if (t === '--input') { const v = next(); const eq = v.indexOf('='); if (eq < 1) throw new Error(`--input wants id=value, got "${v}"`); a.inputs[v.slice(0, eq)] = v.slice(eq + 1); }
    else if (t === '--inputs') a.inputsFile = next();
    else if (t === '--describe') a.describe = true;
    else if (t === '--out') a.out = next();
    else if (t === '--timeout') { const v = next(); a.timeout = Number(v); if (!Number.isFinite(a.timeout) || a.timeout <= 0) throw new Error(`--timeout wants a number of minutes above 0, got "${v}"`); }
    else if (t === '--idempotency-key') a.idem = next();
    else if (t === '--webhook') a.webhook = next();
    else if (t === '--webhook-secret') a.webhookSecret = next();
    else if (t === '--any-host') a.anyHost = true;
    else if (t === '--poll') a.poll = next();
    else if (t === '--help' || t === '-h') a.help = true;
    else throw new Error(`unknown option ${t} (try --help)`);
  }
  if (a.inputsFile) a.inputs = { ...JSON.parse(fs.readFileSync(a.inputsFile, 'utf8')), ...a.inputs };
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || (!a.workflow && !a.app)) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return;
  }
  if (a.describe) {
    const d = await describe(a);
    console.log(`${d.name || ''}\n`);
    for (const i of d.inputs) console.log(`  --input ${i.id}=...   ${i.label || ''} (${i.type}${i.required ? ', required' : ''}${i.default !== undefined ? `, default ${JSON.stringify(String(i.default).slice(0, 60))}` : ''})`);
    if (!d.inputs.length) console.log('  no exposed inputs: run it without --input to use the saved values');
    return;
  }
  const r = a.poll
    ? await waitAndSave({ workflow: a.workflow, app: a.app, executionId: a.poll, out: a.out, timeoutMin: a.timeout || 20, anyHost: a.anyHost })
    : await runOnce({ workflow: a.workflow, app: a.app, inputs: a.inputs, out: a.out, timeoutMin: a.timeout || 20, idempotencyKey: a.idem, webhook: a.webhook, webhookSecret: a.webhookSecret, anyHost: a.anyHost });
  console.log(`${r.status}  ${r.executionId}`);
  for (const f of r.files) console.log(`  saved ${path.join(r.dir, f.file)}`);
  for (const [id, t] of Object.entries(r.texts || {})) console.log(`  text from ${id}: ${t.length > 160 ? t.slice(0, 157) + '...' : t}`);
  for (const u of r.skippedUrls) console.log(`  not downloaded (not a wireflow.ai host, use --any-host): ${u}`);
  console.log(`  manifest ${path.join(r.dir, 'manifest.json')}`);
  if (r.error) console.log(`  error: ${r.error}`);
  if (r.status !== 'COMPLETED') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`wireflow-run: ${e.message}`); process.exitCode = 1; });
}
