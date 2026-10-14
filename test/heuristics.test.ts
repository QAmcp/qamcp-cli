// Word-level checks for vague descriptions, near-duplicate tools, and fake "success".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hollowTools, isEmptySuccess, similarTools, vagueDescription } from '../src/heuristics.js';
import type { ToolCallRecord } from '../src/types.js';

const tool = (name: string, description: string) => ({ name, description, inputSchema: { type: 'object' } }) as any;

test('vague: filler words in a short description', () => {
  assert.match(vagueDescription(tool('process_data', 'Handles data processing for various things.'))!, /"various", "things", "handles"|vague words/);
  assert.equal(vagueDescription(tool('get_order', 'Get one order by its order number. Returns the items, total, and delivery status.')), undefined);
});

test('vague: a long, specific description may say "various" once', () => {
  const long = 'Search Microsoft documentation and return up to ten matching articles with titles, links, and short excerpts. Supports various product names and versions.';
  assert.equal(vagueDescription(tool('docs_search', long)), undefined);
});

test('vague: a description that only repeats the name', () => {
  assert.match(vagueDescription(tool('get_weather', 'Gets weather.'))!, /only repeats the tool name/);
});

test('similar: near-identical descriptions are paired, different ones are not', () => {
  const pairs = similarTools([
    tool('search_customers', 'Search customers by name and return matching customer profiles.'),
    tool('find_customers', 'Find customers by name and return the matching customer profiles.'),
    tool('get_order', 'Get one order by its order number. Returns the items, total, and delivery status.'),
  ]);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].a, pairs[0].b], ['search_customers', 'find_customers']);
});

test('empty success: "success" with no data', () => {
  assert.ok(isEmptySuccess('{"status":"success"}'));
  assert.ok(isEmptySuccess('OK'));
  assert.ok(!isEmptySuccess('{"status":"success","price":4.2}'));
  assert.ok(!isEmptySuccess('Found 0 users named test'));
});

const call = (tool: string, kind: ToolCallRecord['kind'], text: string, outcome: ToolCallRecord['outcome'] = 'ok'): ToolCallRecord =>
  ({ tool, kind, text, outcome, why: 'labeled read-only', arguments: {}, ms: 1 });

test('hollow: same empty success for good and bad input is serious', () => {
  const h = hollowTools([call('quote', 'good-input', '{"status":"success"}'), call('quote', 'bad-input', '[missing required input "postcode"] {"status":"success"}')]);
  assert.equal(h.length, 1);
  assert.equal(h[0].serious, true);
});

test('hollow: a real answer that refuses bad input is fine', () => {
  assert.equal(hollowTools([call('get_order', 'good-input', '{"order":"A1","total":12}'), call('get_order', 'bad-input', '[missing] "order_id" is required', 'tool-error')]).length, 0);
});

import { INTERNAL_PATTERNS, allMatches } from '../src/patterns.js';

test('leaks: finds server paths and secrets files, the fault-server case included', () => {
  const msg = 'Error: lookup failed. Upstream auth used key sk-test-FAKE from /srv/app/config/secrets.env (CRM client v2)';
  assert.deepEqual(allMatches(msg, INTERNAL_PATTERNS), ['server file path', 'secrets file name']);
  assert.deepEqual(allMatches('could not open /etc/myapp/db.conf', INTERNAL_PATTERNS), ['server file path']);
  assert.deepEqual(allMatches(String.raw`failed reading C:\inetpub\site\web.config`, INTERNAL_PATTERNS), ['server file path']);
  assert.deepEqual(allMatches('missing .env file', INTERNAL_PATTERNS), ['secrets file name']);
});

test('leaks: web links and normal words are not server paths', () => {
  assert.deepEqual(allMatches('See https://example.com/app/docs and https://site.io/home/page', INTERNAL_PATTERNS), []);
  assert.deepEqual(allMatches('"query" is required and must be text', INTERNAL_PATTERNS), []);
  assert.deepEqual(allMatches('Use the environment settings', INTERNAL_PATTERNS), []);
});

test('similar: names the words that tell the two tools apart (real Tandem case)', () => {
  const [p] = similarTools([
    tool('refresh_docs_index', 'Force-refresh docs indexes and report whether data came from the network, cache, or stale fallback.'),
    tool('refresh_doc_page', 'Force-refresh a docs page and report whether content came from the network, cache, or stale fallback.'),
  ]);
  assert.deepEqual([p.onlyA, p.onlyB], [['index', 'data'], ['page', 'content']]);
});
