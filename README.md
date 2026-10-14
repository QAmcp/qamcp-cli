# QAmcp

[![npm](https://img.shields.io/npm/v/qamcp-cli)](https://www.npmjs.com/package/qamcp-cli) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Test any MCP server in one command.** Find out what's broken before your users (or their AI apps) do.

```bash
npx qamcp-cli https://your-server.com/mcp
```

You need [Node.js](https://nodejs.org) 20 or newer. Nothing else to install: `npx` downloads QAmcp the first time. Or install it once with `npm install -g qamcp-cli` and then just type `qamcp`.

Package on npm: [npmjs.com/package/qamcp-cli](https://www.npmjs.com/package/qamcp-cli)

Every result is a hard fact: pass or fail, milliseconds, exact matches. No AI judges anything,
and nothing is sent anywhere except to the server you test.

## What it checks

| Check | What it looks at |
|---|---|
| **Connects** | Current and older MCP connection types, or a program on your computer |
| **Ready for the newest MCP version** | On the July 2026 version? Still on the old SSE connection? |
| **Lists its tools** | Duplicate names, invalid names, a broken tool that stops AI apps loading the server |
| **Every tool is described** | Missing or vague descriptions, undescribed inputs, look-alike tools |
| **Tools are labeled safe or dangerous** | Safety labels, and labels the tool itself contradicts |
| **No hidden instructions** | Known tricks in descriptions (`<IMPORTANT>`, "don't tell the user", invisible characters) |
| **Tools work with good inputs** | Runs safe tools; catches tools that claim success but return nothing |
| **Bad inputs give a clean error** | Missing and wrong-type inputs |
| **Fast enough** | Connect, list and tool times |
| **No secrets leaked** | Keys, passwords, server folders and stack traces in error messages |
| **Login setup follows the spec** | When a server needs a login: why "login doesn't work" with Claude, ChatGPT and other AI apps |
| **Resources and prompts work** | Each one opens, content matches its type, your inputs are really used, clean errors |

You get a score out of 100, a plain reason for every problem, and how much was actually tested.
Serious problems (hidden instructions, leaked secrets, crashes) cap the score.

## Safe by default

QAmcp only runs tools that can't change anything: tools the server labels read-only.
Tools that sound destructive are never run, in any mode.

- `--owner`: your own server. Also runs unlabeled tools whose names clearly only read (`get_`, `search_`…).
- `--run-unlabeled`: your own server, your own risk. Runs everything not labeled or named dangerous.

## More ways to run it

```bash
npx qamcp-cli https://your-server.com/mcp --header "Authorization: Bearer YOUR_KEY"   # a server with a key
npx qamcp-cli https://your-server.com/mcp --login                                     # log in through your browser
npx qamcp-cli --stdio "npx -y @your-org/your-mcp-server"                              # a program on your computer
npx qamcp-cli https://your-server.com/mcp --json report.json                         # save the full report
```

Run `npx qamcp-cli --help` for every option.

## Test on every change (GitHub)

Add `.github/workflows/qamcp.yml` to your repository:

```yaml
name: QAmcp
on: [pull_request]
permissions:
  contents: read
  pull-requests: write
jobs:
  qamcp:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: abhiramreddykalluru01-debug/qamcp-cli@v0
        with:
          url: https://your-server.com/mcp
          fail-under: 80
```

Every pull request gets a comment with the score, and the build fails if the server got worse.
See [`examples/qamcp-ci.yml`](examples/qamcp-ci.yml) for comparing with the last run and catching
tools that changed or disappeared.

From any other CI system:

```bash
npx qamcp-cli https://your-server.com/mcp --fail-under 80 --baseline base.json --save-baseline base.json --junit report.xml
```

Exit codes: `0` fine · `1` a check you required failed · `2` wrong options · `3` could not test (server down, or needs a login).

## Docker

```bash
docker build -t qamcp .
docker run --rm qamcp https://your-server.com/mcp
```

## Use it from code

```ts
import { runTest } from 'qamcp-cli';

const report = await runTest('https://your-server.com/mcp');
console.log(report.score, report.checks);
```

`extraChecks` lets you plug in checks of your own; they run after the built-in ones and count toward the score.

## Privacy

QAmcp talks only to the server you test (and its login server, if it needs a login).
No AI, no tracking, no telemetry. Every report says so in plain words, and a test proves it
by recording every address the program contacts.

## Problems or ideas

Open an issue: [github.com/abhiramreddykalluru01-debug/qamcp-cli/issues](https://github.com/abhiramreddykalluru01-debug/qamcp-cli/issues). If QAmcp gets something wrong about your server, tell us: being fair matters more to us than anything else.

## License

MIT
