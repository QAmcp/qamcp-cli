// Fixed text patterns. A match is a hard fact ("this text is in the response"),
// not an opinion.

export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'API key (sk-...)', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'login token (JWT)', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'database password in a link', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/]+:[^@\s]+@/i },
];

// A key in a normal answer, leaving out what is plainly a placeholder (sk-xxxxxxxx, sk-your-key-here).
const PLACEHOLDER = /x{4,}|\*{3,}|your|example|placeholder|redacted|sample/i;
export function realSecret(text: string): string | undefined {
  for (const { name, re } of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m && !PLACEHOLDER.test(m[0])) return name;
  }
  return undefined;
}

// Internal details that should not show up in error messages.
export const INTERNAL_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'code stack trace', re: /\n\s+at [^\n]+\(?[^\s()]+:\d+:\d+\)?/ },
  { name: 'Python stack trace', re: /Traceback \(most recent call last\)/ },
  // A path on the server's own disk. The lookbehind skips web links like https://site.com/app/.
  { name: 'server file path', re: /(?<![\w.:\/-])(?:\/(?:home|root|srv|opt|etc|app|var\/(?:www|lib|log)|usr\/(?:src|local))\/[\w.\/-]+|[A-Z]:\\[\w .\\-]+)/ },
  { name: 'secrets file name', re: /(?:^|[\s"'\/\\(])(?:\.env(?:\.\w+)?|secrets?\.(?:env|json|ya?ml)|credentials\.json|id_rsa)\b/i },
];

// Every pattern that matches, not only the first.
export function allMatches(text: string, patterns: { name: string; re: RegExp }[]): string[] {
  return patterns.filter((p) => p.re.test(text)).map((p) => p.name);
}

const SECRET_FILE = String.raw`(?:~\/\.ssh|id_rsa|\.env\b|credentials\.json)`;
const SEND = String.raw`\b(?:pass|send|include|upload|attach|paste|share|provide|forward|post|give)\b`;
const SECRET_EXFIL = new RegExp(`${SECRET_FILE}[^\n]{0,80}?${SEND}|${SEND}[^\n]{0,80}?${SECRET_FILE}`, 'i');
const INVISIBLE = /[\u{E0000}-\u{E007F}]|[\u202A-\u202E\u2066-\u2069]|[\u200B\u2060-\u2064]|(?<=\S)\uFEFF|(?<=[A-Za-z])[\u200C\u200D](?=[A-Za-z])/u;

// Text in a tool description that tries to steer the AI behind the user's back.
export const HIDDEN_INSTRUCTION_PATTERNS: { name: string; re: RegExp }[] = [
  { name: '"ignore previous instructions"', re: /\bignore (?:all |any )?(?:previous|prior|above|earlier) instructions\b/i },
  { name: 'hidden <IMPORTANT> block', re: /<\s*important\s*>/i },
  { name: '"don\'t tell the user"', re: /(?:do not|don't|never) (?:tell|mention|inform|reveal|show)\b[^.]{0,30}\b(?:the|your) user\b/i },
  // Asking the AI to pass a secrets file somewhere. Merely naming .env or ~/.ssh is not a trick:
  // developer tools do that all the time ("list the names in your .env file").
  { name: 'asks the AI to send secrets (SSH keys, .env files)', re: SECRET_EXFIL },
  // Characters that hide text from people. Not the joiners that emoji and many scripts need
  // (👨‍👩‍👧, Persian, Hindi): only tag characters, direction overrides, and zero-width
  // characters wedged inside English words.
  { name: 'invisible characters', re: INVISIBLE },
];

// Wider wordings. On real servers these also match honest text ("Never tell a user a name is clear unless..."),
// so they only ask a person to read the sentence. They never fail a server or cap its score.
export const HIDDEN_WEAK_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'text telling the AI to set its rules aside', re: /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|of\s+)*(?:the\s+|your\s+|these\s+)?(?:previous|prior|above|earlier|other|preceding|system|original)\s+(?:\w+\s+)?(?:instructions?|guidance|guidelines|rules|directions|prompts?|context)\b|\bforget (?:what|everything) you (?:were|have been|'ve been) told\b|\bignore the instructions\b/i },
  { name: 'text about keeping something from the person', re: /(?:do not|don't|never) (?:tell|mention|inform|reveal|show)[^.]{0,30}\buser\b|\b(?:hide|conceal|keep)\b[^.\n]{0,40}\bfrom (?:the |your )?(?:user|person|human|customer)\b|\bkeep this (?:a )?secret\b|\bwithout (?:mentioning|telling|informing|notifying|alerting)\b[^.\n]{0,30}\b(?:it|this|the user|them)\b/i },
  { name: 'text that looks like a system message', re: /<\s*\/?\s*system\s*>|\[\s*(?:system|inst)\s*\]|\bnew instructions\s*:|\byou are now (?:in |an? )?(?:admin|root|developer|dan|unrestricted|jailbroken)\b|\bpretend (?:that )?you are\b/i },
  { name: 'text about doing something silently', re: /\bsilently (?:include|add|send|forward|read|call|pass|run|attach|copy|upload|post)\b/i },
  { name: 'text about sending the conversation or keys', re: /(?<!\b(?:never|not|don't|avoid|without)\s)\b(?:send|forward|include|pass|post|upload|attach|copy|bcc)\b[^.\n]{0,50}\b(?:conversation history|chat history|every message|all messages|system prompt)\b|\b(?:reveal|print|show|repeat|output)\b[^.\n]{0,20}\b(?:your|the) (?:system prompt|hidden rules|hidden instructions)\b/i },
  { name: 'text about reading credentials', re: /\bread\b[^.\n]{0,40}(?:\.aws\/credentials|id_rsa|\.cursor\/mcp\.json|\.npmrc)/i },
  { name: 'text about taking over from other tools', re: /\binstead of (?:all|any|every) (?:other|of the other) tools\b|\boverrides? the (?:behaviou?r|instructions|description) of\b|\b(?:all|any) other tools\b[^.\n]{0,30}\b(?:ignored?|disabled?|must not)\b/i },
];

// The tool name rule from the MCP spec: 1-128 characters, letters, digits, _ - .
export const VALID_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

export function firstMatch(text: string, patterns: { name: string; re: RegExp }[]): string | undefined {
  return patterns.find((p) => p.re.test(text))?.name;
}

// The exact words around the first match, so a person can read what the AI reads. Whole sentence where
// there is one, on one line, cut at about 200 characters.
export function quoteOf(text: string, patterns: { re: RegExp }[], max = 200): string | undefined {
  for (const { re } of patterns) {
    const m = new RegExp(re.source, re.flags.replace('g', '')).exec(text);
    if (!m) continue;
    // A sentence ends at a mark followed by a space, so "~/.ssh/id_rsa" stays whole.
    const ends = [...text.slice(0, m.index).matchAll(/[.!?]\s|\n/g)];
    const start = ends.length ? ends[ends.length - 1].index + ends[ends.length - 1][0].length : 0;
    const rest = text.slice(m.index + m[0].length);
    const stop = rest.search(/[.!?](?:\s|$)/);
    const end = stop === -1 ? text.length : m.index + m[0].length + stop + 1;
    const q = text.slice(Math.max(start, m.index - max), end).replace(/\s+/g, ' ').trim();
    return q.length > max ? `${q.slice(0, max).trimEnd()}…` : q;
  }
  return undefined;
}
