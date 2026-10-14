// Resources (data an AI can read) and prompts (ready-made instructions a person picks, like
// /commands). Everything here is a hard fact: does it list, does it open, is the content what
// it says it is, are your inputs used, do mistakes get a clean error. No AI involved.
//
// Reading a resource or fetching a prompt can't change anything (the MCP spec defines both as
// reads), so this is safe on any server. We sample when there are many.

import { randomBytes } from 'node:crypto';
import { ProtocolError, SdkError, SdkErrorCode, UriTemplate, type Client } from '@modelcontextprotocol/client';
import { allMatches, firstMatch, HIDDEN_INSTRUCTION_PATTERNS, INTERNAL_PATTERNS, SECRET_PATTERNS } from './patterns.js';
import type { CheckResult, Finding, Status } from './types.js';

export const RESOURCE_CHECK_TITLE = 'Resources and prompts work';
const MAX_READS = 10;
const MAX_TEMPLATES = 5;
const MAX_PROMPTS = 10;
const MAX_PAGES = 5;
const SLOW_MS = 2_000;
const INTERNAL_ERROR = -32603;

// Descriptions: the same tricks as in tool descriptions, except that mentioning a secrets file
// only counts with an action ("read ~/.ssh/id_rsa"). A file that is simply named ".env.example"
// is not a trick (real Hugging Face case).
const ASKS_FOR_SECRETS = { name: 'asks the AI to read SSH keys or .env files', re: /\b(?:read|send|include|upload|attach|cat|open|copy|paste|share)\b[^.\n]{0,40}(?:~\/\.ssh|id_rsa|\.env\b|credentials\.json)/i };
const DESC_PATTERNS = [...HIDDEN_INSTRUCTION_PATTERNS.filter((p) => !/SSH keys/.test(p.name)), ASKS_FOR_SECRETS];
// Content (documents, code, web pages, other languages) is noisier: only the unmistakable tricks.
// Not ".env" (code says "c.env.TOKEN", real Cloudflare case) and not ordinary zero-width characters
// (written Persian uses them, real OpenZeppelin case); only the invisible "tag" characters that
// exist to smuggle hidden text.
const CONTENT_PATTERNS = [
  ...HIDDEN_INSTRUCTION_PATTERNS.filter((p) => /ignore previous|IMPORTANT|tell the user/i.test(p.name)),
  { name: 'invisible tag characters (a way to hide text from people)', re: /[\u{E0000}-\u{E007F}]/u },
];

export interface ResourcePromptStats {
  resources: number;
  templates: number;
  prompts: number;
  read: number;
  opened: number;
}

// Returns null when the server offers neither (then this check doesn't exist for it).
export async function checkResourcesAndPrompts(client: Client, timeoutMs: number): Promise<{ check: CheckResult; stats: ResourcePromptStats } | null> {
  const caps = client.getServerCapabilities() ?? {};
  if (!caps.resources && !caps.prompts) return null;

  const findings: Finding[] = [];
  const add = (status: Status, message: string, tool?: string) => findings.push({ status, message, ...(tool ? { tool } : {}) });
  const stats: ResourcePromptStats = { resources: 0, templates: 0, prompts: 0, read: 0, opened: 0 };
  const opts = { timeout: timeoutMs };

  // ---------- resources ----------
  if (caps.resources) {
    let resources: any[] = [];
    let templates: any[] = [];
    try {
      resources = await listAll((cursor) => client.listResources(cursor ? { cursor } : undefined, opts), 'resources');
    } catch (err) {
      add('fail', `Says it has resources, but listing them failed: ${errShort(err)}`);
    }
    try {
      templates = await listAll((cursor) => client.listResourceTemplates(cursor ? { cursor } : undefined, opts), 'resourceTemplates');
    } catch (err) {
      // Templates are optional: "method not found" just means none.
      if (!isMethodNotFound(err)) add('warn', `Listing resource templates failed: ${errShort(err)}`);
    }
    stats.resources = resources.length;
    stats.templates = templates.length;

    // The list itself.
    const badEntries = resources.filter((r) => typeof r?.uri !== 'string' || !/^[a-z][a-z0-9+.-]*:/i.test(r.uri) || typeof r?.name !== 'string' || !r.name);
    if (badEntries.length) add('fail', `${badEntries.length} listed resource${badEntries.length === 1 ? ' is' : 's are'} missing a valid address or name, so AI apps can't show or open ${badEntries.length === 1 ? 'it' : 'them'}.`);
    const seen = new Map<string, number>();
    for (const r of resources) if (typeof r?.uri === 'string') seen.set(r.uri, (seen.get(r.uri) ?? 0) + 1);
    const dupes = [...seen].filter(([, n]) => n > 1).map(([u]) => u);
    if (dupes.length) add('warn', `The same resource is listed more than once: ${dupes.slice(0, 3).join(', ')}${dupes.length > 3 ? '…' : ''}`);
    const undescribed = resources.filter((r) => typeof r?.uri === 'string' && !r.description && !r.title);
    if (undescribed.length && resources.length) add('warn', `${undescribed.length} of ${resources.length} resources have no description, so people can't tell what they contain.`);
    for (const r of [...resources, ...templates]) {
      const hit = firstMatch([r?.title, r?.description].filter(Boolean).join('\n'), DESC_PATTERNS);
      if (hit) add('fail', `Resource description contains ${hit}. This is a known trick to make AI do things the user didn't ask for.`, r.uri ?? r.uriTemplate);
    }

    // Open each one (a sample when there are many).
    const sample = resources.filter((r) => typeof r?.uri === 'string').slice(0, MAX_READS);
    let slowest = { uri: '', ms: 0 };
    let readOk = 0;
    for (const r of sample) {
      stats.read++;
      const t0 = Date.now();
      try {
        const res: any = await client.readResource({ uri: r.uri }, opts);
        const ms = Date.now() - t0;
        if (ms > slowest.ms) slowest = { uri: r.uri, ms };
        const contents: any[] = Array.isArray(res?.contents) ? res.contents : [];
        const withData = contents.filter((c) => (typeof c?.text === 'string' && c.text.length) || (typeof c?.blob === 'string' && c.blob.length));
        if (!withData.length) {
          add('warn', 'Listed, but opening it returns nothing.', r.uri);
          continue;
        }
        readOk++;
        const declared = r.mimeType ?? contents[0]?.mimeType;
        const text = withData.map((c) => c.text ?? '').join('\n');
        if (/json/i.test(declared ?? '') && withData[0].text !== undefined && !parsesAsJson(withData[0].text)) add('warn', `Says it is ${declared}, but the content is not valid JSON.`, r.uri);
        const hidden = firstMatch(text.slice(0, 200_000), CONTENT_PATTERNS);
        // Content can come from anywhere (docs, user data), so this is a warning, not proof of bad intent.
        if (hidden) add('warn', `The content contains ${hidden}. If an AI reads this, it may follow it. Check where this text comes from.`, r.uri);
      } catch (err) {
        if (isTimeout(err)) add('fail', 'Listed, but opening it never answered.', r.uri);
        else if (code(err) === INTERNAL_ERROR) add('fail', `Listed, but opening it crashed: ${errShort(err)}`, r.uri);
        else if (isInvalidReply(err)) add('fail', `Its reply breaks the MCP rules, so AI apps reject it: ${plainInvalid(err)}`, r.uri);
        else add('fail', `Listed, but opening it fails: ${errShort(err)}`, r.uri);
        leakFindings(errText(err), r.uri, add);
      }
    }
    if (sample.length) {
      const of = resources.length > sample.length ? ` (a sample of ${sample.length} of ${resources.length})` : '';
      add(readOk === sample.length ? 'pass' : 'warn', `Opened ${readOk} of ${sample.length} resources${of}`);
      if (slowest.ms > SLOW_MS) add('warn', `Slowest resource took ${(slowest.ms / 1000).toFixed(1)} s to open`, slowest.uri);
    }

    // Templates: fill in a value and open it. "Not found" is a fine answer; crashing or hanging isn't.
    for (const t of templates.filter((t) => typeof t?.uriTemplate === 'string').slice(0, MAX_TEMPLATES)) {
      let uri: string;
      try {
        const tpl = new UriTemplate(t.uriTemplate);
        uri = tpl.expand(Object.fromEntries(tpl.variableNames.map((v) => [v, 'qamcp-test'])));
      } catch {
        add('fail', `The address pattern "${t.uriTemplate}" is not a valid URI template.`, t.uriTemplate);
        continue;
      }
      try {
        await client.readResource({ uri }, opts);
        add('pass', `Filling in the pattern and opening it works (${uri})`, t.uriTemplate);
      } catch (err) {
        if (isTimeout(err)) add('fail', `Opening a filled-in address (${uri}) never answered.`, t.uriTemplate);
        else if (code(err) === INTERNAL_ERROR) add('warn', `A made-up value (${uri}) gets an internal error instead of a clean "not found": ${errShort(err)}`, t.uriTemplate);
        else add('pass', `A made-up value gets a clean error (${uri})`, t.uriTemplate);
        leakFindings(errText(err), t.uriTemplate, add);
      }
    }

    // An address that can't exist must get a clean "not found", not content or a crash.
    if (resources.length || templates.length) {
      const scheme = (resources[0]?.uri ?? 'qamcp:').split(':')[0] || 'qamcp';
      const missing = `${scheme}://qamcp-does-not-exist-${randomBytes(4).toString('hex')}`;
      try {
        const res: any = await client.readResource({ uri: missing }, opts);
        const has = (res?.contents ?? []).some((c: any) => c?.text || c?.blob);
        if (has) add('warn', `Opening an address that doesn't exist (${missing}) returns content instead of a "not found" error, so AI apps can't tell a typo from real data.`);
        else add('pass', 'An address that does not exist gets an empty answer, not a crash');
      } catch (err) {
        if (isTimeout(err)) add('fail', `Opening an address that doesn't exist never answered (${missing}).`);
        else if (code(err) === INTERNAL_ERROR) add('warn', `Opening an address that doesn't exist crashes the request instead of saying "not found": ${errShort(err)}`);
        else add('pass', 'An address that does not exist gets a clean "not found" error');
        leakFindings(errText(err), missing, add);
      }
    }
  }

  // ---------- prompts ----------
  if (caps.prompts) {
    let prompts: any[] = [];
    try {
      prompts = await listAll((cursor) => client.listPrompts(cursor ? { cursor } : undefined, opts), 'prompts');
    } catch (err) {
      add('fail', `Says it has prompts, but listing them failed: ${errShort(err)}`);
    }
    stats.prompts = prompts.length;

    const unnamed = prompts.filter((p) => typeof p?.name !== 'string' || !p.name);
    if (unnamed.length) add('fail', `${unnamed.length} listed prompt${unnamed.length === 1 ? ' has' : 's have'} no name, so nobody can pick ${unnamed.length === 1 ? 'it' : 'them'}.`);
    for (const p of prompts.filter((p) => p?.name)) {
      if (!p.description && !p.title) add('warn', 'Prompt has no description, so people can\'t tell what it does.', p.name);
      const noDesc = (p.arguments ?? []).filter((a: any) => !a?.description).map((a: any) => a?.name);
      if (noDesc.length) add('warn', `Inputs with no description: ${noDesc.join(', ')}`, p.name);
      const hit = firstMatch([p.title, p.description, ...(p.arguments ?? []).map((a: any) => a?.description)].filter(Boolean).join('\n'), DESC_PATTERNS);
      if (hit) add('fail', `Prompt description contains ${hit}. This is a known trick to make AI do things the user didn't ask for.`, p.name);
    }

    let openedOk = 0;
    const sample = prompts.filter((p) => p?.name).slice(0, MAX_PROMPTS);
    for (const p of sample) {
      const args: { name: string; required?: boolean }[] = (p.arguments ?? []).filter((a: any) => typeof a?.name === 'string');
      // A made-up word per input, so we can see whether each one ends up in the text.
      const canary = Object.fromEntries(args.map((a, i) => [a.name, `zq7test${i}${randomBytes(2).toString('hex')}`]));
      try {
        const res: any = await client.getPrompt({ name: p.name, arguments: canary }, opts);
        const messages: any[] = Array.isArray(res?.messages) ? res.messages : [];
        if (!messages.length) {
          add('warn', 'Opens, but returns no messages.', p.name);
          continue;
        }
        const badRole = messages.filter((m) => m?.role !== 'user' && m?.role !== 'assistant');
        if (badRole.length) add('fail', `Returns messages with a role AI apps don't accept ("${badRole[0]?.role}"); only "user" and "assistant" are allowed.`, p.name);
        openedOk++;
        stats.opened++;
        const text = JSON.stringify(messages);
        // A placeholder left unfilled, like "Hello {name}", is a plain bug (and reported once, as that).
        const left = args.filter((a) => new RegExp(`\\{\\{?\\s*${escapeRe(a.name)}\\s*\\}?\\}|\\$\\{${escapeRe(a.name)}\\}`).test(text)).map((a) => a.name);
        if (left.length) add('fail', `Leaves the placeholder for ${left.join(', ')} unfilled in the text (it shows "{${left[0]}}" instead of your value).`, p.name);
        const unused = args.filter((a) => !text.includes(canary[a.name]) && !left.includes(a.name));
        if (unused.length === args.length && args.length) add('warn', `Ignores ${args.length === 1 ? 'its input' : 'all its inputs'} (${unused.map((a) => a.name).join(', ')}): what you type never appears in the result. Check the input is actually used.`, p.name);
        else if (unused.length) add('warn', `Never uses the input${unused.length === 1 ? '' : 's'} ${unused.map((a) => a.name).join(', ')}: what you type there doesn't appear in the result.`, p.name);
        const hidden = firstMatch(text, CONTENT_PATTERNS);
        if (hidden) add('warn', `The prompt text contains ${hidden}. Check this is meant to be there.`, p.name);
      } catch (err) {
        if (isTimeout(err)) add('fail', 'Opening it never answered.', p.name);
        // With inputs, our sample values may simply be wrong for it: then it's the kind of error that's off, not a crash.
        else if (code(err) === INTERNAL_ERROR && args.length) add('warn', `Our sample inputs get an internal error instead of an "invalid input" error: ${errShort(err)}`, p.name);
        else if (code(err) === INTERNAL_ERROR) add('fail', `Opening it crashed: ${errShort(err)}`, p.name);
        else if (isInvalidReply(err)) add('fail', `Its reply breaks the MCP rules, so AI apps reject it: ${plainInvalid(err)}`, p.name);
        else add('warn', `Could not open it with sample inputs: ${errShort(err)}`, p.name);
        leakFindings(errText(err), p.name, add);
        continue;
      }

      // Leaving out a required input must give a clean error, not a broken prompt.
      const required = args.filter((a) => a.required);
      if (!required.length) continue;
      try {
        await client.getPrompt({ name: p.name, arguments: {} }, opts);
        add('warn', `Doesn't complain when the required input ${required.map((a) => a.name).join(', ')} is missing.`, p.name);
      } catch (err) {
        if (isTimeout(err)) add('fail', 'Leaving out a required input makes it hang.', p.name);
        else if (code(err) === INTERNAL_ERROR) add('warn', `Leaving out a required input gets an internal error instead of an "invalid input" error: ${errShort(err)}`, p.name);
        leakFindings(errText(err), p.name, add);
      }
    }
    if (sample.length) {
      const of = prompts.length > sample.length ? ` (a sample of ${sample.length} of ${prompts.length})` : '';
      add(openedOk === sample.length ? 'pass' : 'warn', `Opened ${openedOk} of ${sample.length} prompts${of}`);
    }
  }

  if (!stats.resources && !stats.templates && !stats.prompts && !findings.length) return null; // capability declared, nothing offered
  if (!findings.length) findings.push({ status: 'pass', message: 'All good' });
  const status: Status = findings.some((f) => f.status === 'fail') ? 'fail' : findings.some((f) => f.status === 'warn') ? 'warn' : 'pass';
  const counts = [stats.resources && `${stats.resources} resource${stats.resources === 1 ? '' : 's'}`, stats.templates && `${stats.templates} template${stats.templates === 1 ? '' : 's'}`, stats.prompts && `${stats.prompts} prompt${stats.prompts === 1 ? '' : 's'}`].filter(Boolean).join(', ');
  const nFail = findings.filter((f) => f.status === 'fail').length;
  const nWarn = findings.filter((f) => f.status === 'warn').length;
  const summary = status === 'pass' ? `All good (${counts})` : [nFail && `${nFail} failed`, nWarn && `${nWarn} warning${nWarn === 1 ? '' : 's'}`].filter(Boolean).join(', ') + ` (${counts})`;
  return { check: { id: 'resources', title: RESOURCE_CHECK_TITLE, status, summary, weight: 10, findings }, stats };
}

// ---------- helpers ----------

async function listAll(page: (cursor?: string) => Promise<any>, key: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await page(cursor);
    if (Array.isArray(res?.[key])) out.push(...res[key]);
    cursor = res?.nextCursor;
    if (!cursor) break;
  }
  return out;
}

function leakFindings(text: string, where: string, add: (s: Status, m: string, t?: string) => void) {
  const secret = firstMatch(text, SECRET_PATTERNS);
  if (secret) add('fail', `Error message shows what looks like ${/^[aeiou]/i.test(secret) ? 'an' : 'a'} ${secret}`, where);
  const internal = allMatches(text, INTERNAL_PATTERNS);
  if (internal.length) add('warn', `Error message shows internal details: ${internal.join(', ')}`, where);
}

const code = (err: unknown): number | undefined => (err instanceof ProtocolError ? (err as any).code : (err as any)?.code);
const isTimeout = (err: unknown) => err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout;
const isMethodNotFound = (err: unknown) => code(err) === -32601;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const errShort = (err: unknown) => {
  const t = errText(err).replace(/\s+/g, ' ').trim();
  return t.length > 140 ? t.slice(0, 139) + '…' : t || '(no message)';
};
// The SDK refuses replies that break the MCP rules ("Invalid result for prompts/get: [...]").
const isInvalidReply = (err: unknown) => /Invalid result for/i.test(errText(err));
function plainInvalid(err: unknown): string {
  const t = errText(err);
  if (/"user",\s*"assistant"/.test(t) && /role/.test(t)) return 'a message uses a role other than "user" or "assistant".';
  const path = t.match(/"path":\s*\[([^\]]*)\]/)?.[1]?.replace(/[\s"]/g, '').replace(/,/g, '.');
  const msg = t.match(/"message":\s*"([^"]+)"/)?.[1];
  return [msg, path && `(at ${path})`].filter(Boolean).join(' ') || errShort(err);
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
