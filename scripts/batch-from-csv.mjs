#!/usr/bin/env node
// batch-from-csv.mjs: run YOUR Wireflow workflow once per row of a CSV file and save every row's files.
//
//   node scripts/batch-from-csv.mjs --workflow <workflow-id> --csv products.csv --dry-run
//   node scripts/batch-from-csv.mjs --workflow <workflow-id> --csv products.csv --input brand-look="warm, calm, oak"
//
// The CSV header names the inputs: each column is a workflow input id (see: wireflow-run.mjs --describe), except
// the "id" column, which names the row (its folder and its retry key). A value that starts with @ is a local file
// (for example @./photos/mug.jpg); it is uploaded once and its URL is sent. --input values go to every row.
//
// Options
//   --dry-run            check the columns against the workflow's inputs and print each row, then stop (spends nothing)
//   --concurrency <n>    rows running at once (default 2)
//   --key-prefix <text>  each row's Idempotency-Key is <prefix>-<id>-<fingerprint>, where the fingerprint covers the
//                        workflow id and the row's inputs (local files by their bytes). Rerun the same CSV and rows that
//                        already started are replayed, not billed again; change a row and it runs as new.
//                        (default prefix: the CSV file name). Use --fresh to start every row as a new run.
//   --out <dir>          default ./wireflow-outputs/<YYYY-MM-DD>/<csv name>
//   --timeout <minutes>  per row (default 20)
// Writes results.csv (id, status, executionId, files, error) next to the row folders.
// Each row is its own run on POST /api/v1/workflows/{id}/run, billed at the workflow's per-node prices.
// The API docs describe no bulk endpoint and no batch discount (https://www.wireflow.ai/docs/trigger-a-workflow-from-your-app).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runOnce, describe } from './wireflow-run.mjs';

// Small CSV reader: commas, quoted fields with "" escapes, CRLF or LF.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  const cols = head.map((h) => h.replace(/^﻿/, '').trim());
  return body.map((r) => Object.fromEntries(cols.map((c, i) => [c, (r[i] ?? '').trim()])));
}

// Same workflow + same inputs (a local file counts by its bytes) = same fingerprint = same retry key.
export function rowFingerprint(workflow, inputs) {
  const h = crypto.createHash('sha256').update(String(workflow));
  for (const k of Object.keys(inputs).sort()) {
    const v = String(inputs[k]);
    h.update(`\n${k}=`);
    if (v.startsWith('@')) h.update(crypto.createHash('sha256').update(fs.readFileSync(v.slice(1))).digest('hex'));
    else h.update(v);
  }
  return h.digest('hex').slice(0, 12);
}

const csvCell = (v) =>(/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);

function parseArgs(argv) {
  const a = { inputs: {}, concurrency: 2, timeout: 20 };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${t} needs a value`); return v; };
    if (t === '--workflow') a.workflow = next();
    else if (t === '--csv') a.csv = next();
    else if (t === '--input') { const v = next(); const eq = v.indexOf('='); if (eq < 1) throw new Error(`--input wants id=value, got "${v}"`); a.inputs[v.slice(0, eq)] = v.slice(eq + 1); }
    else if (t === '--dry-run') a.dry = true;
    else if (t === '--fresh') a.fresh = true;
    else if (t === '--concurrency') a.concurrency = Math.max(1, Math.min(5, Number(next()) || 2));
    else if (t === '--key-prefix') a.prefix = next();
    else if (t === '--out') a.out = next();
    else if (t === '--timeout') { const v = next(); a.timeout = Number(v); if (!Number.isFinite(a.timeout) || a.timeout <= 0) throw new Error(`--timeout wants a number of minutes above 0, got "${v}"`); }
    else throw new Error(`unknown option ${t}`);
  }
  if (!a.workflow || !a.csv) throw new Error('usage: node scripts/batch-from-csv.mjs --workflow <id> --csv <file.csv> [--dry-run]');
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const rows = parseCsv(fs.readFileSync(a.csv, 'utf8'));
  if (!rows.length) throw new Error(`${a.csv} has no data rows`);
  const csvName = path.basename(a.csv, path.extname(a.csv));
  const prefix = a.prefix || safe(csvName);
  const out = path.resolve(a.out || path.join('wireflow-outputs', new Date().toISOString().slice(0, 10), safe(csvName)));

  // Check the columns against the workflow's real inputs (free).
  const d = await describe({ workflow: a.workflow });
  const known = new Set(d.inputs.map((i) => i.id));
  const cols = Object.keys(rows[0]).filter((c) => c !== 'id');
  const unknown = [...cols, ...Object.keys(a.inputs)].filter((c) => !known.has(c));
  if (unknown.length) throw new Error(`not inputs of this workflow: ${unknown.join(', ')}. Its inputs: ${[...known].join(', ')}`);
  const ids = rows.map((r, i) => safe(r.id || `row-${i + 1}`));
  if (new Set(ids).size !== ids.length) throw new Error('the id column has duplicates; every row needs its own id');

  const rowInputs = rows.map((r) => ({ ...a.inputs, ...Object.fromEntries(cols.filter((c) => r[c] !== '').map((c) => [c, r[c]])) }));
  const run = a.fresh ? `-${crypto.randomUUID().slice(0, 8)}` : '';
  const keys = rowInputs.map((inp, i) => `${prefix}-${ids[i]}-${rowFingerprint(a.workflow, inp)}${run}`.slice(0, 255));

  console.log(`${rows.length} rows, ${a.concurrency} at a time, workflow "${d.name}"`);
  if (a.dry) {
    rows.forEach((r, i) => console.log(`  ${ids[i]} (key ${keys[i]}): ${JSON.stringify(rowInputs[i])}`));
    console.log('dry run: nothing was started. Each row bills its own run at the per-node prices (see the model list at https://www.wireflow.ai/api/v1/models).');
    return;
  }

  const uploadCache = new Map();
  const results = new Array(rows.length);
  let nextRow = 0;
  async function worker() {
    while (nextRow < rows.length) {
      const i = nextRow++;
      const inputs = rowInputs[i];
      try {
        const r = await runOnce({ workflow: a.workflow, inputs, out: path.join(out, ids[i]), timeoutMin: a.timeout, idempotencyKey: keys[i], uploadCache, quiet: true });
        results[i] = { id: ids[i], status: r.status, executionId: r.executionId, files: r.files.map((f) => path.relative(out, path.join(r.dir, f.file))).join(' '), error: r.error || '' };
      } catch (e) {
        results[i] = { id: ids[i], status: 'ERROR', executionId: '', files: '', error: e.message };
      }
      console.log(`  ${results[i].id}: ${results[i].status} ${results[i].executionId}${results[i].error ? ' ' + results[i].error : ''}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(a.concurrency, rows.length) }, worker));
  fs.mkdirSync(out, { recursive: true });
  const head = ['id', 'status', 'executionId', 'files', 'error'];
  fs.writeFileSync(path.join(out, 'results.csv'), [head.join(','), ...results.map((r) => head.map((h) => csvCell(r[h])).join(','))].join('\n') + '\n');
  const ok = results.filter((r) => r.status === 'COMPLETED').length;
  console.log(`${ok} of ${rows.length} rows completed. results: ${path.join(out, 'results.csv')}`);
  if (ok !== rows.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`batch-from-csv: ${e.message}`); process.exitCode = 1; });
}
