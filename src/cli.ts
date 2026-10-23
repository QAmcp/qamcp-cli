#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Args, parseArgs, UsageError, USAGE } from './cliArgs.js';
import { compareReports, evaluateGates, toJUnit, toMarkdown } from './ci.js';
import { openInBrowser } from './oauth.js';
import { toHtml } from './htmlReport.js';
import { formatReport } from './report.js';
import { runTest } from './runTest.js';
import { startDemoServer } from './demoServer.js';
import { installHook } from './hook.js';
import { beforeInstall, formatBeforeInstall } from './beforeInstall.js';
import { diffTools, formatChanges, lastTools, rememberTools } from './drift.js';

// A date as the person running it sees it (their own time zone), e.g. 2026-10-24.
const localDay = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
import type { Report } from './types.js';

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  console.error(`${err.message}\n\nRun with --help to see every option.`);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

if (args.installHook) {
  const failUnder = args.failUnder ?? 80;
  try {
    const r = installHook({ url: args.stdioLine === undefined ? args.url : undefined, stdio: args.stdioLine, failUnder });
    console.log(`${r.replaced ? 'Updated' : 'Installed'} the QAmcp pre-commit check in ${r.path}`);
    console.log(`From now on, every git commit tests ${args.stdioLine !== undefined ? `the server started by: ${args.stdioLine}` : args.url} and stops the commit if it scores below ${failUnder}.`);
    if (r.hadOther && !r.replaced) console.log('Your hook already had other steps: QAmcp runs after them. If one of them ends the hook early, QAmcp won\'t run.');
    console.log('Skip it once with: git commit --no-verify');
    process.exit(0);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
}

// A baseline that doesn't exist yet is normal on the very first CI run: that run becomes the baseline.
let baseline: Report | undefined;
if (args.baseline) {
  if (existsSync(args.baseline)) {
    try {
      baseline = JSON.parse(readFileSync(args.baseline, 'utf8'));
      if (typeof baseline?.score !== 'number' || !Array.isArray(baseline.checks)) throw new Error('not a QAmcp report');
    } catch (err) {
      console.error(`The baseline file ${args.baseline} is not a QAmcp report (${(err as Error).message}).`);
      process.exit(2);
    }
  } else {
    console.log(`No baseline at ${args.baseline} yet, so nothing to compare with this time.`);
  }
}

// --demo: start an MCP server broken on purpose, on this computer only, and test it.
const demo = args.demo ? await startDemoServer() : undefined;
if (demo) {
  args.url = demo.url;
  args.timeoutMs ??= 5_000;
  args.html ??= 'qamcp-demo-report.html';
  console.log('Demo: testing an MCP server we broke on purpose. It runs only on this computer, only for this test.');
  console.log('It hides a prompt injection, a leaked password, a tool that never answers, and more. Watch what QAmcp finds.\n');
}

const target = args.url ?? `stdio:${[args.stdio!.command, ...args.stdio!.args].join(' ')}`;
if (args.beforeInstall && args.stdio) console.log("Note: checking a program means starting it on this computer, the same as installing it. For a server you don't know yet, check its web link instead if it has one.\n");
console.log(`Testing ${target} …`);

const login = args.login
  ? {
      onLoginUrl: (u: URL) => {
        console.log('\nThis server needs a login. Opening its login page in your browser…');
        console.log(`If it does not open, go to:\n  ${u.toString()}\n`);
        openInBrowser(u);
      },
    }
  : undefined;

const report = await runTest(target, {
  login,
  headers: args.headers,
  safety: args.safety,
  timeoutMs: args.timeoutMs,
  stdio: args.stdio,
});
demo?.close();
// What changed in the tools: against the baseline in CI (the approved state), otherwise against
// the last test of this server on this computer.
if (report.toolDefs) {
  if (baseline?.toolDefs) report.toolChanges = { since: `the baseline, ${localDay(baseline.testedAt)}`, changes: diffTools(baseline.toolDefs, report.toolDefs) };
  else if (!args.noHistory && !demo) {
    const last = lastTools(target);
    if (last) report.toolChanges = { since: localDay(last.testedAt), changes: diffTools(last.tools, report.toolDefs) };
  }
  if (!args.noHistory && !demo) {
    try {
      rememberTools(target, report.testedAt, report.toolDefs);
    } catch {
      // a folder we can't write to only means no history next time
    }
  }
}
console.log(args.beforeInstall ? formatBeforeInstall(report, beforeInstall(report)) : formatReport(report));
if (report.toolChanges) console.log(formatChanges(report.toolChanges.changes, report.toolChanges.since) + '\n');
// One line, only for a person at a terminal: never in CI logs or a git hook's output.
if (process.stdout.isTTY && !process.env.CI && !process.env.GIT_INDEX_FILE) console.log('⭐ Found this useful? A star helps others find QAmcp: https://github.com/QAmcp/qamcp-cli\n');

// Compare, decide, and write the outputs CI wants.
const comparison = baseline ? compareReports(report, baseline) : undefined;
const gate = evaluateGates(report, { failUnder: args.failUnder, failOnFail: args.failOnFail, maxDrop: args.maxDrop }, comparison);
const behaviorChanges = report.toolChanges?.changes.filter((c) => c.important) ?? [];
if (args.failOnToolChange && behaviorChanges.length && gate.exitCode !== 3) {
  gate.exitCode = 1;
  gate.reasons.push(`tools changed in ways that change what an AI does: ${behaviorChanges.map((c) => c.tool).join(', ')}`);
}

const write = (file: string, text: string, what: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  console.log(`${what} saved to ${file}`);
};
if (args.json) write(args.json, JSON.stringify(report, null, 2), 'Full report');
if (args.html) write(args.html, toHtml(report), 'Report page');
if (args.saveBaseline) write(args.saveBaseline, JSON.stringify(report, null, 2), 'Baseline');
if (args.junit) write(args.junit, toJUnit(report), 'JUnit report');
const markdown = toMarkdown(report, comparison, args.failUnder !== undefined || args.failOnFail || baseline ? gate : undefined);
if (args.markdown) write(args.markdown, markdown, 'Markdown report');
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
  } catch {
    // the summary is a nicety, never a reason to fail
  }
}

if (comparison) {
  const d = comparison.scoreDelta;
  console.log(`Compared with the baseline: ${comparison.scoreBefore} → ${comparison.scoreAfter} (${d > 0 ? '+' : ''}${d})`);
  for (const w of comparison.worse) console.log(`  worse: ${w.title} (${w.from} → ${w.to})`);
  for (const b of comparison.better) console.log(`  better: ${b.title} (${b.from} → ${b.to})`);
  if (comparison.tools && !comparison.tools.unchanged) {
    const t = comparison.tools;
    console.log(`  tools changed: ${[t.added.length && `added ${t.added.join(', ')}`, t.removed.length && `removed ${t.removed.join(', ')}`, t.changed.length && `changed ${t.changed.join(', ')}`].filter(Boolean).join(' · ')}`);
  }
}
// Outputs for GitHub Actions (the action reads these).
if (process.env.GITHUB_OUTPUT) {
  try {
    const toolsChanged = comparison?.tools ? String(!comparison.tools.unchanged) : 'false';
    const verdict = gate.exitCode === 0 ? 'passed' : gate.exitCode === 1 ? 'failed' : 'not-tested';
    appendFileSync(process.env.GITHUB_OUTPUT, `score=${report.score}\ngate=${verdict}\ntools-changed=${toolsChanged}\n`);
  } catch {
    // outputs are a nicety, never a reason to fail
  }
}

if (gate.exitCode !== 0) console.log(`\nCI gate: ${gate.exitCode === 3 ? 'COULD NOT TEST' : 'FAILED'}\n${gate.reasons.map((r) => `  - ${r}`).join('\n')}`);
else if (args.failUnder !== undefined || args.failOnFail || args.failOnToolChange || baseline) console.log('\nCI gate: PASSED');

process.exit(gate.exitCode);
