import { open, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { adaptCodex } from '../adapters/codex/index.js';
import { adaptClaude } from '../adapters/claude/index.js';
import { identifier, object } from './json.js';
import { Normalizer } from './normalize.js';
import { MAX_ITEMS, MAX_RECORDS, PARSE_BYTES, PREVIEW_UNITS, scan } from './scanner.js';
import { abortIfNeeded, DataError, Sources } from './source.js';
import type { CoverageLedger, Overview, RecordMeta, RecordView, SourceFile, SourceRef } from './types.js';

const ledger = (bytes: number): CoverageLedger => ({
  inspectedBytes: bytes, scannedBytes: 0, completeLines: 0, pendingBytes: 0,
  dispositions: { event: 0, metadata: 0, unknown: 0, malformed: 0, limited: 0, pending: 0 },
  outerTypes: {}, payloadTypes: {}, itemTypes: {}, indexedRecords: 0, normalizedItems: 0,
  normalizationLimited: 0, complete: false,
});
const count = (counts: Record<string, number>, key?: string): void => {
  if (key) counts[key] = (counts[key] ?? 0) + 1;
};

export class Session {
  readonly id = randomUUID();
  readonly controller = new AbortController();
  readonly records = new Map<string, RecordMeta>();
  readonly normalizer: Normalizer;
  readonly coverage: CoverageLedger;
  state: Overview['state'] = 'indexing';
  error?: string;
  done?: Promise<void>;
  linkedIdentity?: SourceRef;
  constructor(readonly source: SourceFile, readonly sources: Sources) {
    this.normalizer = new Normalizer(source);
    this.coverage = ledger(source.size);
  }
  async index(): Promise<void> {
    try {
      this.coverage.prefixSha256 = await scan(this.source, ({ ref, bytes, pending }) => {
        if (this.linkedIdentity?.id === ref.id && (pending || ref.sha256 !== this.linkedIdentity.sha256 || ref.offset !== this.linkedIdentity.offset)) {
          throw new DataError('stale-reference', 'Linked provider identity changed during indexing. Reselect the T3 thread.', 409);
        }
        const meta: RecordMeta = { ref, outerType: '(unparsed)', disposition: 'unknown' };
        if (this.records.size < MAX_RECORDS) this.records.set(ref.id, meta);
        else this.normalizer.warnings.add('Record index limit reached; remaining physical lines are counted but range navigation is incomplete.');
        if (pending) {
          meta.disposition = 'pending';
          this.coverage.pendingBytes = ref.byteLength;
        } else if (!bytes) {
          meta.disposition = 'limited';
          meta.reason = 'Record exceeds the 8 MiB normalization limit; raw ranges remain available.';
        } else {
          try {
            const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
            const record = object(value);
            const payload = object(record.payload);
            meta.outerType = identifier(record.type) ?? '(missing or over-limit type)';
            meta.payloadType = identifier(payload.type);
            meta.itemType = identifier(object(payload.item).type) ?? identifier(object(record.attachment).type);
            if (this.source.family === 'unknown') {
              if (record.type === 'session_meta') this.source.family = 'codex';
              else if (record.sessionId && record.message || record.type === 'attachment' && record.attachment) this.source.family = 'claude';
            }
            if (this.source.family === 'codex') adaptCodex(record, meta, this.normalizer);
            else if (this.source.family === 'claude') adaptClaude(record, meta, this.normalizer);
          } catch (error) {
            meta.disposition = 'malformed';
            meta.reason = error instanceof Error ? error.message.slice(0, 200) : 'Unable to decode record.';
          }
        }
        count(this.coverage.dispositions, meta.disposition);
        if (!pending) this.coverage.completeLines++;
        count(this.coverage.outerTypes, meta.outerType);
        count(this.coverage.payloadTypes, meta.payloadType);
        count(this.coverage.itemTypes, meta.itemType);
        this.coverage.indexedRecords = this.records.size;
        this.coverage.normalizedItems = this.normalizer.items.length;
        this.coverage.normalizationLimited = this.normalizer.limitedItems;
      }, bytes => { this.coverage.scannedBytes = bytes; }, this.controller.signal);
      if (this.linkedIdentity && !this.records.has(this.linkedIdentity.id)) {
        throw new DataError('stale-reference', 'Linked provider identity is missing from the indexed snapshot. Reselect the T3 thread.', 409);
      }
      this.coverage.complete = true;
      this.state = 'ready';
    } catch (error) {
      this.state = this.controller.signal.aborted ? 'cancelled' : 'error';
      this.error = error instanceof Error ? error.message : 'Indexing failed.';
    }
  }
  overview(): Overview {
    const calls = [...this.normalizer.calls.values()];
    const firstCall = calls[0];
    const items = this.normalizer.items;
    const prompts = items.filter(item => item.kind === 'prompt');
    const firstPrompt = prompts.find(item => item.origin === 'human-recorded')
      ?? prompts.find(item => item.origin === 'submitted-author-unknown') ?? prompts[0];
    const warnings = [...this.normalizer.warnings];
    if (this.error) warnings.push(this.error);
    if (!firstPrompt && this.state === 'ready') warnings.push('No supported submitted/human prompt was recorded within normalization coverage.');
    if (!firstCall && this.state === 'ready') warnings.push('No supported provider usage identity was found. Runtime counters are not substituted.');
    if (this.coverage.dispositions.unknown) warnings.push('Unknown shapes are preserved in the source ledger.');
    if (this.coverage.dispositions.limited) warnings.push('Oversized records are hash-indexed, with incomplete normalization.');
    if (this.coverage.pendingBytes) warnings.push('An unterminated trailing region is pending, even if its JSON might be parseable.');
    if (this.normalizer.limitedItems) warnings.push('Evidence-item limit reached; body normalization is incomplete.');
    if (items.filter(item => item.kind !== 'prompt' && item.representation !== 'diagnostic-snapshot'
      && item.ref.line <= (firstCall?.firstLine ?? Number.MAX_SAFE_INTEGER)).length > 200) {
      warnings.push('Beginning shows at most 200 startup resources; additional captures remain in raw ledger records.');
    }
    if (items.filter(item => item.kind === 'snapshot').length > 200) warnings.push('Showing at most 200 snapshots; additional physical records remain in the ledger.');
    return {
      id: this.id, state: this.state, source: this.source, coverage: this.coverage, firstPrompt,
      startup: items.filter(item => item.kind !== 'prompt' && item.representation !== 'diagnostic-snapshot'
        && item.ref.line <= (firstCall?.firstLine ?? Number.MAX_SAFE_INTEGER)).slice(0, 200),
      snapshots: items.filter(item => item.kind === 'snapshot').slice(0, 200),
      firstCall, callCount: calls.length, ambiguousCalls: calls.filter(call => call.status === 'ambiguous').length,
      warnings, limits: { parseBytes: PARSE_BYTES, previewCodeUnits: PREVIEW_UNITS, maxRecords: MAX_RECORDS, maxItems: MAX_ITEMS },
    };
  }
  async record(refId: string, pointer: string | undefined, offset: number, signal?: AbortSignal): Promise<RecordView> {
    const record = this.records.get(refId);
    if (!record) throw new DataError('unavailable-source', 'Record is outside the retained index or unavailable.', 404);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.ref.byteLength && !pointer) {
      throw new DataError('invalid-range', 'Invalid record range.');
    }
    if (pointer && !(this.linkedIdentity?.id === refId && this.linkedIdentity.pointer === pointer) && !this.normalizer.items.some(item => item.ref.id === refId && item.ref.pointer === pointer)
      && ![...this.normalizer.calls.values()].some(call => call.variants.some(variant => variant.refs.some(ref => ref.id === refId && ref.pointer === pointer)))) {
      throw new DataError('invalid-pointer', 'Select a recorded evidence field.');
    }
    const path = (await this.sources.resolve(this.source.resolvedPath)).path;
    if (path !== this.source.resolvedPath) throw new DataError('stale-reference', 'Source location changed.', 409);
    const handle = await open(path, 'r');
    const hash = createHash('sha256');
    let parsedParts: Buffer[] = [];
    let rawParts: Buffer[] = [];
    const rangeEnd = Math.min(record.ref.byteLength, offset + 32 * 1024);
    try {
      const info = await handle.stat();
      if (info.size < record.ref.offset + record.ref.byteLength + record.ref.delimiterLength) {
        throw new DataError('stale-reference', 'Source was truncated.', 409);
      }
      for (let position = 0; position < record.ref.byteLength;) {
        abortIfNeeded(signal);
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, record.ref.byteLength - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, record.ref.offset + position);
        if (!bytesRead) throw new DataError('stale-reference', 'Source changed while reading.', 409);
        const bytes = buffer.subarray(0, bytesRead);
        hash.update(bytes);
        if (pointer && record.ref.byteLength <= PARSE_BYTES) parsedParts.push(Buffer.from(bytes));
        if (!pointer && position < rangeEnd && position + bytesRead > offset) {
          rawParts.push(Buffer.from(bytes.subarray(Math.max(0, offset - position), Math.min(bytesRead, rangeEnd - position))));
        }
        position += bytesRead;
      }
      if (hash.digest('hex') !== record.ref.sha256) throw new DataError('stale-reference', 'Record hash changed. Reopen the session.', 409);
      if (pointer) {
        if (record.ref.byteLength > PARSE_BYTES) throw new DataError('processing-limit', 'Field decoding exceeds the 8 MiB limit; use raw ranges.', 413);
        let value: unknown = JSON.parse(Buffer.concat(parsedParts).toString('utf8'));
        for (const part of pointer.slice(1).split('/')) {
          const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
          if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new DataError('stale-reference', 'Recorded field is unavailable.', 409);
          value = (value as Record<string, unknown>)[key];
        }
        const field = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
        if (offset > field.length) throw new DataError('invalid-range', 'Invalid field range.');
        const end = Math.min(field.length, offset + 32 * 1024);
        const slice = utf8Range(field, offset, end);
        return { ref: { ...record.ref, pointer }, view: 'field', text: slice.toString('utf8'), offsetWithinRecord: offset,
          returnedBytes: slice.length, totalBytes: field.length, nextOffset: offset + slice.length < field.length ? offset + slice.length : undefined,
          limited: offset > 0 || offset + slice.length < field.length, validated: true };
      }
      const raw = Buffer.concat(rawParts);
      const slice = utf8Range(raw, 0, raw.length);
      return { ref: record.ref, view: 'raw', text: slice.toString('utf8'), offsetWithinRecord: offset,
        returnedBytes: slice.length, totalBytes: record.ref.byteLength,
        nextOffset: offset + slice.length < record.ref.byteLength ? offset + slice.length : undefined,
        limited: offset > 0 || offset + slice.length < record.ref.byteLength, validated: true };
    } finally { parsedParts = []; rawParts = []; await handle.close(); }
  }
}

function utf8Range(bytes: Buffer, start: number, end: number): Buffer {
  // Pages begin at boundaries returned by this function. Avoid splitting a
  // multi-byte character at the end of a range; source offsets stay byte-based.
  let safeEnd = end;
  if (safeEnd < bytes.length) while (safeEnd > start && (bytes[safeEnd]! & 0xc0) === 0x80) safeEnd--;
  else if (safeEnd > start) {
    let lead = safeEnd - 1;
    while (lead > start && (bytes[lead]! & 0xc0) === 0x80) lead--;
    const byte = bytes[lead]!;
    const length = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
    if (lead + length > safeEnd) safeEnd = lead;
  }
  return bytes.subarray(start, safeEnd);
}

export class Sessions {
  readonly entries = new Map<string, Session>();
  private serial = 0;
  constructor(readonly sources: Sources) {}
  async open(path: string, signal?: AbortSignal, identity?: SourceRef): Promise<Session> {
    const serial = ++this.serial;
    const resolved = await this.sources.resolve(path);
    const info = await stat(resolved.path);
    abortIfNeeded(signal);
    if (serial !== this.serial) throw new DataError('cancelled', 'A newer recording selection replaced this request.', 409);
    // One selected index: changing selection cancels/releases the old index.
    for (const session of this.entries.values()) session.controller.abort();
    this.entries.clear();
    const source: SourceFile = { id: randomUUID(), generation: randomUUID(), originalPath: path,
      resolvedPath: resolved.path, family: resolved.family, size: info.size, modifiedAt: info.mtime.toISOString() };
    const session = new Session(source, this.sources);
    if (identity) session.linkedIdentity = { ...identity, sourceId: source.id, generation: source.generation };
    this.entries.set(session.id, session);
    session.done = session.index();
    return session;
  }
  get(id: string): Session {
    const session = this.entries.get(id);
    if (!session) throw new DataError('unavailable-source', 'Session was evicted or is unavailable. Reopen its path.', 404);
    return session;
  }
}
