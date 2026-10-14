// The GitHub files can't run on this computer, so check what we can before they reach GitHub:
// they are valid YAML, and the Action only uses inputs it declares.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const read = (f: string) => parse(readFileSync(f, 'utf8'));

test('every GitHub file is valid YAML', () => {
  for (const f of ['action.yml', '.github/workflows/selftest.yml', 'examples/qamcp-ci.yml']) assert.doesNotThrow(() => read(f), f);
});

test('the Action only reads inputs it declares, and every input it declares is used', () => {
  const text = readFileSync('action.yml', 'utf8');
  const declared = Object.keys(read('action.yml').inputs);
  // both `${{ inputs.x }}` and the bare `inputs.x` used inside an `if:` condition
  const used = [...text.matchAll(/\binputs\.([\w-]+)/g)].map((m) => m[1]);
  for (const u of used) assert.ok(declared.includes(u), `uses undeclared input "${u}"`);
  for (const d of declared) assert.ok(used.includes(d), `declares "${d}" but never uses it`);
});

test('the Action has the outputs the workflows rely on, and a description on everything', () => {
  const a = read('action.yml');
  for (const o of ['score', 'gate', 'tools-changed']) assert.ok(a.outputs[o], o);
  for (const [k, v] of Object.entries<any>(a.inputs)) assert.ok(typeof v.description === 'string' && v.description.length > 5, k);
});

test('the daily job and the self-test only use actions with a pinned major version', () => {
  for (const f of ['.github/workflows/selftest.yml', 'examples/qamcp-ci.yml', 'action.yml']) {
    for (const m of readFileSync(f, 'utf8').matchAll(/uses:\s*([\w./-]+)@([\w.-]+)/g)) {
      if (m[1] === 'YOUR-ORG/QAmcp') continue;
      assert.match(m[2], /^v\d+$/, `${f}: ${m[1]}@${m[2]}`);
    }
  }
});
