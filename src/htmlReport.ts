// The report as a self-contained web page: a test certificate. One file, fonts built in, no
// scripts, nothing fetched when it is opened, so it can be saved, shared, or attached to CI
// without breaking the privacy promise.
//
// Everything a server sent (tool names, descriptions, error text) is escaped before it goes
// into the page: a hostile server must never be able to inject markup into a report.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { topFixes } from './report.js';
import type { CheckResult, Finding, Report, Status } from './types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/abhiramreddykalluru01-debug/qamcp-cli';

export interface HtmlOptions {
  title?: string; // a friendlier name than the server's own, e.g. "Acme MCP server"
}

export function toHtml(r: Report, opts: HtmlOptions = {}): string {
  const verdict = verdictOf(r);
  const items = r.checks.map((c, i) => ({ check: c, code: `T-${i + 1}` }));
  const codeOf = new Map(items.map((x) => [x.check, x.code]));
  const fails: Listed[] = [];
  const advisories: Listed[] = [];
  // Failures in the order the CLI's "fix these first" uses, then the rest.
  const first = new Set(topFixes(r, 99));
  const ordered = items.flatMap(({ check }) => check.findings.map((f, j) => ({ f, check, code: `${codeOf.get(check)}.${j + 1}` })));
  const late = (x: { check: CheckResult }) => Number(x.check.id === 'protocol');
  ordered.sort((a, b) => late(a) - late(b) || Number(first.has(b.f)) - Number(first.has(a.f)));
  for (const x of ordered) {
    if (r.notScored && x.check.id === 'connect') continue; // a login wall is not a fault to fix
    if (x.f.status === 'fail') fails.push(x);
    else if (x.f.status === 'warn') advisories.push(x);
  }

  const name = opts.title ?? r.server?.name ?? hostOf(r.url);
  const tested = r.testedAt ? new Date(r.testedAt) : undefined;
  const fields: [string, string][] = [
    ['Server', [r.server?.name, r.server?.version].filter(Boolean).join(' ') || 'Not reported'],
    ['MCP version', r.protocol ? `${r.protocol.version ?? 'unknown'} · ${transportName(r.protocol.transport)}` : 'Could not connect'],
    ['Tested', tested ? `${tested.toISOString().slice(0, 10)} · ${tested.toISOString().slice(11, 16)} UTC` : '–'],
    ['Safety mode', safetyWords(r.testedAs?.safety)],
    ['Logged in', r.testedAs?.loggedIn ? 'Yes, with your login' : 'No'],
    ['Tester', `QAmcp ${version()}`],
  ];

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`${verdict.word === 'NOT SCORED' ? 'Not scored' : r.score + '/100'} · ${name} · QAmcp test certificate`)}</title>
<meta name="color-scheme" content="dark">
<style>${fontFaces()}${CSS}</style></head>
<body>${SYMBOLS}
<header class="top"><a class="brand" href="${REPO}">QA<b>mcp</b></a><nav><a href="${REPO}#how-to-read-the-score">How scoring works</a><a href="${REPO}#test-on-every-change-github">Run it in CI</a></nav><a class="again" href="${REPO}#install-and-first-run">Test another server</a></header>
<main>
<section class="cert" aria-labelledby="t">
  <div class="head"><h1 id="t">Test certificate: ${esc(name)}<span class="addr">${esc(r.url)}</span></h1></div>
  <div class="fields">
    ${fields.map(([k, v]) => `<div class="f"><div class="label">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('\n    ')}
  </div>
  <div class="result">
    <div class="label">Result</div>
    ${verdict.word === 'NOT SCORED' ? '' : `<div class="score"><span class="n">${r.score}</span><span class="of">/ 100</span></div>`}
    <div class="stamp ${verdict.cls}">${esc(verdict.word)}</div>
    <div class="cov">${r.coverage.checksRun} of ${r.coverage.checksTotal} checks · ${r.coverage.toolsRun} of ${r.coverage.toolsTotal} tools run</div>
    ${r.notScored ? `<p class="note">${notScoredHtml(r.notScored)}</p>` : ''}
    ${capNote(r)}
  </div>
</section>

<div class="cols">
  ${column('fail', 'Failures: fix these first', fails, 'Nothing failed.')}
  ${column('warn', 'Advisories: worth fixing', advisories, 'No advisories.')}
</div>

<section class="items" aria-labelledby="items">
  <h2 id="items">All test items</h2>
  <p class="hint">Open an item to see every result behind it.</p>
  ${items.map(({ check, code }) => itemRow(check, code)).join('\n  ')}
</section>
${skipped(r)}
<footer>
  <p>${esc(r.dataFlow?.summary ?? 'QAmcp sends nothing anywhere except to the server being tested.')}</p>
  <p>Every result is a hard fact: pass or fail, milliseconds, exact matches. No AI judged anything. A check that could not run doesn't count either way; serious problems cap the score. <a href="${REPO}#how-to-read-the-score">How the score works</a>.</p>
  <p class="made">Made with <a href="${REPO}">QAmcp</a> · <span class="mono">npx qamcp-cli ${esc(r.url.startsWith('stdio:') ? '--stdio "…"' : r.url)}</span></p>
</footer>
</main></body></html>
`;
}

// ---------- pieces ----------

interface Listed {
  f: Finding;
  check: CheckResult;
  code: string;
}

const SHOW = 6; // per column; the rest are one click away in the test items

function column(kind: 'fail' | 'warn', title: string, list: Listed[], empty: string): string {
  const shown = list.slice(0, SHOW);
  const more = list.length - shown.length;
  return `<section class="col ${kind}" aria-labelledby="h-${kind}">
    <h2 id="h-${kind}">${esc(title)} <span class="count">${list.length}</span></h2>
    ${shown.length ? shown.map((x) => `<div class="item">${mark(kind)}<span class="code">${x.code}</span><p>${findingText(x.f)}</p></div>`).join('\n    ') : `<p class="empty">${esc(empty)}</p>`}
    ${more > 0 ? `<p class="more">and ${more} more in the test items below</p>` : ''}
  </section>`;
}

function itemRow(c: CheckResult, code: string): string {
  const status = c.status;
  const lead = c.findings.find((f) => f.status === status) ?? c.findings[0];
  const notTested = status === 'skip';
  return `<details class="row ${status}">
    <summary>${mark(status)}<span class="code">${code}</span><span class="name">${esc(c.title)}</span><span class="lead">${lead ? findingText(lead, 140) : ''}</span><span class="st">${statusWord(status)}</span><svg class="chev" aria-hidden="true"><use href="#chev"/></svg></summary>
    <div class="body">${notTested ? `<p class="why">${esc(lead?.message ?? 'This check could not run on this server, so it is not counted either way.')}</p>` : ''}
      ${c.findings
        .filter((f) => !(notTested && f === lead))
        .map((f, j) => `<div class="fd ${f.status}">${mark(f.status)}<span class="code">${code}.${c.findings.indexOf(f) + 1 || j + 1}</span><p>${findingText(f)}</p></div>`)
        .join('\n      ')}
    </div>
  </details>`;
}

function skipped(r: Report): string {
  if (!r.skippedTools.length) return '';
  return `<section class="skipped" aria-labelledby="sk">
  <h2 id="sk">Tools not run, and why</h2>
  <p class="hint">QAmcp never runs a tool that could change something on your server. If you own it, <span class="mono">--owner</span> runs the unlabeled tools whose names clearly only read.</p>
  <ul>${r.skippedTools.map((s) => `<li>${mark('skip')}<span class="tool">${esc(s.tool)}</span><span>${esc(s.why)}</span></li>`).join('')}</ul>
</section>`;
}

// The tool name in mono, then the plain-words message (without repeating the tool name).
function findingText(f: Finding, max = 400): string {
  let m = f.message;
  if (f.tool && m.startsWith(f.tool + ':')) m = m.slice(f.tool.length + 1).trim();
  if (m.length > max) m = m.slice(0, max - 1) + '…';
  return `${f.tool ? `<em>${esc(f.tool)}</em>: ` : ''}${numbers(esc(m))}`;
}

// Measurements in lined-up digits, with their unit.
function numbers(html: string): string {
  return html.replace(/\b(\d+(?:\.\d+)?)\s?(ms|s|KB|%)(?![\w])/g, '<span class="num">$1 $2</span>');
}

function mark(s: Status | 'warn' | 'fail'): string {
  const id = s === 'fail' ? 'x' : s === 'warn' ? 'w' : s === 'pass' ? 'ok' : 'na';
  const label = s === 'fail' ? 'Failed' : s === 'warn' ? 'Advisory' : s === 'pass' ? 'Passed' : 'Not tested';
  return `<svg class="mk ${s}" role="img" aria-label="${label}"><use href="#${id}"/></svg>`;
}

function statusWord(s: Status): string {
  return { pass: 'PASS', warn: 'ADVISORY', fail: 'FAIL', skip: 'NOT TESTED' }[s];
}

function verdictOf(r: Report): { word: string; cls: string } {
  if (r.notScored) return { word: 'NOT SCORED', cls: 'skip' };
  if (r.checks.some((c) => c.status === 'fail')) return { word: 'FAIL', cls: 'fail' };
  if (r.checks.some((c) => c.status === 'warn')) return { word: 'PASS · ADVISORIES', cls: 'pass' };
  return { word: 'PASS', cls: 'pass' };
}

function capNote(r: Report): string {
  const cap = r.scoreCaps?.length ? r.scoreCaps.reduce((a, b) => (b.max < a.max ? b : a)) : undefined;
  if (!cap || r.scoreBeforeCaps === undefined || r.scoreBeforeCaps <= r.score) return '';
  return `<p class="note">Would be <span class="num">${r.scoreBeforeCaps}</span>, but capped at <span class="num">${cap.max}</span> because ${esc(cap.reason)}.</p>`;
}

function notScoredHtml(reason: string): string {
  return reason === 'needs a login'
    ? 'This server needs a login. Test again with <span class="mono">--login</span>, or add a key with <span class="mono">--header</span>. A login wall is not a fault, so nothing is scored.'
    : `Not scored: ${esc(reason)}.`;
}

function safetyWords(s: string | undefined): string {
  if (s === 'owner') return 'Owner: also ran unlabeled tools whose names only read';
  if (s === 'all') return 'Owner: ran every tool not labeled or named dangerous';
  return 'Only tools labeled read-only were run';
}

function transportName(t: string): string {
  return t === 'streamable-http' ? 'streamable HTTP' : t === 'sse' ? 'old SSE' : 'program on this computer';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

let cachedVersion: string | undefined;
function version(): string {
  if (!cachedVersion) {
    try {
      cachedVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    } catch {
      cachedVersion = '';
    }
  }
  return cachedVersion ?? '';
}

export function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// The fonts, built into the page so opening it contacts no one.
let cachedFonts: string | undefined;
function fontFaces(): string {
  if (cachedFonts !== undefined) return cachedFonts;
  const face = (family: string, file: string, weight: number) => {
    try {
      const data = readFileSync(join(ROOT, 'assets', 'fonts', file)).toString('base64');
      return `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${data}) format("woff2");font-weight:${weight};font-style:normal;font-display:swap}`;
    } catch {
      return ''; // the page still reads well in the fallback faces
    }
  };
  cachedFonts = [
    face('Archivo Narrow', 'archivo-narrow-latin-600-normal.woff2', 600),
    face('Archivo Narrow', 'archivo-narrow-latin-700-normal.woff2', 700),
    face('Atkinson Hyperlegible Next', 'atkinson-hyperlegible-next-latin-400-normal.woff2', 400),
    face('Atkinson Hyperlegible Next', 'atkinson-hyperlegible-next-latin-700-normal.woff2', 700),
    face('JetBrains Mono', 'jetbrains-mono-latin-400-normal.woff2', 400),
    face('JetBrains Mono', 'jetbrains-mono-latin-600-normal.woff2', 600),
  ].join('');
  return cachedFonts;
}

// Drawn marks: colour is never the only signal.
const SYMBOLS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="x" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6.8 6.8l6.4 6.4M13.2 6.8l-6.4 6.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
<symbol id="w" viewBox="0 0 20 20"><path d="M10 2.2l8.3 14.6H1.7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 8v3.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14.3" r="1.1" fill="currentColor"/></symbol>
<symbol id="ok" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6.2 10.4l2.6 2.6 5-5.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="na" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="2.6 2.6"/><path d="M6.5 10h7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
<symbol id="chev" viewBox="0 0 16 16"><path d="M5 6.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
</defs></svg>`;

const CSS = `
:root{--ground:#1A1A1A;--sheet:#232323;--raise:#2A2726;--ink:#EDE7E3;--soft:#ABA49F;--faint:#938B86;--rule:#38332F;--rose:#B9838A;--fail:#EC5F57;--pass:#93BB9B;--off:#7C7570;
--label:600 12px/1 "Archivo Narrow","Arial Narrow",sans-serif;--mono:"JetBrains Mono",ui-monospace,Consolas,monospace}
*{box-sizing:border-box;margin:0}
html{background:var(--ground);color-scheme:dark;scrollbar-color:#4A4440 var(--ground)}
body{color:var(--ink);font:400 16px/1.55 "Atkinson Hyperlegible Next",system-ui,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:#B9838A55;color:#fff}
a{color:var(--ink);text-decoration-color:var(--rose);text-underline-offset:3px}
a:hover{color:#fff}
:focus-visible{outline:2px solid var(--rose);outline-offset:3px;border-radius:4px}
.mono,.num,.code,em{font-family:var(--mono);font-variant-numeric:tabular-nums;font-variant-ligatures:none}
.num{font-size:.92em;white-space:nowrap}
em{font-style:normal;font-size:.9em;color:var(--ink)}
.label{font:var(--label);letter-spacing:.08em;text-transform:uppercase;color:var(--soft)}
.top{display:flex;align-items:center;gap:32px;max-width:1312px;margin:0 auto;height:64px;padding:0 32px;border-bottom:1px solid var(--rule)}
.brand{font:700 21px/1 "Archivo Narrow","Arial Narrow",sans-serif;text-decoration:none}.brand b{color:var(--rose)}
.top nav{display:flex;gap:24px}.top nav a{color:var(--soft);text-decoration:none;font-size:15px}.top nav a:hover{color:var(--ink)}
.again{margin-left:auto;text-decoration:none;font-size:15px;border:1px solid var(--rose);padding:8px 16px;border-radius:8px;transition:background .2s}
.again:hover{background:#B9838A22}
main{max-width:1312px;margin:0 auto;padding:36px 32px 64px}
.cert{display:grid;grid-template-columns:1fr minmax(280px,330px);grid-template-areas:"head result" "fields result";background:var(--sheet);border:1px solid var(--rule);border-radius:14px}
.head{grid-area:head;padding:28px 32px 0}
.fields{grid-area:fields;padding:22px 32px 28px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px 32px}
h1{font:700 clamp(24px,2.6vw,32px)/1.15 "Archivo Narrow","Arial Narrow",sans-serif;letter-spacing:-.01em;text-wrap:balance}
.addr{display:block;margin-top:8px;font:400 14px/1.4 var(--mono);color:var(--soft);word-break:break-all}
.f .v{margin-top:8px;font-size:15.5px;overflow-wrap:anywhere}
.result{grid-area:result;border-left:1px solid var(--rule);padding:28px 32px;display:flex;flex-direction:column;gap:12px}
.score{display:flex;align-items:baseline;gap:14px}
.score .n{font:600 clamp(64px,7vw,88px)/.9 var(--mono);letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.score .of{font:400 18px/1 var(--mono);color:var(--soft)}
.stamp{width:max-content;font:700 22px/1 "Archivo Narrow","Arial Narrow",sans-serif;letter-spacing:.14em;padding:9px 14px;border:2px solid currentColor;border-radius:6px}
.stamp.fail{color:var(--fail)}.stamp.pass{color:var(--pass)}.stamp.skip{color:var(--soft)}
.cov{font:400 13.5px/1.4 var(--mono);color:var(--soft)}
.note{font-size:14.5px;color:var(--soft);max-width:34ch}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:32px}
h2{font:700 21px/1.2 "Archivo Narrow","Arial Narrow",sans-serif;display:flex;align-items:baseline;gap:12px}
.count{font:600 13px/1 var(--mono);color:var(--soft)}
.col h2{margin-bottom:12px}
.item{display:grid;grid-template-columns:22px 64px 1fr;gap:12px;align-items:start;padding:12px 0;border-top:1px solid var(--rule)}
.item p{font-size:15.5px;line-height:1.45;max-width:68ch}
.code{font-size:12.5px;line-height:1.75;color:var(--faint)}
.mk{width:20px;height:20px;flex:none;margin-top:1px}
.mk.fail{color:var(--fail)}.mk.warn{color:var(--rose)}.mk.pass{color:var(--pass)}.mk.skip{color:var(--off)}
.empty{padding:12px 0;border-top:1px solid var(--rule);color:var(--soft)}
.more{padding-top:10px;border-top:1px solid var(--rule);font-size:14px;color:var(--soft)}
.items{margin-top:48px}
.hint{margin:6px 0 14px;color:var(--soft);font-size:14.5px;max-width:72ch}
details.row{border-top:1px solid var(--rule)}
details.row:last-child{border-bottom:1px solid var(--rule)}
summary{list-style:none;display:grid;grid-template-columns:22px 52px minmax(160px,250px) 1fr 104px 18px;gap:12px;align-items:center;padding:13px 0;cursor:pointer;border-radius:6px}
summary::-webkit-details-marker{display:none}
summary:hover{background:#ffffff06}
.name{font-weight:700;font-size:15.5px}
.lead{color:var(--soft);font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.st{font:var(--label);letter-spacing:.1em;text-align:right}
.row.fail .st{color:var(--fail)}.row.warn .st{color:var(--rose)}.row.pass .st{color:var(--pass)}.row.skip .st{color:var(--off)}
.row.skip .name{color:var(--soft);text-decoration:line-through;text-decoration-color:var(--off)}
.chev{width:16px;height:16px;color:var(--soft);transition:transform .25s cubic-bezier(.2,.8,.2,1)}
details[open] .chev{transform:rotate(180deg)}
.body{padding:2px 0 16px 34px}
.why{color:var(--soft);font-size:14.5px;padding:4px 0 8px}
.fd{display:grid;grid-template-columns:20px 64px 1fr;gap:10px;align-items:start;padding:8px 0}
.fd .mk{width:17px;height:17px;margin-top:2px}
.fd p{font-size:15px;line-height:1.45;max-width:72ch;overflow-wrap:anywhere}
.skipped{margin-top:48px}
.skipped ul{list-style:none;padding:0}
.skipped li{display:grid;grid-template-columns:22px minmax(140px,260px) 1fr;gap:12px;align-items:start;padding:11px 0;border-top:1px solid var(--rule);font-size:15px;color:var(--soft)}
.skipped .tool{font-family:var(--mono);font-size:14px;color:var(--ink);text-decoration:line-through;text-decoration-color:var(--off)}
footer{margin-top:56px;padding-top:24px;border-top:1px solid var(--rule);display:flex;flex-direction:column;gap:10px;color:var(--soft);font-size:14.5px;max-width:80ch}
.made{color:var(--faint)}
@media (max-width:900px){
 .top{padding:0 16px;gap:16px}.top nav{display:none}
 main{padding:24px 16px 48px}
 .cert{grid-template-columns:1fr;grid-template-areas:"head" "result" "fields"}
 .head{padding:22px 20px 0}
 .fields{grid-template-columns:1fr 1fr;padding:20px;gap:18px 20px;border-top:1px solid var(--rule)}
 .result{border-left:none;padding:22px 20px;display:grid;grid-template-columns:auto 1fr;align-items:center;column-gap:20px}
 .result .label{grid-column:1/-1}.result .cov,.result .note{grid-column:1/-1}
 .cols{grid-template-columns:1fr;gap:28px}
 .item{grid-template-columns:22px 54px 1fr}
 summary{grid-template-columns:22px 1fr 18px;row-gap:4px}
 summary .code,summary .lead{display:none}
 summary .st{grid-column:2;text-align:left;order:3}
 summary .chev{grid-row:1;grid-column:3}
 .body{padding-left:0}
 .skipped li{grid-template-columns:22px 1fr}
 .skipped li span:last-child{grid-column:2}
}
@media (max-width:340px){.fields{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;
