// "Tools work together": AI apps chain tools (search_users → get_orders), so a server can
// pass every tool on its own and still fail real jobs. This check finds two-step chains
// where tool A's answer holds a value that tool B asks for, and runs them. No AI involved;
// every result is something that happened:
//   works:    B gives a real answer with A's value, a made-up value gets a different
//             answer (so B really uses it), and B's answer adds something A didn't say.
//   broken:   A hands out a value under the exact name B asks for, B works with our own
//             sample input, yet B can't use the value A just gave.
//   mismatch: A gives that value as text, but B only accepts a number.
// Only tools that are safe to run are called, and the search stops after a fixed number of calls.
// (The proving rules come from the hosted version's chain finder.)

import type { Tool } from '@modelcontextprotocol/client';
import { isEmptySuccess } from './heuristics.js';
import type { CheckResult, Finding, ToolCallRecord } from './types.js';

export interface ChainStart {
  tool: string;
  args: Record<string, unknown>;
  result: string;
}

export interface ChainInput {
  tools: Tool[]; // safe tools only
  starts: ChainStart[]; // good-input answers that returned real data
  worksAlone: Set<string>; // tools that gave a real answer to our own sample input
  sampleArgs: (tool: Tool) => Record<string, unknown>;
  execute: (tool: Tool, args: Record<string, unknown>) => Promise<ToolCallRecord>;
  maxCalls?: number;
}

const FAKE_TEXT = 'zzzz-not-real-0000';
const FAKE_NUMBER = 999_999_999;
const MAX_VALUE_LENGTH = 120;
const MAX_WORKING = 5;

export async function chainCheck(input: ChainInput): Promise<CheckResult> {
  let callsLeft = input.maxCalls ?? 30;
  const findings: Finding[] = [];
  const done = new Set<string>(); // "A→B" pairs already decided
  const call = async (tool: Tool, args: Record<string, unknown>) => (callsLeft-- > 0 ? input.execute(tool, args) : undefined);
  let working = 0;

  // Every possible handoff first, strongest match first, so the call budget goes to the
  // likeliest chains ("id" from search_products into get_product's product_id) and not
  // to weak guesses that happen to come earlier in the tool list.
  const tries: { start: ChainStart; b: Tool; inputName: string; shape: Shape; c: Candidate }[] = [];
  for (const start of input.starts) {
    for (const b of input.tools) {
      if (b.name === start.tool) continue;
      const props: Record<string, any> = (b.inputSchema as any)?.properties ?? {};
      const required: string[] = (b.inputSchema as any)?.required ?? [];
      for (const inputName of required.length ? required : Object.keys(props)) {
        const shape = shapeOf(props[inputName]);
        // Only IDs and links are handed from one job step to the next. Settings like volts,
        // temp, type, limit or lang match by name across tools without being a chain.
        if (!shape || !isHandoff(inputName)) continue;
        for (const c of candidateValues(start.result, inputName).slice(0, 2)) tries.push({ start, b, inputName, shape, c });
      }
    }
  }
  // IDs and links first: they're what real jobs hand from one tool to the next (a filter
  // value like category = "Cream" also chains, but says less).
  tries.sort((x, y) => x.c.rank - y.c.rank);

  for (const { start, b, inputName, shape, c } of tries) {
    if (callsLeft <= 0 || working >= MAX_WORKING) break;
    const pair = `${start.tool}→${b.name}`;
    if (done.has(pair)) continue;

    // A type mismatch needs no call: the value A hands out can't fit B's input.
    if (c.rank === 0 && shape === 'number' && isSpecific(inputName) && Number.isNaN(Number(c.value))) {
      findings.push({ status: 'warn', tool: b.name, message: `${start.tool} gives ${c.from} as text ("${short(c.value)}"), but ${b.name} only accepts ${inputName} as a number, so an AI can't pass one to the other` });
      done.add(pair);
      continue;
    }
    const value = fill(shape, c.value);
    if (value === undefined) continue;
    const base = input.sampleArgs(b);
    const real = await call(b, { ...base, [inputName]: value });
    if (!real) break;
    if (hasData(real)) {
      const fakeValue = fill(shape, shape === 'number' ? String(FAKE_NUMBER) : FAKE_TEXT)!;
      const fake = await call(b, { ...base, [inputName]: fakeValue });
      if (fake && hasData(fake) && same(blank(fake.text, shape === 'number' ? String(FAKE_NUMBER) : FAKE_TEXT), blank(real.text, c.value))) continue; // B ignores the value
      if (!addsSomethingNew(start.result, real.text)) continue; // goes in a circle
      findings.push({ status: 'pass', tool: start.tool, message: `${start.tool} → ${b.name}: ${b.name} found what ${start.tool} returned (${inputName} = "${short(c.value)}")` });
      working++;
      done.add(pair);
      continue;
    }
    // Broken handoff: only with an exact name match and proof B works on its own.
    // A bare "id" can mean different things in different tools (a fact id is not a feature id),
    // so only a specific name like user_id → user_id can be called a broken handoff.
    if (c.rank === 0 && isSpecific(inputName) && input.worksAlone.has(b.name) && (real.outcome === 'ok' || real.outcome === 'tool-error' || real.outcome === 'protocol-error')) {
      findings.push({ status: 'warn', tool: b.name, message: `${start.tool} returns ${c.from} "${short(c.value)}", but ${b.name} couldn't use it: ${short(real.text.replace(/\s+/g, ' ') || 'empty answer', 120)}` });
      done.add(pair);
    }
  }

  if (!findings.length) {
    const why = input.starts.length
      ? "No tool's answer could be fed into another tool, so there were no chains to test (not counted either way)"
      : 'No safe tool returned data to start a chain from, so chains were not tested (not counted either way)';
    return finish([{ status: 'skip', message: why }], true);
  }
  if (callsLeft <= 0) findings.push({ status: 'pass', message: 'Stopped looking for more chains after the limit on tool calls' });
  return finish(findings, false);
}

type Candidate = { value: string; from: string; rank: number };

const HANDOFF = /(ids?|urls?|uris?|links?|keys?|slugs?|refs?|paths?|handles?)$/i;
const BARE = /^(ids?|urls?|uris?|links?|keys?|slugs?|refs?|paths?|handles?)$/i;
const flat = (name: string) => name.replace(/[^a-z0-9]/gi, '');
// An input that takes an ID or a link: user_id, repo_ids, libraryId, slug, url.
export function isHandoff(name: string): boolean {
  return HANDOFF.test(flat(name));
}
// An ID name that says what it identifies: user_id yes, plain id no.
export function isSpecific(name: string): boolean {
  return isHandoff(name) && !BARE.test(flat(name));
}
type Shape = 'text' | 'number' | 'list';

// The inputs a value from another tool can fill: text, a number, or a list of text (repo_ids).
function shapeOf(prop: any): Shape | undefined {
  const type = prop?.type;
  if (!type || type === 'string') return 'text';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'array' && (!prop.items?.type || prop.items.type === 'string')) return 'list';
  return undefined;
}

function fill(shape: Shape, value: string): unknown {
  if (shape === 'number') return Number.isNaN(Number(value)) ? undefined : Number(value);
  return shape === 'list' ? [value] : value;
}

function finish(findings: Finding[], skip: boolean): CheckResult {
  const status = skip ? 'skip' : findings.some((f) => f.status === 'fail') ? 'fail' : findings.some((f) => f.status === 'warn') ? 'warn' : 'pass';
  const works = findings.filter((f) => f.status === 'pass' && f.tool).length;
  const issues = findings.filter((f) => f.status === 'warn').length;
  const summary = skip ? 'Not tested' : issues ? `${issues} chain${issues === 1 ? '' : 's'} broken${works ? `, ${works} working` : ''}` : `${works} chain${works === 1 ? '' : 's'} working`;
  return { id: 'chains', title: 'Tools work together', status, summary, weight: 10, findings };
}

// A real answer: no error, not empty, not a bare "success".
function hasData(r: ToolCallRecord): boolean {
  const t = r.text.trim();
  return r.outcome === 'ok' && t.length > 2 && t !== '[]' && t !== '{}' && !isEmptySuccess(t);
}

function blank(text: string, value: string): string {
  return value ? text.split(value).join('<value>') : text;
}

function same(a: string, b: string): boolean {
  return a.trim() === b.trim() || (a.length > 200 && a.slice(0, 200) === b.slice(0, 200));
}

function short(text: string, max = 60): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// True when the second answer has at least two words the first one never mentioned.
export function addsSomethingNew(first: string, second: string): boolean {
  const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{2,}/g) ?? []);
  const seen = words(first);
  let fresh = 0;
  for (const w of words(second)) if (!seen.has(w) && ++fresh >= 2) return true;
  return false;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Values in an answer that could fill `inputName`, best match first. rank 0 = the exact
// name ("user_id" ← "user_id" or "userId"), 1 = one name ends the other ("customer_id" ← "id"),
// 2 = one contains the other, 3 = an ID- or link-looking token in plain text.
export function candidateValues(text: string, inputName: string): { value: string; from: string; rank: number }[] {
  const target = norm(inputName);
  const out: { value: string; from: string; rank: number }[] = [];
  const add = (value: unknown, from: string, rank: number) => {
    const v = String(value).trim();
    if (!v || v.length > MAX_VALUE_LENGTH || out.some((o) => o.value === v)) return;
    out.push({ value: v, from, rank });
  };
  // An answer can be JSON, or a text part followed by a structured (JSON) part on its own line.
  const parse = (t: string) => {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  };
  const parts = [text, ...text.split(/\n(?=[{[])/).slice(1)].map(parse).filter((p) => p !== undefined && typeof p === 'object');
  const json: unknown = parts.length ? parts : undefined;
  if (json !== undefined) {
    walk(json, '', (key, value) => {
      const k = norm(key);
      if (!k || (typeof value !== 'string' && typeof value !== 'number')) return;
      if (k === target) add(value, key, 0);
      else if (target.endsWith(k) || k.endsWith(target)) add(value, key, 1);
      else if (k.includes(target) || target.includes(k)) add(value, key, 2);
    });
  } else {
    if (/(url|uri|link|href)$/.test(target)) for (const m of text.matchAll(/https?:\/\/[^\s"'`<>)\]]+/g)) add(m[0].replace(/[.,;]+$/, ''), 'a link', 3);
    if (/(ids?|keys?|slugs?|paths?|refs?|codes?|numbers?|no)$/.test(target)) {
      // "/facebook/react", "C-42", and "owner/name" IDs like "google/gemma-2" (repos, models)
      for (const m of text.matchAll(/(?:^|[\s"'`(:#*])(\/[\w.-]+(?:\/[\w.-]+)+|[A-Za-z]{1,6}[-_]\d[\w-]*|[A-Za-z0-9][\w.-]*\/[\w.-]*[A-Za-z0-9])(?=[\s"'`),.;*]|$)/g)) add(m[1], 'an ID', 3);
    }
  }
  return out.sort((a, b) => a.rank - b.rank);
}

function walk(node: unknown, key: string, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(node)) node.slice(0, 5).forEach((n) => walk(n, key, visit));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, k, visit);
  else visit(key, node);
}
