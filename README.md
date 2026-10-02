# Session Context Debugger

A local browser app for inspecting recorded Codex/T3 Code and Claude Code sessions, including Desktop Code and SDK origins.

The source picker defaults to T3 Code, with Claude and Codex recording views available. Select a T3 thread to inspect its recorded current provider binding and open a recording with a corroborated provider ID. You can also open a local JSONL path or a stat-only recent-file candidate. The Beginning view separates submitted/human-recorded input from captured setup, shows first-response usage, and links evidence to hash-validated source ranges. A physical-line ledger preserves metadata, unknown shapes, malformed data, pending tails, and normalization limits.

Recorded content, diagnostic snapshots, request inclusion, and active-context evidence retain separate meanings. A prompt snapshot is diagnostic evidence; it does not add another injection. Provider usage is reconciled by actor-scoped recorded identity, with conflicts excluded from resolved totals. Payload bytes do not claim exact token attribution.

## Local use

Requires Node 22.12 or later.

T3 catalog reads use Node's built-in experimental SQLite module. The start script enables it on Node 22.12; no external SQLite dependency is installed. [Node's SQLite documentation](https://nodejs.org/download/release/v22.12.0/docs/api/sqlite.html) describes the read-only connection option and flag.

    npm install
    npm run typecheck
    npm run build
    npm start

Open the access link printed by the server. It binds to 127.0.0.1 on an automatically assigned port. The random credential is consumed from the URL fragment, retained only in tab memory, and removed from the address bar. Reloading requires reopening the access link.

Keep the server process running while using the app. When launching it manually, keep its terminal open. If the page reports that it cannot reach the local server, start the app again and open the new access link; an already loaded page cannot read files after its server stops.

    npm start -- --port 8766
    npm start -- --root /absolute/path/to/session-directory

An explicit root replaces the default roots for that launch. Default roots are .codex/sessions, .codex/archived_sessions, and .claude/projects under the current user's home. Realpath containment applies, including junctions/symlinks. Source files are read-only. No source content, index, or body cache is persisted by the app or sent to remote services.

The T3 catalog source is the current user's .t3/userdata/state.sqlite. Each operation opens a read-only connection with query_only enabled, validates the required schema, reads a short transaction, and closes it. Only allowlisted columns from projection_threads, projection_projects, and provider_session_runtime are read. Authentication tables, messages, orchestration history, and runtime payload bodies are outside this increment. An absent, busy, or unsupported catalog produces a visible error; Claude/Codex selection and explicit paths remain available.

T3 catalog rows and provider JSONL records retain separate evidence references. Inspect binding row opens the captured SQL projection, its row key, columns, and SHA-256 after revalidation; Inspect log identity opens the corroborating JSONL field. Mutable rows produce a stale-reference error when changed. A database projection hash does not hash the entire database or every row column.

## Current scope and limits

This is the Beginning slice. Full conversation/tool navigation, context/compaction charts, diagnostics, child navigation, and enriched discovery/refresh are subsequent increments.

- Raw scanning uses UTF-8 byte offsets, physical LF/CRLF delimiters, and SHA-256 record hashes. An unterminated tail remains pending.
- Normalization is capped at 8 MiB per record; larger records keep raw byte references and range access.
- One selected in-memory index retains at most 100,000 record references, 3,000 evidence items, and 20,000 call groups. Deliberate limits remain visible in coverage.
- Source views return up to 32 KiB at a time after validating the entire referenced record. Large-record access can therefore take time.
- The source list reads file stats only, with a four-second/20,000-file budget. A partial list states its limits; ordering is recent within inspected candidates.
- T3 lists up to 50 current non-deleted threads per live page, including archived threads. Titles/project names and workspace paths use 512/2,048-character display prefixes. Catalog pages can change while T3 runs.
- Current links use Codex resume_cursor_json.threadId or Claude Agent resume_cursor_json.resume. Claude cursor.threadId is the T3 thread ID. Provider instance and local environment stay explicit; unsupported providers retain catalog metadata only.
- Log discovery examines filenames containing that provider ID inside allowed roots (four seconds, 20,000 entries, 100 candidates), then corroborates the ID within 512 KiB / 64 complete prefix records. Filename, time, project, and equal text alone do not verify a link. Incomplete or multiple matches require an explicit recording choice.
- No matching candidate means recording not located within that coverage. It does not prove absence elsewhere. Missing current cursors and unknown providers remain separate states. Historical provider switches, replaced cursors, and child actors are not recovered by current runtime bindings.
- Selected T3 metadata is bounded to 24 KiB of cell values / 32 KiB of serialized evidence per row; references are memory-only, capped at 200 and expire after ten minutes. No T3 content is added to provider injections, usage totals, or reconstructed requests.
- Reopening a session rebuilds the index. Missing/stale evidence produces an error instead of replacing historical content with current instructions.
- No automated test suite is included.

Code lives in src/core (byte/source/evidence contracts), src/adapters (provider formats), src/server (local read service), and src/ui (React).
