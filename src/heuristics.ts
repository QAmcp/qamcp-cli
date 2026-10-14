// Word-level checks on tool descriptions and answers. Each one reports a fact you
// can verify by reading the text ("shares 82% of its words with…", "contains
// 'various'"), never an AI's opinion.

import type { Tool } from '@modelcontextprotocol/client';
import { nameWords } from './toolSafety.js';
import type { ToolCallRecord } from './types.js';

const STOP = new Set(
  'a an the and or of for to in on at by with from as is are be this that these those it its into your you can will use used using via per each any all one more than when which what who'.split(' '),
);

// Words that say nothing about what a tool does.
const FILLER = ['various', 'stuff', 'things', 'something', 'misc', 'miscellaneous', 'etc', 'handles', 'manages', 'general purpose', 'generic', 'some data'];

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => (w.length > 4 && /(x|ch|sh)es$/.test(w) ? w.slice(0, -2) : w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

// ---------- #2 vague descriptions ----------

// Returns why a description is vague, or undefined if it isn't.
export function vagueDescription(tool: Tool): string | undefined {
  const desc = tool.description?.trim() ?? '';
  if (!desc) return undefined; // "no description" is reported by its own rule
  const lower = desc.toLowerCase();
  const fillers = FILLER.filter((f) => new RegExp(`\\b${f}\\b`).test(lower));
  // Long, detailed descriptions can say "various formats" and still be clear; short ones can't.
  if (fillers.length >= 2 || (fillers.length === 1 && desc.length < 120)) return `uses vague words (${fillers.map((f) => `"${f}"`).join(', ')}) instead of saying what it does and returns`;
  const name = new Set(nameWords(tool.name).map((w) => contentWords(w)[0] ?? w));
  const words = contentWords(desc);
  if (words.length > 0 && words.length <= 4 && words.every((w) => name.has(w) || [...name].some((n) => w.startsWith(n) || n.startsWith(w))))
    return 'only repeats the tool name, so it adds nothing an AI could use';
  return undefined;
}

// ---------- #7 near-duplicate tools ----------

export interface SimilarPair {
  a: string;
  b: string;
  overlap: number; // 0..1 share of description words the two tools have in common
  onlyA: string[]; // words only tool a's description uses
  onlyB: string[]; // words only tool b's description uses
}

// Tools whose descriptions use mostly the same words. An AI picks tools from these
// descriptions, so near-identical ones make it guess.
export function similarTools(tools: Tool[], threshold = 0.6): SimilarPair[] {
  const sets = tools.map((t) => ({ name: t.name, words: new Set(contentWords(t.description ?? '')) }));
  const pairs: SimilarPair[] = [];
  for (let i = 0; i < sets.length; i++)
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i].words;
      const b = sets[j].words;
      if (a.size < 4 || b.size < 4) continue; // too short to compare fairly
      const shared = [...a].filter((w) => b.has(w)).length;
      const overlap = shared / (a.size + b.size - shared);
      if (overlap >= threshold)
        pairs.push({ a: sets[i].name, b: sets[j].name, overlap, onlyA: [...a].filter((w) => !b.has(w)), onlyB: [...b].filter((w) => !a.has(w)) });
    }
  return pairs.sort((x, y) => y.overlap - x.overlap);
}

// ---------- #6 claims success but returns nothing ----------

const SUCCESS_ONLY = /^\W*(ok|okay|success|successful|done|true|completed?)\W*$/i;
const STATUS_KEYS = new Set(['status', 'success', 'ok', 'result', 'message', 'code']);

// An answer that says "it worked" and nothing else: no data at all.
export function isEmptySuccess(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (SUCCESS_ONLY.test(t)) return true;
  try {
    const v = JSON.parse(t);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const entries = Object.entries(v);
      return entries.length > 0 && entries.every(([k, val]) => STATUS_KEYS.has(k.toLowerCase()) && (typeof val !== 'object' || val === null) && SUCCESS_ONLY.test(String(val)));
    }
  } catch {
    // not JSON
  }
  return false;
}

export interface HollowTool {
  tool: string;
  reason: string;
  serious: boolean; // both signs at once: the same empty "success" whatever we send
}

// Tools that answer the same way to good and bad input, or say "success" with no data.
export function hollowTools(calls: ToolCallRecord[]): HollowTool[] {
  const out: HollowTool[] = [];
  const byTool = new Map<string, ToolCallRecord[]>();
  for (const c of calls) byTool.set(c.tool, [...(byTool.get(c.tool) ?? []), c]);
  for (const [tool, list] of byTool) {
    const good = list.find((c) => c.kind === 'good-input' && c.outcome === 'ok');
    if (!good) continue;
    const body = (c: ToolCallRecord) => c.text.replace(/^\[[^\]]+\]\s*/, '').trim();
    const sameForBad = list.some((c) => c.kind === 'bad-input' && c.outcome === 'ok' && body(c) === body(good));
    const empty = isEmptySuccess(body(good));
    if (sameForBad && empty) out.push({ tool, serious: true, reason: `answers ${short(body(good))} whatever we send, even with inputs missing. It claims success but returns no data.` });
    else if (empty) out.push({ tool, serious: false, reason: `answers ${short(body(good))} with no actual data` });
    else if (sameForBad) out.push({ tool, serious: false, reason: 'gives the exact same answer to bad input as to good input, so it may be ignoring what it is sent' });
  }
  return out;
}

function short(text: string): string {
  const one = text.replace(/\s+/g, ' ');
  return `"${one.length > 60 ? one.slice(0, 59) + '…' : one}"`;
}
