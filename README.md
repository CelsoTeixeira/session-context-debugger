# Session Context Debugger

A local browser app for inspecting recorded Codex/T3 Code and Claude Code sessions, including Desktop Code and SDK origins.

The first slice opens a local JSONL file or a stat-only recent-file candidate, separates the first submitted/human-recorded input from captured setup, shows first-response usage, and links evidence to hash-validated source ranges. A physical-line ledger preserves metadata, unknown shapes, malformed data, pending tails, and normalization limits.

Recorded content, diagnostic snapshots, request inclusion, and active-context evidence retain separate meanings. A prompt snapshot is diagnostic evidence; it does not add another injection. Provider usage is reconciled by actor-scoped recorded identity, with conflicts excluded from resolved totals. Payload bytes do not claim exact token attribution.

## Local use

Requires Node 22.12 or later.

    npm install
    npm run typecheck
    npm run build
    npm start

Open the access link printed by the server. It binds to 127.0.0.1 on an automatically assigned port. The random credential is consumed from the URL fragment, retained only in tab memory, and removed from the address bar. Reloading requires reopening the access link.

Keep the server process running while using the app. When launching it manually, keep its terminal open. If the page reports that it cannot reach the local server, start the app again and open the new access link; an already loaded page cannot read files after its server stops.

    npm start -- --port 8766
    npm start -- --root /absolute/path/to/session-directory

An explicit root replaces the default roots for that launch. Default roots are .codex/sessions, .codex/archived_sessions, and .claude/projects under the current user's home. Realpath containment applies, including junctions/symlinks. Source files are read-only. No source content, index, or body cache is persisted by the app or sent to remote services.

## Current scope and limits

This is the Beginning slice. Full conversation/tool navigation, context/compaction charts, diagnostics, child navigation, and enriched discovery/refresh are subsequent increments.

- Raw scanning uses UTF-8 byte offsets, physical LF/CRLF delimiters, and SHA-256 record hashes. An unterminated tail remains pending.
- Normalization is capped at 8 MiB per record; larger records keep raw byte references and range access.
- One selected in-memory index retains at most 100,000 record references, 3,000 evidence items, and 20,000 call groups. Deliberate limits remain visible in coverage.
- Source views return up to 32 KiB at a time after validating the entire referenced record. Large-record access can therefore take time.
- The source list reads file stats only, with a four-second/20,000-file budget. A partial list states its limits; ordering is recent within inspected candidates.
- Reopening a session rebuilds the index. Missing/stale evidence produces an error instead of replacing historical content with current instructions.
- No automated test suite is included.

Code lives in src/core (byte/source/evidence contracts), src/adapters (provider formats), src/server (local read service), and src/ui (React).
