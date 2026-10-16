// How "Tools work together" finds the value to hand from one tool to the next.
// Each case comes from a real server in the 2026-10-17 sweep.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateValues } from '../src/chains.js';

test('an id inside a JSON answer fills a *_id input (genosys: search_products → get_product)', () => {
  const answer = '{ "count": 8, "products": [ { "id": "19", "name": "ALL FOR SENSITIVE SERUM" } ] }';
  assert.deepEqual(candidateValues(answer, 'product_id')[0], { value: '19', from: 'id', rank: 1 });
});

test('a text part followed by a structured JSON part is still read as JSON', () => {
  const answer = 'Found 8 products.\n{ "products": [ { "id": "19" } ] }';
  assert.equal(candidateValues(answer, 'product_id')[0]?.value, '19');
});

test('"owner/name" ids in a plain-text answer fill an ids input (Hugging Face: hub_repo_search → hub_repo_details)', () => {
  const answer = 'Found 40 repositories. ## Models (20) ### google/embeddinggemma-2 **Task:** feature-extraction';
  assert.equal(candidateValues(answer, 'repo_ids')[0]?.value, 'google/embeddinggemma-2');
});

test('library paths are still found (Context7: resolve-library-id → query-docs)', () => {
  assert.equal(candidateValues('- Title: Boost\n- Context7-compatible library ID: /websites/boost_doc_libs', 'libraryId')[0]?.value, '/websites/boost_doc_libs');
});

test('ordinary words are not mistaken for ids', () => {
  assert.deepEqual(candidateValues('Sunny and warm today, with light wind.', 'city_id'), []);
});

import { isHandoff, isSpecific } from '../src/chains.js';

test('only IDs and links are handoffs; settings are not (real SparkQuote, MemeStack, Veliane cases)', () => {
  for (const n of ['product_id', 'repo_ids', 'libraryId', 'slug', 'url', 'id']) assert.ok(isHandoff(n), n);
  for (const n of ['volts', 'temp', 'type', 'limit', 'lang', 'size', 'material', 'min_ram_gb']) assert.ok(!isHandoff(n), n);
});

test('a broken handoff needs a specific name: user_id can be broken, a bare id cannot', () => {
  assert.ok(isSpecific('user_id') && isSpecific('repo_ids') && isSpecific('libraryId'));
  assert.ok(!isSpecific('id') && !isSpecific('ids') && !isSpecific('url') && !isSpecific('slug'));
});
