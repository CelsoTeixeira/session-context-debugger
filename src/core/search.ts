import { randomUUID } from 'node:crypto';
import { scan } from './scanner.js';
import { abortIfNeeded, DataError } from './source.js';
import type { RecordMeta, SearchMatch, SearchView, SourceFile } from './types.js';

const MAX_MATCHES = 100;
const MAX_MS = 30_000;

// One result per physical record, with bounded overlap/preview buffers. This
// reads raw UTF-8 bytes, including rows outside normalization/index limits.
export class SourceSearch {
  readonly controller = new AbortController();
  readonly view: SearchView;
  done?: Promise<void>;
  constructor(query: string, source: SourceFile) {
    if (!query.length || query.length > 256 || /[\r\n]/.test(query) || Buffer.from(query).toString('utf8') !== query) {
      throw new DataError('invalid-request', 'Use 1–256 characters of literal text without line breaks.');
    }
    this.view = { id: randomUUID(), query, state: 'searching', scannedBytes: 0, snapshotBytes: source.size,
      scannedRecords: 0, matches: [], maxMatches: MAX_MATCHES, detail: 'Searching the selected raw-source snapshot.' };
  }
  async run(source: SourceFile, records: ReadonlyMap<string, RecordMeta>, prefixSha256: string,
    signal: AbortSignal, resolvePath: () => Promise<string>): Promise<void> {
    const needle = Buffer.from(this.view.query, 'utf8');
    const started = Date.now();
    let tail = Buffer.alloc(0);
    let found: { offset: number; preview: string } | undefined;
    const check = (): void => {
      abortIfNeeded(signal); abortIfNeeded(this.controller.signal);
      if (Date.now() - started >= MAX_MS) throw new DataError('search-limit', 'Search stopped at its 30-second limit. Coverage is incomplete.');
    };
    try {
      if (await resolvePath() !== source.resolvedPath) throw new DataError('stale-reference', 'Source location changed. Reopen the recording.', 409);
      check();
      const hash = await scan(source, ({ ref, pending }) => {
        check();
        const indexed = records.get(ref.id)?.ref;
        if (indexed && (indexed.sha256 !== ref.sha256 || indexed.offset !== ref.offset || indexed.byteLength !== ref.byteLength || indexed.delimiterLength !== ref.delimiterLength)) {
          throw new DataError('stale-reference', 'Source changed since indexing. Reopen the recording.', 409);
        }
        this.view.scannedRecords++;
        this.view.scannedBytes = ref.offset + ref.byteLength + ref.delimiterLength;
        if (found) this.view.matches.push({ ref, matchOffset: found.offset, preview: found.preview, pending });
        tail = Buffer.alloc(0); found = undefined;
        if (this.view.matches.length >= MAX_MATCHES && this.view.scannedBytes < source.size) {
          throw new DataError('search-limit', 'Showing the first 100 matching records. Search stopped; coverage is incomplete.');
        }
      }, bytes => { this.view.scannedBytes = bytes; }, this.controller.signal, {
        capture: false,
        onPart: (part, _line, offset) => {
          check();
          if (found) return;
          const bytes = Buffer.concat([tail, part]);
          const match = bytes.indexOf(needle);
          if (match >= 0) {
            let start = Math.max(0, match - 80), end = Math.min(bytes.length, match + needle.length + 80);
            while (start < match && (bytes[start]! & 0xc0) === 0x80) start++;
            if (end < bytes.length) while (end > match + needle.length && (bytes[end]! & 0xc0) === 0x80) end--;
            else {
              let lead = end - 1;
              while (lead > match + needle.length && (bytes[lead]! & 0xc0) === 0x80) lead--;
              const byte = bytes[lead]!;
              const length = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
              if (lead + length > end) end = lead;
            }
            found = { offset: offset - tail.length + match, preview: bytes.subarray(start, end).toString('utf8') };
            tail = Buffer.alloc(0);
          } else tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - Math.max(needle.length - 1, 80))));
        },
      });
      check();
      if (hash !== prefixSha256) throw new DataError('stale-reference', 'Source snapshot changed since indexing. Reopen the recording.', 409);
      this.view.state = 'complete';
      this.view.detail = 'Complete raw-source snapshot searched and prefix hash validated. Later appends are outside this snapshot.';
    } catch (error) {
      if (error instanceof DataError && error.code === 'search-limit') {
        this.view.state = 'limited'; this.view.detail = error.message;
      } else if (signal.aborted || this.controller.signal.aborted) {
        this.view.state = 'cancelled'; this.view.detail = 'Search cancelled. Coverage is incomplete; retained matches cover only inspected records.';
      } else {
        this.view.state = 'error'; this.view.detail = error instanceof Error ? error.message : 'Source search failed.';
        this.view.matches = [];
      }
    }
  }
  record(id: string): SearchMatch | undefined { return this.view.state === 'error' ? undefined : this.view.matches.find(match => match.ref.id === id); }
}
