# QAmcp design

The report page (`--html`) is a **test certificate**: one sheet with the facts, the result stamp, then the numbered test items. Dark, calm, exact. Later pages (the local web page, the website) follow the same rules.

## Colours

| Token | Hex | Used for |
|---|---|---|
| `--ground` | `#1A1A1A` | page background |
| `--sheet` | `#232323` | the certificate sheet and panels |
| `--raise` | `#2A2726` | hover and open rows |
| `--ink` | `#EDE7E3` | main text |
| `--soft` | `#ABA49F` | second-level text |
| `--faint` | `#938B86` | labels and small notes (lowest contrast still allowed: 4.5:1) |
| `--rule` | `#38332F` | lines and borders |
| `--rose` | `#B9838A` | the brand colour: logo, links, the button, advisories |
| `--fail` | `#EC5F57` | failures only |
| `--pass` | `#93BB9B` | passes only |
| `--off` | `#7C7570` | not tested / not scored |

Red and green mean fail and pass, and nothing else. Every result also has a drawn mark and a word, so colour is never the only signal.

## Type

- **Archivo Narrow** 600/700: headings and the stamp.
- **Atkinson Hyperlegible Next** 400/700: body text.
- **JetBrains Mono** 400/600: the score, numbers with units, tool names, commands (ligatures off).

All three are OFL fonts, embedded in the page, so the page works offline and fetches nothing.

## Rules

- The page loads no scripts and no outside files; every server string is escaped.
- On phones the result comes right after the title, before the details.
- Failures and advisories are listed apart; the "older MCP version" advisory always comes last.
- A login wall is NOT SCORED, never shown as a failure.
