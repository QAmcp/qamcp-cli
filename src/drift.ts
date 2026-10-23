// Tool drift: what changed in a server's tools since the last time it was tested.
// A tool whose description or inputs quietly change after someone approved the server can change
// what an AI does with it, so every change is shown, ranked so the ones that change behavior come
// first (a new or renamed input, a newly required field, a changed type or safety label, new action
// words in the description) and rewording comes last, each with the exact before/after lines.
//
// Between runs QAmcp keeps each server's tool list on this computer, in .qamcp/tools/ (the .qamcp
// folder ignores itself in git). Nothing is sent anywhere.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WRITE_VERB } from './toolSafety.js';

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

export interface ToolChange {
  tool: string;
  important: boolean; // changes what the tool does or how it's called, not just its wording
  what: string[]; // plain words, most important first
  diff: string; // unified lines: "- before" / "+ after"
}

export const toToolDef = (t: { name: string; description?: string; inputSchema?: unknown; annotations?: unknown }): ToolDef => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  ...(t.annotations && typeof t.annotations === 'object' ? { annotations: t.annotations as Record<string, unknown> } : {}),
});

type Props = Record<string, { type?: unknown; description?: unknown } & Record<string, unknown>>;
const props = (s: unknown): Props => ((s as any)?.properties && typeof (s as any).properties === 'object' ? (s as any).properties : {});
const required = (s: unknown): Set<string> => new Set(Array.isArray((s as any)?.required) ? (s as any).required.map(String) : []);
const typeOf = (p: unknown) => JSON.stringify((p as any)?.type ?? (p as any)?.anyOf ?? (p as any)?.enum ?? null);
const words = (text: string | undefined) => new Set(((text ?? '').match(WRITE_VERB_GLOBAL) ?? []).map((w) => w.toLowerCase()));
const WRITE_VERB_GLOBAL = new RegExp(WRITE_VERB.source, 'gi');

// The tool as readable lines, so a line diff shows what really changed.
function lines(t: ToolDef): string[] {
  const out: string[] = [];
  for (const s of (t.description ?? '').split(/(?<=[.!?])\s+|\n+/)) if (s.trim()) out.push(`description: ${s.trim()}`);
  const p = props(t.inputSchema);
  const req = required(t.inputSchema);
  for (const k of Object.keys(p).sort()) {
    const { description, ...rest } = p[k];
    out.push(`input ${k}${req.has(k) ? ' (required)' : ''}: ${JSON.stringify(rest)}`);
    if (typeof description === 'string' && description.trim()) out.push(`input ${k} description: ${description.trim()}`);
  }
  for (const [k, v] of Object.entries(t.annotations ?? {}).sort(([a], [b]) => a.localeCompare(b))) out.push(`label ${k}: ${JSON.stringify(v)}`);
  return out;
}

// A small line diff (longest common subsequence): enough for one tool's lines.
export function lineDiff(a: string[], b: string[]): string {
  const n = a.length, m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out.join('\n');
}

function compareTool(before: ToolDef, after: ToolDef): ToolChange | undefined {
  const diff = lineDiff(lines(before), lines(after));
  if (!diff) return undefined;
  const important: string[] = [];
  const minor: string[] = [];
  const pb = props(before.inputSchema), pa = props(after.inputSchema);
  const rb = required(before.inputSchema), ra = required(after.inputSchema);
  const added = Object.keys(pa).filter((k) => !(k in pb));
  const removed = Object.keys(pb).filter((k) => !(k in pa));
  if (added.length === 1 && removed.length === 1 && typeOf(pa[added[0]]) === typeOf(pb[removed[0]])) important.push(`input renamed: "${removed[0]}" is now "${added[0]}"`);
  else {
    for (const k of added) important.push(`new input "${k}"${ra.has(k) ? ' (required)' : ''}`);
    for (const k of removed) important.push(`input "${k}" removed`);
  }
  for (const k of Object.keys(pa).filter((k) => k in pb)) {
    if (ra.has(k) && !rb.has(k)) important.push(`"${k}" is now required`);
    if (!ra.has(k) && rb.has(k)) important.push(`"${k}" is no longer required`);
    if (typeOf(pa[k]) !== typeOf(pb[k])) important.push(`"${k}" changed type`);
    else if (JSON.stringify({ ...pa[k], description: 0 }) !== JSON.stringify({ ...pb[k], description: 0 })) important.push(`"${k}" accepts different values`);
    if (pa[k].description !== pb[k].description) minor.push(`"${k}" description reworded`);
  }
  for (const k of new Set([...Object.keys(before.annotations ?? {}), ...Object.keys(after.annotations ?? {})])) {
    const x = (before.annotations ?? {})[k], y = (after.annotations ?? {})[k];
    if (JSON.stringify(x) !== JSON.stringify(y)) important.push(`safety label ${k}: ${x === undefined ? 'unset' : JSON.stringify(x)} → ${y === undefined ? 'unset' : JSON.stringify(y)}`);
  }
  if ((before.description ?? '') !== (after.description ?? '')) {
    const was = words(before.description);
    const now = [...words(after.description)].filter((w) => !was.has(w));
    if (now.length) important.push(`description now says it ${now.map((w) => `"${w}"`).join(', ')}`);
    else minor.push('description reworded');
  }
  return { tool: after.name, important: important.length > 0, what: [...important, ...minor], diff };
}

export function diffTools(before: ToolDef[], after: ToolDef[]): ToolChange[] {
  const b = new Map(before.map((t) => [t.name, t]));
  const a = new Map(after.map((t) => [t.name, t]));
  const out: ToolChange[] = [];
  for (const t of after) if (!b.has(t.name)) out.push({ tool: t.name, important: true, what: ['new tool'], diff: lines(t).map((l) => `+ ${l}`).join('\n') });
  for (const t of before) if (!a.has(t.name)) out.push({ tool: t.name, important: true, what: ['tool removed: AI apps that use it will break'], diff: lines(t).map((l) => `- ${l}`).join('\n') });
  for (const t of after) {
    const old = b.get(t.name);
    const c = old && compareTool(old, t);
    if (c) out.push(c);
  }
  // Behavior changes first, then rewording; alphabetical within each.
  return out.sort((x, y) => Number(y.important) - Number(x.important) || x.tool.localeCompare(y.tool));
}

export function formatChanges(changes: ToolChange[], since: string): string {
  if (!changes.length) return `Tools unchanged since the last test (${since}).`;
  const important = changes.filter((c) => c.important).length;
  const L = [`Tools changed since the last test (${since}): ${changes.length} tool${changes.length === 1 ? '' : 's'}${important ? `, ${important} in ways that change what an AI does` : ', wording only'}`];
  for (const c of changes) {
    L.push(`  ${c.important ? '⚠️ ' : '· '} ${c.tool}: ${c.what.join('; ')}`);
    for (const d of c.diff.split('\n').slice(0, 12)) L.push(`       ${d}`);
    if (c.diff.split('\n').length > 12) L.push('       …');
  }
  return L.join('\n');
}

// --- memory between runs, on this computer only ---
const DIR = join('.qamcp', 'tools');
const fileFor = (server: string) => join(DIR, `${createHash('sha256').update(server).digest('hex').slice(0, 16)}.json`);

export function lastTools(server: string): { testedAt: string; tools: ToolDef[] } | undefined {
  try {
    const j = JSON.parse(readFileSync(fileFor(server), 'utf8'));
    return Array.isArray(j?.tools) ? j : undefined;
  } catch {
    return undefined;
  }
}

export function rememberTools(server: string, testedAt: string, tools: ToolDef[]): void {
  mkdirSync(DIR, { recursive: true });
  // The folder ignores itself, so nothing QAmcp keeps here can be committed by accident.
  const ignore = join('.qamcp', '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '# QAmcp keeps saved logins and tool history here. Never commit them.\n*\n');
  writeFileSync(fileFor(server), JSON.stringify({ server, testedAt, tools }, null, 1));
}
