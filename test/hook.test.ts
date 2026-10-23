// `--install-hook`: a pre-commit check that tests the right server, and never wrecks an existing hook.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hookBlock, installHook, shQuote, withHook } from '../src/hook.js';

test('hook: tests the server you named, with your pass mark, passed exactly as typed', () => {
  const b = hookBlock({ stdio: "node server.js --name 'x y'", failUnder: 85 });
  assert.match(b, /npx -y qamcp-cli --stdio 'node server\.js --name '\\''x y'\\''' --fail-under 85/);
  assert.match(b, /git commit --no-verify/);
  assert.match(hookBlock({ url: 'http://localhost:3000/mcp', failUnder: 80 }), /npx -y qamcp-cli 'http:\/\/localhost:3000\/mcp' --fail-under 80/);
  assert.equal(shQuote("a'b"), `'a'\\''b'`);
});

test('hook: a new hook file, an existing hook kept, and installing twice replaces only our part', () => {
  const block = hookBlock({ stdio: 'npm start', failUnder: 80 });
  const fresh = withHook(undefined, block);
  assert.match(fresh.text, /^#!\/bin\/sh\n# >>> qamcp/);
  const theirs = '#!/bin/sh\nnpm run lint\n';
  const added = withHook(theirs, block);
  assert.ok(added.text.startsWith(theirs.trim()), 'their own steps stay first');
  assert.equal(added.hadOther, true);
  const again = withHook(added.text, hookBlock({ stdio: 'npm start', failUnder: 90 }));
  assert.equal(again.replaced, true);
  assert.equal(again.text.match(/# >>> qamcp/g)?.length, 1, 'never two QAmcp blocks');
  assert.match(again.text, /--fail-under 90/);
  assert.match(again.text, /npm run lint/);
});

test('hook: installs into a real git repository and refuses a folder that is not one', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho mine\n');
  const r = installHook({ url: 'http://localhost:3000/mcp', failUnder: 80 }, repo);
  const text = readFileSync(r.path, 'utf8');
  assert.match(text, /echo mine/);
  assert.match(text, /qamcp-cli 'http:\/\/localhost:3000\/mcp' --fail-under 80/);
  const notRepo = mkdtempSync(join(tmpdir(), 'plain-'));
  assert.throws(() => installHook({ url: 'http://x/mcp', failUnder: 80 }, notRepo), /not a git repository/);
});
