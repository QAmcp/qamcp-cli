// `qamcp --install-hook`: test your MCP server on every `git commit`, and stop the commit when the
// score falls below the line you chose. The hook lives between two marker lines, so installing
// again replaces QAmcp's part and leaves anything else in the hook alone.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const START = '# >>> qamcp pre-commit check (installed by: npx qamcp-cli --install-hook)';
const END = '# <<< qamcp pre-commit check';

// Wraps a value in single quotes for sh, so a server link or command is passed exactly as typed.
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface HookTarget {
  url?: string; // a server on the internet (or on this computer at a localhost link)
  stdio?: string; // or the command that starts the server, e.g. "npm start"
  failUnder: number;
}

export function hookBlock(t: HookTarget): string {
  const what = t.stdio ? `--stdio ${shQuote(t.stdio)}` : shQuote(t.url!);
  return [
    START,
    'echo "QAmcp: testing your MCP server before this commit..."',
    `if ! npx -y qamcp-cli ${what} --fail-under ${t.failUnder}; then`,
    `  echo "QAmcp: the score is below ${t.failUnder} or the server could not be tested, so the commit was stopped."`,
    '  echo "Fix what the report shows, or skip this check once with: git commit --no-verify"',
    '  exit 1',
    'fi',
    END,
  ].join('\n');
}

// Adds QAmcp's block to a hook file's text: replaces an earlier QAmcp block, or goes at the end.
export function withHook(existing: string | undefined, block: string): { text: string; replaced: boolean; hadOther: boolean } {
  if (!existing?.trim()) return { text: `#!/bin/sh\n${block}\n`, replaced: false, hadOther: false };
  const s = existing.indexOf(START);
  const e = existing.indexOf(END);
  const others = (text: string) => text.replace(/^#!.*\n?/, '').trim().length > 0;
  if (s >= 0 && e > s) return { text: existing.slice(0, s) + block + existing.slice(e + END.length), replaced: true, hadOther: others(existing.slice(0, s) + existing.slice(e + END.length)) };
  return { text: `${existing.replace(/\s*$/, '')}\n\n${block}\n`, replaced: false, hadOther: true };
}

// Where this repository keeps its hooks (respects core.hooksPath and git worktrees).
export function hooksDir(cwd = process.cwd()): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return existsSync(join(cwd, '.git')) ? join(cwd, '.git', 'hooks') : undefined;
  }
}

export function installHook(t: HookTarget, cwd = process.cwd()): { path: string; replaced: boolean; hadOther: boolean } {
  const dir = hooksDir(cwd);
  if (!dir) throw new Error('This folder is not a git repository. Run it from your MCP server\'s repository.');
  const full = isAbsolute(dir) ? dir : join(cwd, dir);
  mkdirSync(full, { recursive: true });
  const path = join(full, 'pre-commit');
  const r = withHook(existsSync(path) ? readFileSync(path, 'utf8') : undefined, hookBlock(t));
  writeFileSync(path, r.text);
  chmodSync(path, 0o755);
  return { path, replaced: r.replaced, hadOther: r.hadOther };
}
