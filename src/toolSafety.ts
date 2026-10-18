import type { Tool } from '@modelcontextprotocol/client';

// Decides whether we may call a tool on someone's live server.
// We only call tools that cannot change anything. By default that means tools the
// server labels read-only (and that don't contradict the label). Unlabeled tools are
// treated as possibly dangerous, as the MCP spec says, unless the owner allows more.

export type RunReason = 'labeled read-only' | 'name says read-only' | 'owner allowed';

export type RunDecision =
  | { run: true; why: RunReason }
  | { run: false; why: string };

const READ_WORDS = new Set([
  'get', 'list', 'search', 'find', 'read', 'fetch', 'query', 'lookup', 'ask', 'describe', 'show', 'view',
  'check', 'resolve', 'match', 'count', 'browse', 'inspect', 'retrieve', 'explain', 'status', 'info',
]);

const WRITE_WORDS = new Set([
  // deletes or wipes
  'delete', 'remove', 'drop', 'destroy', 'purge', 'erase', 'wipe', 'truncate', 'terminate', 'revoke', 'reset', 'kill', 'clear',
  // creates or changes
  'create', 'add', 'insert', 'new', 'update', 'edit', 'modify', 'set', 'put', 'patch', 'write', 'save', 'upload', 'import',
  'rename', 'move', 'copy', 'archive', 'restore', 'merge', 'push', 'commit', 'sync', 'assign', 'enable', 'disable', 'toggle',
  'install', 'uninstall', 'register', 'apply', 'mark', 'tag', 'label', 'close', 'open', 'lock', 'unlock',
  // sends or triggers
  'send', 'post', 'submit', 'publish', 'notify', 'email', 'message', 'reply', 'comment', 'invite', 'share', 'like', 'follow',
  'run', 'execute', 'exec', 'invoke', 'trigger', 'start', 'stop', 'cancel', 'deploy', 'launch', 'schedule', 'approve', 'reject',
  // money
  'pay', 'charge', 'refund', 'transfer', 'buy', 'purchase', 'order', 'book', 'checkout', 'subscribe', 'withdraw', 'deposit',
  // accounts
  'login', 'logout', 'signup', 'signin', 'auth', 'grant',
]);

const DESTRUCTIVE_WORDS = new Set(['delete', 'remove', 'drop', 'destroy', 'purge', 'erase', 'wipe', 'truncate', 'terminate', 'revoke', 'reset', 'kill']);

// A description saying what the tool itself does ("Sends an email…", "Deletes the file…").
// Only the "-s" form counts: "the code you want to send to the user" is advice to the AI,
// not something the tool does.
const WRITE_VERB = /\b(?:creates|deletes|removes|modifies|overwrites|sends|submits|publishes|executes|charges|transfers|uploads|writes to|saves to)\b/i;
// Words that mean "changes something for good", wherever they appear.
const PERMANENT = /\b(?:permanently|irreversibl[ey]|cannot be undone)\b/i;

// strict: only the first sentence counts (used before accusing a labeled tool of lying).
function writePhraseIn(description: string, strict: boolean): string | undefined {
  const text = strict ? description.split(/(?<=[.!?])\s/)[0] : description;
  return text.match(WRITE_VERB)?.[0] ?? description.match(PERMANENT)?.[0];
}

// Splits snake_case, kebab-case, dot.case and camelCase names into lowercase words.
export function nameWords(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function looksDestructive(toolName: string): boolean {
  return nameWords(toolName).some((w) => DESTRUCTIVE_WORDS.has(w));
}

// Input names that only make sense for a tool that sends or changes something.
const WRITE_INPUTS = new Set(['body', 'recipient', 'recipients', 'cc', 'bcc', 'amount', 'price', 'password', 'payload']);

// The first sign that a tool changes something, from its name, description or inputs. Undefined if none.
// strict = only read the description's first sentence (fewer false alarms).
export function writeSignal(tool: Tool, strict = false): string | undefined {
  // Strict: only the verb counts. "send_email" starts with a write word, but
  // "estimate_move_to_dubai" or "get_start_path" just contain one.
  const words = nameWords(tool.name);
  const writeWord = strict ? (WRITE_WORDS.has(words[0]) ? words[0] : undefined) : words.find((w) => WRITE_WORDS.has(w));
  if (writeWord) return strict ? `name starts with "${writeWord}"` : `name contains "${writeWord}"`;
  const writePhrase = writePhraseIn(tool.description ?? '', strict);
  if (writePhrase) return `description says "${writePhrase}"`;
  const props = Object.keys((tool.inputSchema as any)?.properties ?? {});
  const writeInput = props.find((p) => WRITE_INPUTS.has(p.toLowerCase()));
  if (writeInput) return `has a "${writeInput}" input`;
  return undefined;
}

// Strong enough evidence to SAY a read-only label is wrong (it goes in reports and in
// messages to the owner): the name starts with a write verb AND the description or the
// inputs also say it changes something. One signal alone only means we don't run the tool.
// ("create_bag_link" builds a link, which is read-only: name alone is not proof.)
export function labelContradiction(tool: Tool): string | undefined {
  if (tool.annotations?.readOnlyHint !== true) return undefined;
  const words = nameWords(tool.name);
  if (!WRITE_WORDS.has(words[0])) return undefined;
  const phrase = writePhraseIn(tool.description ?? '', false);
  const props = Object.keys((tool.inputSchema as any)?.properties ?? {});
  const input = props.find((p) => WRITE_INPUTS.has(p.toLowerCase()));
  if (phrase) return `name starts with "${words[0]}" and its description says "${phrase}"`;
  if (input) return `name starts with "${words[0]}" and it has a "${input}" input`;
  return undefined;
}

// How much we may run, set by the person testing:
//   'labeled' (default): only tools the server labels read-only. The MCP spec says an
//                        unlabeled tool must be treated as possibly dangerous.
//   'owner':  also unlabeled tools that clearly only read. Only for someone who owns the server.
//   'all':    every tool that isn't labeled or named dangerous. Owner's own risk.
// 'none' (look-only) calls no tools at all: for servers you don't trust, since a label is only the server's word.
export type SafetyMode = 'none' | 'labeled' | 'owner' | 'all';

export function decideRun(tool: Tool, mode: SafetyMode): RunDecision {
  if (mode === 'none') return { run: false, why: 'look-only mode: no tools are called' };
  const a = tool.annotations;
  if (a?.destructiveHint === true) return { run: false, why: 'labeled dangerous' };
  if (looksDestructive(tool.name)) return { run: false, why: 'name sounds like it deletes something' };
  if (a?.readOnlyHint === false) return { run: false, why: 'labeled as changing data' };
  // The spec says such a tool MUST be called as a task; a normal call is refused by design.
  if ((tool as any).execution?.taskSupport === 'required') return { run: false, why: 'can only run as a background task (task mode), which QAmcp does not test yet' };
  if (mode === 'all') return { run: true, why: a?.readOnlyHint === true ? 'labeled read-only' : 'owner allowed' };

  if (a?.readOnlyHint === true) {
    // Labels are only hints from the server. If the tool clearly says it writes, believe that.
    const contradiction = writeSignal(tool, true);
    if (contradiction) return { run: false, why: `labeled read-only, but its ${contradiction}, which usually means it changes something. Skipped to be safe: if it only reads, a clearer ${contradiction.startsWith('name') ? 'name' : 'description'} helps AI apps too, or test again with --owner` };
    return { run: true, why: 'labeled read-only' };
  }
  if (mode === 'labeled') return { run: false, why: 'no safety label (if you own this server, test again in owner mode)' };
  // Guessing without a label: read the whole description, stay cautious.
  const signal = writeSignal(tool);
  if (signal) return { run: false, why: `${signal}, so it might change data` };
  if (!nameWords(tool.name).some((w) => READ_WORDS.has(w))) return { run: false, why: "no label, and the name doesn't say it only reads" };
  return { run: true, why: 'name says read-only' };
}
