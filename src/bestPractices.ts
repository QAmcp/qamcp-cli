// "Follows MCP best practices": tips from Anthropic's public guide for building MCP servers, checked as
// hard facts. Not scored yet (weight 0), so it never changes a server's score or fails a CI gate.

import type { Tool } from '@modelcontextprotocol/client';
import type { CheckResult, Finding, ToolCallRecord } from './types.js';

// An answer that is a JSON object or list, i.e. data a program could depend on.
const isJsonData = (text: string) => {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return false;
  try {
    return typeof JSON.parse(t) === 'object';
  } catch {
    return false;
  }
};

export const BEST_PRACTICES_ID = 'practices';
export const BEST_PRACTICES_TITLE = 'Follows MCP best practices (not scored yet)';

// One-word names that many servers use: next to another server's tools, the AI can't tell them apart.
const GENERIC = new Set(['search', 'fetch', 'get', 'list', 'query', 'run', 'execute', 'exec', 'read', 'write', 'create', 'update', 'delete', 'call', 'lookup', 'find', 'info', 'status', 'help', 'send', 'upload', 'download', 'open', 'save']);

// The tool list is sent to the AI with every message, so its size is a cost on every turn.
const BIG_TOOL_LIST = 40_000; // characters, roughly 10,000 tokens

type Style = 'snake_case' | 'camelCase' | 'kebab-case' | 'dot.case';
export function nameStyle(name: string): Style | undefined {
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) return 'snake_case';
  if (/^[a-z][a-z0-9]*([A-Z][a-z0-9]*)+$/.test(name)) return 'camelCase';
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name)) return 'kebab-case';
  if (/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/.test(name)) return 'dot.case';
  return undefined; // one word, or a mix: no style to compare
}

const list = (names: string[], max = 6) => names.slice(0, max).join(', ') + (names.length > max ? ` and ${names.length - max} more` : '');
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function bestPracticesCheck(tools: Tool[], calls: ToolCallRecord[] = []): CheckResult {
  const findings: Finding[] = [];

  // 1. Names
  const generic = tools.filter((t) => GENERIC.has(t.name.toLowerCase())).map((t) => t.name);
  if (generic.length)
    findings.push({ status: 'warn', message: `Very common tool ${generic.length === 1 ? 'name' : 'names'}: ${list(generic)}. Next to other servers' tools the AI may mix them up; a short prefix helps (like "github_search" instead of "search").` });
  const styles = new Map<Style, string[]>();
  for (const t of tools) {
    const s = nameStyle(t.name);
    if (s) styles.set(s, [...(styles.get(s) ?? []), t.name]);
  }
  if (styles.size > 1)
    findings.push({ status: 'warn', message: `Tool names mix styles: ${[...styles].map(([s, n]) => `${s} (${list(n, 3)})`).join(', ')}. One style makes them easier for the AI to guess.` });

  // 2. The two safety labels beyond read-only and dangerous
  const changing = tools.filter((t) => t.annotations?.readOnlyHint !== true);
  const noRepeat = changing.filter((t) => t.annotations?.idempotentHint === undefined).map((t) => t.name);
  if (noRepeat.length)
    findings.push({ status: 'warn', message: `${plural(noRepeat.length, 'tool')} not labeled read-only ${noRepeat.length === 1 ? "doesn't" : "don't"} say whether running ${noRepeat.length === 1 ? 'it' : 'them'} twice is safe (idempotentHint): ${list(noRepeat)}` });
  const noWorld = tools.filter((t) => t.annotations?.openWorldHint === undefined).map((t) => t.name);
  if (noWorld.length)
    findings.push({ status: 'warn', message: `${plural(noWorld.length, 'tool')} ${noWorld.length === 1 ? "doesn't" : "don't"} say whether ${noWorld.length === 1 ? 'it reaches' : 'they reach'} outside services like the web (openWorldHint): ${list(noWorld)}` });

  // 3. Size of the tool list
  const size = JSON.stringify(tools).length;
  if (size > BIG_TOOL_LIST)
    findings.push({ status: 'warn', message: `The tool list is about ${Math.round(size / 1000)} KB (roughly ${Math.round(size / 4000)}k tokens). AI apps send it with every message, so it takes that much of the AI's memory before any work starts.` });

  // 4. Structured answers with no declared shape: if they change, nothing can notice (we check every
  //    answer against an outputSchema when there is one).
  const declared = new Set(tools.filter((t) => (t as any).outputSchema).map((t) => t.name));
  const undeclared = [...new Set(calls.filter((c) => c.kind === 'good-input' && c.outcome === 'ok' && !declared.has(c.tool) && isJsonData(c.text)).map((c) => c.tool))];
  if (undeclared.length)
    findings.push({ status: 'warn', message: `${plural(undeclared.length, 'tool')} ${undeclared.length === 1 ? 'answers' : 'answer'} with structured data but ${undeclared.length === 1 ? "doesn't" : "don't"} declare its shape (outputSchema): ${list(undeclared)}. If those answers change shape, nothing can catch it; with a schema, every answer is checked.` });

  if (!findings.length) findings.push({ status: 'pass', message: 'Tool names, safety labels and tool list size follow the MCP guide' });
  const status = findings.some((f) => f.status === 'warn') ? 'warn' : 'pass';
  const warns = findings.filter((f) => f.status === 'warn').length;
  return { id: BEST_PRACTICES_ID, title: BEST_PRACTICES_TITLE, status, summary: status === 'pass' ? 'All good' : `${plural(warns, 'tip')} (not scored)`, findings, weight: 0 };
}
