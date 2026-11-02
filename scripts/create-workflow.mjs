#!/usr/bin/env node
// create-workflow.mjs: save one of this repo's workflow files as a private workflow in YOUR Wireflow account.
//
//   node scripts/create-workflow.mjs workflows/<file>.json
//
// It checks the graph first with POST /api/v1/workflows/lint (free, saves nothing), then creates it with
// POST /api/v1/workflows (free, runs nothing) and prints the new workflow id plus the command that runs it.
// Creating spends no credits; only a run does. Needs a key with the workflows:write scope (or Full access),
// read from the WIREFLOW_API_KEY environment variable. Docs: https://www.wireflow.ai/docs/api/workflows
// The new workflow is listed in your Wireflow account, where you can open it on the canvas, change a value and run it.

import fs from 'node:fs';
import { call, describe } from './wireflow-run.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/create-workflow.mjs workflows/<file>.json'); process.exit(1); }
const wfJson = JSON.parse(fs.readFileSync(file, 'utf8'));
const { name, description, nodes, edges, tags } = wfJson;
if (!name || !Array.isArray(nodes) || !Array.isArray(edges)) { console.error(`${file}: needs name, nodes and edges`); process.exit(1); }

try {
  const lint = await call('POST', '/workflows/lint', { body: { nodes, edges } });
  const verdict = lint.json.data || lint.json;
  if (lint.status !== 200 || verdict.ok === false) {
    console.error(`lint refused the graph (HTTP ${lint.status}):`, JSON.stringify(verdict.violations || verdict).slice(0, 1500));
    process.exit(1);
  }
  const created = await call('POST', '/workflows', { body: { name, description, nodes, edges, tags } });
  const id = created.json.data?.id || created.json.id;
  if (created.status >= 300 || !id) { console.error(`create failed (HTTP ${created.status}):`, JSON.stringify(created.json).slice(0, 800)); process.exit(1); }
  const warn = created.json.meta?.warnings || [];
  if (warn.length) console.error('warnings:', JSON.stringify(warn).slice(0, 600));
  console.log(`created "${name}"  workflow id: ${id}`);
  const d = await describe({ workflow: id });
  const req = d.inputs.filter((i) => i.required);
  console.log('\nrun it:');
  console.log(`  node scripts/wireflow-run.mjs --workflow ${id} ${(req.length ? req : d.inputs.slice(0, 1)).map((i) => `--input ${i.id}=${i.type === 'image' ? '@./photo.jpg' : '"..."'}`).join(' ')}`);
  console.log('\ninputs (any input you leave out runs with the value saved in the workflow):');
  for (const i of d.inputs) console.log(`  ${i.id}  ${i.label || ''} (${i.type}${i.required ? ', required' : ''})`);
} catch (e) {
  console.error(`create-workflow: ${e.message}`);
  process.exit(1);
}
