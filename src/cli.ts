#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Args, parseArgs, UsageError, USAGE } from './cliArgs.js';
import { compareReports, evaluateGates, toJUnit, toMarkdown } from './ci.js';
import { openInBrowser } from './oauth.js';
import { toHtml } from './htmlReport.js';
import { formatReport } from './report.js';
import { runTest } from './runTest.js';
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

const target = args.url ?? `stdio:${[args.stdio!.command, ...args.stdio!.args].join(' ')}`;
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
console.log(formatReport(report));

// Compare, decide, and write the outputs CI wants.
const comparison = baseline ? compareReports(report, baseline) : undefined;
const gate = evaluateGates(report, { failUnder: args.failUnder, failOnFail: args.failOnFail, maxDrop: args.maxDrop }, comparison);

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
else if (args.failUnder !== undefined || args.failOnFail || baseline) console.log('\nCI gate: PASSED');

process.exit(gate.exitCode);
