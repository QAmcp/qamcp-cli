// Tool drift: every change between two tests of the same server, behavior changes first, exact lines.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import { diffTools, formatChanges, lastTools, lineDiff, rememberTools } from '../src/drift.js';
import { runTest } from '../src/runTest.js';
import { toMarkdown } from '../src/ci.js';
import { toHtml } from '../src/htmlReport.js';
import { startSpecServer } from './specServer.js';

const PORT = 4622;
let server: Awaited<ReturnType<typeof startSpecServer>>;
before(async () => { server = await startSpecServer(PORT); });
after(() => { (server as any).closeAllConnections?.(); (server as any).close?.(); });

test('drift: a real server changed between two tests: every change found, the risky ones first', async () => {
  const a = await runTest(`http://127.0.0.1:${PORT}/driftold/mcp`, { timeoutMs: 10_000 });
  const b = await runTest(`http://127.0.0.1:${PORT}/driftnew/mcp`, { timeoutMs: 10_000 });
  assert.ok(a.toolDefs?.length && b.toolDefs?.length, 'each test keeps the tools as the server described them');
  const changes = diffTools(a.toolDefs!, b.toolDefs!);
  const by = Object.fromEntries(changes.map((c) => [c.tool, c]));
  assert.deepEqual(by.export_notes.what, ['new tool']);
  assert.match(by.get_stats.what[0], /tool removed/);
  const note = by.get_note.what.join(' | ');
  assert.match(note, /input renamed: "id" is now "note_id"/);
  assert.match(note, /safety label readOnlyHint: true → false/);
  assert.match(note, /description now says it "sends"/);
  assert.equal(by.search_notes.important, false, 'rewording alone is not a behavior change');
  assert.deepEqual(by.search_notes.what, ['description reworded']);
  assert.equal(changes.at(-1)!.tool, 'search_notes', 'rewording comes last');
  assert.match(by.search_notes.diff, /^- description: Search notes by text\.\n\+ description: Search your notes by text\.$/);
});

test('drift: nothing changed means no changes, and a small line diff is exact', () => {
  const t = [{ name: 'x', description: 'Gets x.', inputSchema: { type: 'object', properties: {} } }];
  assert.deepEqual(diffTools(t, structuredClone(t)), []);
  assert.equal(formatChanges([], '2026-10-20'), 'Tools unchanged since the last test (2026-10-20).');
  assert.equal(lineDiff(['a', 'b', 'c'], ['a', 'c', 'd']), '- b\n+ d');
});

test('drift: newly required and changed type inputs are behavior changes', () => {
  const before = [{ name: 'q', inputSchema: { type: 'object', properties: { n: { type: 'number' }, s: { type: 'string' } } } }];
  const after = [{ name: 'q', inputSchema: { type: 'object', properties: { n: { type: 'string' }, s: { type: 'string' } }, required: ['s'] } }];
  const [c] = diffTools(before, after);
  assert.equal(c.important, true);
  assert.match(c.what.join(' | '), /"s" is now required/);
  assert.match(c.what.join(' | '), /"n" changed type/);
});

test('drift: the tool list is remembered on this computer, in a folder git ignores', () => {
  const was = process.cwd();
  process.chdir(mkdtempSync(`${tmpdir()}/drift-`));
  try {
    assert.equal(lastTools('https://x.ai/mcp'), undefined);
    rememberTools('https://x.ai/mcp', '2026-10-20T10:00:00Z', [{ name: 'x' }]);
    assert.deepEqual(lastTools('https://x.ai/mcp')?.tools, [{ name: 'x' }]);
    assert.equal(lastTools('https://other.ai/mcp'), undefined, 'each server has its own history');
  } finally {
    process.chdir(was);
  }
});

test('drift: the changes appear in the pull-request summary and the report page, escaped', async () => {
  const r = await runTest(`http://127.0.0.1:${PORT}/driftnew/mcp`, { timeoutMs: 10_000 });
  r.toolChanges = { since: '2026-10-20', changes: diffTools([{ name: 'get_note', description: '<b>old</b>' }], r.toolDefs!) };
  const md = toMarkdown(r);
  assert.match(md, /\*\*Tools changed since 2026-10-20\*\*/);
  assert.match(md, /```diff/);
  const html = toHtml(r);
  assert.match(html, /Tools changed since 2026-10-20/);
  assert.ok(!html.includes('<b>old</b>'), 'server text is escaped');
});
