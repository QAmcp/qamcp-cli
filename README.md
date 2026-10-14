# QAmcp

[![npm](https://img.shields.io/npm/v/qamcp-cli)](https://www.npmjs.com/package/qamcp-cli) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**QAmcp tests MCP servers for the people who build them: it connects like an AI app does and tells you, in plain words, what's broken.**

Every result is a hard fact (pass or fail, milliseconds, exact matches). No AI judges anything, and nothing is sent anywhere except to the server you test.

## Install and first run

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npx qamcp-cli https://your-server.com/mcp              # test a server on the internet
npx qamcp-cli --stdio "npx -y @your-org/your-server"   # or a server that runs on your computer
npx qamcp-cli --help                                   # every option
```

Or install it once with `npm install -g qamcp-cli`, then just type `qamcp`.

## A sample report

Real output from testing [Context7](https://context7.com)'s public server with QAmcp 0.1.0:

```text
QAmcp report for https://mcp.context7.com/mcp
Server: Context7 v4.4.1
MCP version: 2026-07-28 (streamable-http)

SCORE: 100/100
Tested 10 of 10 checks · ran 2 of 2 tools
Privacy: nothing was sent anywhere except to the server being tested (and its login server, if it needed a login). QAmcp has no tracking.

✅ Connects — All good
✅ Ready for the newest MCP version — All good
✅ Lists its tools — All good
✅ Every tool is described — All good
✅ Tools are labeled safe or dangerous — All good
✅ No hidden instructions — All good
✅ Tools work with good inputs — All good
✅ Bad inputs give a clean error — All good
✅ Fast enough — All good
     ✅ Connecting took 852 ms
     ✅ Listing tools took 261 ms
     ✅ Average tool answer: 1.1 s
✅ No secrets leaked — All good
     ✅ Checked 5 error messages: no secrets or internal details
```

## What it checks

| Check | What it looks at |
|---|---|
| **Connects** | Current and older MCP connection types, or a program on your computer (stdio) |
| **Ready for the newest MCP version** | On the July 2026 version? Still on the old SSE connection? |
| **Lists its tools** | Duplicate or invalid names, a broken tool that stops AI apps loading the server |
| **Every tool is described** | Missing or vague descriptions, undescribed inputs, look-alike tools |
| **Tools are labeled safe or dangerous** | Safety labels, and labels the tool itself contradicts |
| **No hidden instructions** | Known tricks in descriptions: `<IMPORTANT>` blocks, "don't tell the user", invisible characters |
| **Tools work with good inputs** | Runs safe tools; catches tools that hang or claim success but return nothing |
| **Bad inputs give a clean error** | Missing and wrong-type inputs |
| **Fast enough** | Connect, list and tool times |
| **No secrets leaked** | Keys, passwords, server folders and stack traces in error messages |
| **Login setup follows the spec** | Only when a server needs a login: the OAuth details AI apps need to log in |
| **Resources and prompts work** | Only when a server has them: each opens, content matches its type, inputs are used |

Serious problems (hidden instructions, leaked secrets, crashes) cap the score, and every report says how much was actually tested.

## What it never does

- **It never runs a tool that could change something.** By default it runs only tools the server labels read-only.
- **It never runs a tool that sounds destructive**, like `delete_account`, in any mode.
- **It never sends your data anywhere else.** No AI, no tracking, no telemetry.

If you own the server, `--owner` also runs unlabeled tools whose names clearly only read (`get_`, `list_`, `search_`…). Tools whose name or description says they write, send or create are still skipped.

## What it caught on a deliberately broken server

We keep a test server with one planted problem per tool ([`test/buggyServer.ts`](test/buggyServer.ts)). Real output from QAmcp 0.1.0, shortened:

```text
SCORE: 38/100
Tested 10 of 10 checks · ran 5 of 9 tools

❌ slow_report: Has no description, so the AI has to guess what it does
❌ fetch_notes: Description contains hidden <IMPORTANT> block. This is a known trick to make AI do things the user didn't ask for.
❌ slow_report: No answer within the time limit
❌ slow_report: Hung on missing required input "id"
❌ search_users: Error message shows what looks like a database password in a link
⚠️  search_users: Error message shows internal details: code stack trace, server file path
⚠️  fetch_notes: Accepted missing required input "key" without complaining
⚠️  strict_lookup: Errors are sent with an HTTP error status (like 400) instead of a normal MCP reply
⚠️  delete_account: Name sounds like it deletes something, but it is not labeled dangerous
➖ delete_account: Not run: name sounds like it deletes something
```

With `--owner`, it also ran `list_projects` (unlabeled, name only reads) and still skipped `team_digest` ("Sends" in its description), `get_or_create_user` ("create" in its name) and `delete_account`.

## More ways to run it

```bash
npx qamcp-cli https://your-server.com/mcp --header "Authorization: Bearer YOUR_KEY"   # a server with a key
npx qamcp-cli https://your-server.com/mcp --login                                     # log in through your browser
npx qamcp-cli https://your-server.com/mcp --json report.json                         # save the full report
```

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

Every pull request gets a comment with the score, and the build fails if the server got worse. [`examples/qamcp-ci.yml`](examples/qamcp-ci.yml) shows how to compare with the last run and catch tools that changed or disappeared.

Any other CI system:

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

## Problems or ideas

[Open an issue](https://github.com/abhiramreddykalluru01-debug/qamcp-cli/issues). If QAmcp gets something wrong about your server, please tell us: being fair matters more to us than anything else.

## License

MIT
