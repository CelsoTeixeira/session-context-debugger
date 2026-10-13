import { open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { T3Catalog } from './t3.js';
import { abortIfNeeded, DataError, Sources } from './source.js';
import { object, string } from './json.js';
import type { Family, LogMatch, SourceRef, T3Resolution } from './types.js';

const providerUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const prefixBytes = 512 * 1024;
const maxNativeIdBytes = 512;

function providerFamily(provider: unknown, driver: unknown): Family {
  if (provider !== driver) return 'unknown';
  return provider === 'codex' ? 'codex' : provider === 'claudeAgent' ? 'claude' : 'unknown';
}

function nativeProviderId(row: Record<string, unknown>): { id?: string; issue?: string } {
  if (Number(row.payload_json_bytes) > 24 * 1024) {
    return { issue: 'The provider-state payload exceeds the bounded JSON extraction limit; no provider ID was read.' };
  }
  if (row.payload_json_valid !== 1) {
    return { issue: 'The active provider-thread payload JSON is malformed; no provider ID was inferred.' };
  }
  const type = string(row.native_id_type);
  if (type === undefined) return { issue: 'The nativeThreadRef.nativeId field is missing from the active provider thread.' };
  if (type !== 'text') return { issue: 'The nativeThreadRef.nativeId field is present but is not a string.' };
  const bytes = Number(row.native_id_bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    return { issue: 'The nativeThreadRef.nativeId field could not be measured safely.' };
  }
  if (bytes > maxNativeIdBytes) {
    return { issue: 'The nativeThreadRef.nativeId field exceeds the 512-byte limit and was not exposed.' };
  }
  const id = string(row['payload_json.nativeThreadRef.nativeId']);
  if (id === undefined) return { issue: 'The bounded nativeThreadRef.nativeId field could not be read as a string.' };
  if (!id) return { issue: 'The nativeThreadRef.nativeId field is empty.' };
  if (!providerUuid.test(id)) {
    return { issue: 'The provider-native ID is present but is not a supported UUID; no filename, project, time, or text heuristic is substituted.' };
  }
  return { id };
}

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
    const { thread, refs, providerThread, bindingIssue } = await this.catalog.binding(threadId);
    abortIfNeeded(signal);
    const result: T3Resolution = { id: randomUUID(), thread, refs, status: 'unlinked', matches: [], complete: null,
      warnings: ['Only the captured active provider-thread and session binding are covered. Historical provider switches, replaced bindings, and child actors are unknown. T3 metadata is not another provider injection or a request payload.'] };
    if (!providerThread) result.warnings.push(bindingIssue ?? 'No complete active provider-thread binding is recorded for this thread.');
    else {
      const family = providerFamily(providerThread.provider, providerThread.driver);
      result.providerInstance = string(providerThread.provider_instance_id);
      if (family === 'unknown') {
        result.status = 'unsupported';
        result.warnings.push('This active provider and driver have catalog metadata, but their recording adapter is unsupported.');
      } else {
        const native = nativeProviderId(providerThread);
        if (!native.id) result.warnings.push(native.issue ?? 'The active provider-native ID is unavailable.');
        else {
          const id = native.id;
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
    const bindingTables = [
      'orchestration_v2_projection_threads',
      'orchestration_v2_projection_provider_threads',
      'orchestration_v2_projection_provider_session_bindings',
    ];
    const bindingRefs = bindingTables.map(table => result.refs.find(ref => ref.table === table));
    if (bindingRefs.some(ref => !ref)) {
      throw new DataError('stale-reference', 'The captured active provider binding is incomplete. Reselect the T3 thread.', 409);
    }
    const threadRef = bindingRefs[0]!;
    const providerThreadRef = bindingRefs[1]!;
    const sessionBindingRef = bindingRefs[2]!;
    const revalidateBinding = async (): Promise<void> => {
      await Promise.all([
        this.catalog.validateLinkBinding(threadRef.id),
        this.catalog.evidence(providerThreadRef.id),
        this.catalog.evidence(sessionBindingRef.id),
      ]);
    };
    await revalidateBinding();
    const family: Family = result.thread.provider === 'codex' ? 'codex'
      : result.thread.provider === 'claudeAgent' ? 'claude' : 'unknown';
    if (family === 'unknown') throw new DataError('stale-reference', 'The captured provider adapter is unsupported. Reselect the T3 thread.', 409);
    const current = await identity(this.sources, match.path, family, result.providerId, signal);
    if (!current || current.sha256 !== match.identity.sha256 || current.offset !== match.identity.offset) throw new DataError('stale-reference', 'Provider identity evidence changed. Reselect the T3 thread.', 409);
    await revalidateBinding();
    abortIfNeeded(signal);
    if (this.selected !== result) throw new DataError('cancelled', 'A newer T3 selection replaced this request.', 409);
    return match;
  }
}
