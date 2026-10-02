import { open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { T3Catalog } from './t3.js';
import { abortIfNeeded, DataError, Sources } from './source.js';
import { object, string } from './json.js';
import type { Family, LogMatch, SourceRef, T3Resolution } from './types.js';

const providerUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const prefixBytes = 512 * 1024;

async function identity(sources: Sources, path: string, family: Family, expectedId: string, signal?: AbortSignal): Promise<SourceRef | undefined> {
  abortIfNeeded(signal);
  const resolved = await sources.resolve(path);
  const handle = await open(resolved.path, 'r');
  try {
    const bytes = Buffer.alloc(prefixBytes);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    abortIfNeeded(signal);
    let offset = 0;
    for (let line = 1; line <= 64; line++) {
      const end = bytes.subarray(0, bytesRead).indexOf(10, offset);
      if (end < 0) break; // Unterminated / oversized prefixes never prove a link.
      const crlf = bytes[end - 1] === 13;
      const record = bytes.subarray(offset, end - (crlf ? 1 : 0));
      try {
        const value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record)));
        const recorded = family === 'codex' && value.type === 'session_meta' ? string(object(value.payload).id)
          : family === 'claude' ? string(value.sessionId) : undefined;
        if (recorded) {
          if (recorded !== expectedId) return undefined;
          return { id: 'r' + line, sourceId: randomUUID(), generation: randomUUID(), line, offset,
            byteLength: record.length, delimiterLength: crlf ? 2 : 1,
            sha256: createHash('sha256').update(record).digest('hex'), pointer: family === 'codex' ? '/payload/id' : '/sessionId' };
        }
      } catch { /* Malformed records remain unknown; they cannot corroborate. */ }
      offset = end + 1;
    }
    return undefined;
  } finally { await handle.close(); }
}

export class T3Links {
  private selected?: T3Resolution;
  private serial = 0;
  constructor(readonly catalog: T3Catalog, readonly sources: Sources) {}

  async resolve(threadId: string, signal?: AbortSignal): Promise<T3Resolution> {
    const serial = ++this.serial;
    const { thread, refs, runtime } = await this.catalog.binding(threadId);
    abortIfNeeded(signal);
    const result: T3Resolution = { id: randomUUID(), thread, refs, status: 'unlinked', matches: [], complete: null,
      warnings: ['Only the captured current runtime binding is covered. Historical provider switches, replaced cursors, and child actors are unknown. T3 metadata is not another provider injection or a request payload.'] };
    if (!runtime) result.warnings.push('No current provider runtime binding is recorded for this thread.');
    else {
      const family: Family = runtime.provider_name === 'codex' ? 'codex' : runtime.provider_name === 'claudeAgent' ? 'claude' : 'unknown';
      result.providerInstance = string(runtime.provider_instance_id);
      if (family === 'unknown') {
        result.status = 'unsupported';
        result.warnings.push('This provider has catalog metadata, but its recording adapter is unsupported.');
      } else {
        let cursor: Record<string, unknown> = {};
        try { cursor = object(JSON.parse(String(runtime.resume_cursor_json))); }
        catch { result.warnings.push('The current resume cursor is malformed; no provider ID was inferred.'); }
        const id = string(cursor[family === 'codex' ? 'threadId' : 'resume']);
        const bindingRef = refs.find(ref => ref.table === 'provider_session_runtime')!;
        bindingRef.pointer = family === 'codex' ? '/threadId' : '/resume';
        if (!id || !providerUuid.test(id)) result.warnings.push('A supported provider ID is absent from the current cursor. No filename, project, time, or text heuristic is substituted.');
        else {
          result.providerId = id;
          const candidates = await this.sources.locate(family, id, signal);
          result.complete = candidates.complete;
          result.warnings.push(...candidates.warnings);
          for (const path of candidates.paths) {
            abortIfNeeded(signal);
            try {
              const ref = await identity(this.sources, path, family, id, signal);
              if (ref) result.matches.push({ id: randomUUID(), path, identity: ref });
              else { result.complete = false; result.warnings.push('A filename candidate could not corroborate its ID within 512 KiB / 64 complete records.'); }
            } catch {
              abortIfNeeded(signal);
              result.complete = false;
              result.warnings.push('A candidate recording became unavailable during identity verification.');
            }
          }
          result.status = result.matches.length > 1 || result.matches.length === 1 && !result.complete ? 'ambiguous'
            : result.matches.length === 1 ? 'verified' : 'log-missing';
        }
      }
    }
    abortIfNeeded(signal);
    if (serial !== this.serial) throw new DataError('cancelled', 'A newer T3 selection replaced this request.', 409);
    this.selected = result;
    return result;
  }

  async validate(threadId: string, resolutionId: string, matchId: string, signal?: AbortSignal): Promise<LogMatch> {
    const result = this.selected;
    if (!result || result.id !== resolutionId || result.thread.id !== threadId) throw new DataError('stale-reference', 'T3 link selection expired. Reselect the thread.', 409);
    const match = result.matches.find(match => match.id === matchId);
    if (!match || !result.providerId) throw new DataError('invalid-request', 'Select a corroborated recording.');
    const binding = result.refs.find(ref => ref.table === 'provider_session_runtime')!;
    await this.catalog.evidence(binding.id);
    const family = result.thread.provider === 'codex' ? 'codex' : 'claude';
    const current = await identity(this.sources, match.path, family, result.providerId, signal);
    if (!current || current.sha256 !== match.identity.sha256 || current.offset !== match.identity.offset) throw new DataError('stale-reference', 'Provider identity evidence changed. Reselect the T3 thread.', 409);
    await this.catalog.evidence(binding.id);
    abortIfNeeded(signal);
    if (this.selected !== result) throw new DataError('cancelled', 'A newer T3 selection replaced this request.', 409);
    return match;
  }
}
