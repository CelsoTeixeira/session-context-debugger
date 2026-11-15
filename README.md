# Session Context Debugger

A local browser app for understanding recorded **Codex, Claude Code, and T3 Code sessions**. Browse messages, instructions, tool activity, and reported token usage, then inspect the original log behind a finding.

Use it to answer questions such as:

- What instructions and setup were captured in this session?
- Where did reported input usage grow, and where was compaction recorded?
- Which tool calls and results belong together?
- Which captured fields repeat, and where do they appear?

## Run locally

Requires **Node.js 22.12 or later**.

```sh
npm install
npm run build
npm start
```

Open the access link printed in the terminal and keep the server running. The link grants access to this local instance; reopen it after reloading the page or restarting the server.

Choose a **T3 Code thread**, switch to **Claude** or **Codex**, or enter an absolute JSONL path within an allowed recording directory. T3 links open only when the provider identity is corroborated by the log.

## Explore a session

| View | What you can inspect |
| --- | --- |
| **Timeline** | Messages, instructions, tool calls/results, reasoning where recorded, and response evidence. |
| **Measurements** | Token usage, compaction intervals, file/captured-field bytes, and exact repeated captures. |
| **Search** | Case-sensitive literal text in the raw JSONL recording. |
| **Beginning** | First input, captured startup instructions/resources, and first-response usage. |
| **Coverage** | What was indexed, skipped, unknown, or limited, with a physical-record ledger. |

**Inspect source** opens hash-validated log records or captured fields. **Show in timeline** selects the exact linked event when available. Supported parent/child links let you explore related recordings with separate usage totals.

Tabs keep their controls and selections while you stay in a recording. Use **Select session** to choose another; **Reopen** rebuilds the current index.

### Inside Measurements

| Tool | What it measures |
| --- | --- |
| **Input & changes** | Reported input per response, or signed changes between compatible adjacent measurements. |
| **Cumulative usage** | Known input, output, and cache subtotals in recorded order. |
| **Response ranking** | Recorded responses ordered by input usage or source order. |
| **Context windows** | Recorded source intervals and compaction evidence. |
| **Transcript bytes** | Physical JSONL file bytes per record or cumulatively. |
| **Captured bytes** | Compact JSON field sizes or event counts by category. |
| **Repeated captures** | Exact matching standalone captured fields, with byte counts and source locations. |

## How to read the results

- **Recorded evidence has limits.** Captured content and prompt snapshots do not establish what entered a particular request or remained in the model's active context.
- **Tokens and bytes measure different things.** Provider-reported usage, physical file size, and captured-field size stay separate. Repeats alone do not establish wasted tokens or savings.
- **A gap is not zero.** Missing, conflicting, or incompatible measurements remain unavailable, with an explanation.
- **Coverage matters.** Indexing is bounded. Partial results and an empty search or comparison do not prove absence from the full session.

## Local access and privacy

The server listens on `127.0.0.1`. Source recordings and the T3 catalog are read-only; source content and indexes stay in memory and are not sent to remote services or persisted by the app.

Default recording directories under your home folder:

- `.codex/sessions` and `.codex/archived_sessions`
- `.claude/projects`

Optional launch settings:

```sh
npm start -- --port 8766
npm start -- --root /absolute/path/to/session-directory
```

An explicit `--root` replaces the default recording roots for that launch. T3 discovery reads `.t3/userdata/statev2.sqlite` using Node's built-in experimental SQLite support.

## Development and reference

```sh
npm run typecheck
npm run build
```

Code is organized under `src/core`, `src/adapters`, `src/server`, and `src/ui`. No automated test suite is included.

See the [detailed reference](docs/reference.md) for identity/grouping rules, discovery and indexing limits, usage semantics, and the repeated-capture flow. The project is under active development; broader context reconstruction, duplication diagnostics, and discovery/refresh remain in progress.
