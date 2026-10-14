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

// Text in a tool description that tries to steer the AI behind the user's back.
export const HIDDEN_INSTRUCTION_PATTERNS: { name: string; re: RegExp }[] = [
  { name: '"ignore previous instructions"', re: /ignore (?:all |any )?(?:previous|prior|above|earlier) instructions/i },
  { name: 'hidden <IMPORTANT> block', re: /<\s*important\s*>/i },
  { name: '"don\'t tell the user"', re: /(?:do not|don't|never) (?:tell|mention|inform|reveal|show)[^.]{0,30}\buser\b/i },
  { name: 'asks for SSH keys or .env files', re: /(?:~\/\.ssh|id_rsa|\.env\b|credentials\.json)/i },
  { name: 'invisible characters', re: /[​-‏‪-‮⁠-⁤﻿]|[\u{E0000}-\u{E007F}]/u },
];

// The tool name rule from the MCP spec: 1-128 characters, letters, digits, _ - .
export const VALID_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

export function firstMatch(text: string, patterns: { name: string; re: RegExp }[]): string | undefined {
  return patterns.find((p) => p.re.test(text))?.name;
}
