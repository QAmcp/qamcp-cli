// The rules that decide which tools we may call on someone's live server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideRun, type SafetyMode } from '../src/toolSafety.js';

const tool = (name: string, description = '', annotations?: Record<string, boolean>, inputs: string[] = []) =>
  ({ name, description, inputSchema: { type: 'object', properties: Object.fromEntries(inputs.map((i) => [i, { type: 'string' }])) }, annotations }) as any;
const MODES: SafetyMode[] = ['labeled', 'owner', 'all'];

test('by default, runs only tools labeled read-only (MCP spec: unlabeled means possibly dangerous)', () => {
  assert.deepEqual(decideRun(tool('anything', '', { readOnlyHint: true }), 'labeled'), { run: true, why: 'labeled read-only' });
  const d = decideRun(tool('search_docs', 'Searches the docs.'), 'labeled');
  assert.equal(d.run, false);
  assert.match(d.why, /no safety label/);
});

test('never runs tools labeled dangerous or as changing data, in any mode', () => {
  for (const mode of MODES) {
    assert.equal(decideRun(tool('get_info', '', { destructiveHint: true }), mode).run, false, mode);
    assert.equal(decideRun(tool('get_info', '', { readOnlyHint: false }), mode).run, false, mode);
  }
});

test('never runs delete-sounding tools, even when labeled read-only, in any mode', () => {
  for (const name of ['delete_user', 'removeItem', 'db.drop', 'reset-password'])
    for (const mode of MODES) assert.equal(decideRun(tool(name, '', { readOnlyHint: true }), mode).run, false, `${name} ${mode}`);
});

test("doesn't trust a read-only label that the tool itself contradicts", () => {
  assert.match((decideRun(tool('slack_status', 'Sends a message to Slack.', { readOnlyHint: true }), 'labeled') as any).why, /labeled read-only, but its description says "Sends"/);
  assert.equal(decideRun(tool('get_status', '', { readOnlyHint: true }, ['amount']), 'labeled').run, false);
  assert.equal(decideRun(tool('send_report', '', { readOnlyHint: true }), 'labeled').run, false);
  // Real tools from the registry that only contain a write word: not a contradiction.
  assert.equal(decideRun(tool('estimate_move_to_dubai', 'Estimates moving costs.', { readOnlyHint: true }), 'labeled').run, true);
  assert.equal(decideRun(tool('get_start_path', 'Returns the recommended starting doc.', { readOnlyHint: true }), 'labeled').run, true);
});

test('owner mode: runs unlabeled tools whose names clearly only read', () => {
  for (const name of ['ask_wiki_question', 'read_wiki_contents', 'resolve-library-id', 'searchCode', 'fetch_generic_url_content', 'microsoft_docs_search', 'get_preset'])
    assert.deepEqual(decideRun(tool(name, 'Looks things up.'), 'owner'), { run: true, why: 'name says read-only' }, name);
});

test('owner mode: skips unlabeled tools with any sign of writing', () => {
  for (const name of ['get_or_create_user', 'send_email', 'list_and_archive', 'fetchAndUpdate', 'run_query', 'place_order', 'get_new_token'])
    assert.equal(decideRun(tool(name), 'owner').run, false, name);
  assert.equal(decideRun(tool('list_digest', 'Sends a summary email to the team.'), 'owner').run, false);
  assert.equal(decideRun(tool('get_cleanup', 'Permanently clears old logs.'), 'owner').run, false);
  assert.equal(decideRun(tool('get_quote', '', undefined, ['recipient']), 'owner').run, false);
});

test("owner mode: skips unlabeled tools whose name doesn't say what they do", () => {
  assert.equal(decideRun(tool('weather'), 'owner').run, false);
  assert.equal(decideRun(tool('process_items'), 'owner').run, false);
});

test('"all" mode runs unlabeled tools, but still never dangerous ones', () => {
  assert.deepEqual(decideRun(tool('send_email'), 'all'), { run: true, why: 'owner allowed' });
  assert.equal(decideRun(tool('delete_all'), 'all').run, false);
});

test('advice to the AI is not a write: "the code you want to send to the user" (real Svelte description)', () => {
  const svelte = tool('playground-link', 'Generates a Playground link given a Svelte code snippet. Once you have the final version of the code you want to send to the user, ALWAYS ask the user first.', { readOnlyHint: true });
  assert.deepEqual(decideRun(svelte, 'labeled'), { run: true, why: 'labeled read-only' });
});

test('a first sentence that says the tool writes still overrides a read-only label', () => {
  assert.equal(decideRun(tool('notes_tool', 'Sends your notes to the team. Fast.', { readOnlyHint: true }), 'labeled').run, false);
  assert.equal(decideRun(tool('cleanup_tool', 'Cleans the cache. This is permanent and cannot be undone.', { readOnlyHint: true }), 'labeled').run, false);
});

import { labelContradiction } from '../src/toolSafety.js';

test('accusing a read-only label needs two signals (real GENOSYS case: create_bag_link builds a link)', () => {
  const bagLink = tool('create_bag_link', 'Build one link that opens genosys.ae with these items already in the bag.', { readOnlyHint: true }, ['items']);
  assert.equal(labelContradiction(bagLink), undefined);
  assert.match(labelContradiction(tool('send_report', 'Sends the report to your team.', { readOnlyHint: true }))!, /starts with "send" and its description says "Sends"/);
  assert.match(labelContradiction(tool('create_payment', 'Makes a payment link.', { readOnlyHint: true }, ['amount']))!, /"amount" input/);
  // Still not run on one signal alone: caution for running, proof for accusing.
  assert.equal(decideRun(bagLink, 'labeled').run, false);
});

test('a read-only tool skipped only for its name says why and what to do', () => {
  const d = decideRun(tool('add', 'Adds two numbers.', { readOnlyHint: true }, ['a', 'b']), 'labeled') as any;
  assert.equal(d.run, false);
  assert.match(d.why, /labeled read-only, but its name starts with "add", which usually means it changes something\. Skipped to be safe: if it only reads, a clearer name helps AI apps too, or test again with --owner/);
});

test('read-only tools that run whatever they are sent are skipped in safe mode', () => {
  const ro = { readOnlyHint: true };
  for (const input of ['sql', 'command', 'rawQuery', 'force', 'cascade', 'hard_delete']) {
    const d = decideRun(tool('db_lookup', 'Looks things up.', ro, [input]), 'labeled');
    assert.equal(d.run, false, input);
    assert.match(d.why, new RegExp(`"${input}" input`), input);
  }
  const described = { name: 'report_view', description: 'Shows a report.', annotations: ro, inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'The SQL query to run' } } } } as any;
  assert.match((decideRun(described, 'labeled') as any).why, /described as "SQL query"/);
});

test('an ordinary search query is not a raw query', () => {
  const ro = { readOnlyHint: true };
  assert.equal(decideRun(tool('search_docs', 'Searches the docs.', ro, ['query', 'limit', 'force_refresh_cache']), 'labeled').run, true);
  const search = { name: 'search_docs', description: 'Searches.', annotations: ro, inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Any query, in plain words' } } } } as any;
  assert.equal(decideRun(search, 'labeled').run, true);
});

test('the owner can still run a labeled read-only tool with a raw input', () => {
  assert.equal(decideRun(tool('db_lookup', 'Looks things up.', { readOnlyHint: true }, ['sql']), 'owner').run, true);
});
