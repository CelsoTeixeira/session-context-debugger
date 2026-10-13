import type {
  CompactionKind, ContextEvidenceEntry, ContextEvidenceFields, ContextField, ContextFieldState,
  ContextList, ContextMetadataEntry, ContextOwnerAxis, ContextRepresentationEntry, ContextReplacementEntry,
  ContextRetainedEntry, ContextWindowCoverage, ContextWindowEntry, ContextWindowOwner, Family, SourceFile,
  SourceRef, ContextWindowPage,
} from './types.js';
import { DataError } from './source.js';

export const MAX_CONTEXT_WINDOWS = 1000;
export const MAX_CONTEXT_REPRESENTATIONS = 1000;
export const MAX_CONTEXT_WINDOWS_PER_PAGE = 50;
export const MAX_CONTEXT_METADATA_BYTES = 4 * 1024 * 1024;
export const MAX_CONTEXT_LIST_PREVIEW = 20;
export const MAX_CONTEXT_VALUE_BYTES = 512;

type TimelineTarget = { id: string; position: number };
type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const has = (value: JsonObject, key: string): boolean => Object.hasOwn(value, key);
const pointerPart = (value: string | number): string => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
const joinPointer = (base: string, key: string | number): string => base + '/' + pointerPart(key);
const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

function boundedString(value: string): { value: string; truncated: boolean } {
  let prefix = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > MAX_CONTEXT_VALUE_BYTES) return { value: prefix, truncated: true };
    prefix += character;
    bytes += size;
  }
  return { value: prefix, truncated: false };
}

function objectValue(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function metadataIncomplete(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(metadataIncomplete);
  const object = value as JsonObject;
  if (object.state === 'over-limit' || object.truncated === true || typeof object.omitted === 'number' && object.omitted > 0
    || typeof object.omittedKeys === 'number' && object.omittedKeys > 0) return true;
  return Object.values(object).some(metadataIncomplete);
}

function fieldState(value: unknown, present: boolean): ContextFieldState {
  if (!present) return 'missing';
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') return 'recorded';
  return 'malformed';
}

function contextField(value: unknown, present: boolean, ref?: SourceRef): ContextField {
  const state = fieldState(value, present);
  if (state === 'missing') return { state };
  if (state === 'null' || state === 'malformed') return { state, ref };
  if (typeof value === 'string') {
    const bounded = boundedString(value);
    return { state: bounded.truncated ? 'over-limit' : 'recorded', value: bounded.value, truncated: bounded.truncated || undefined, ref };
  }
  return { state: 'recorded', value: value as number | boolean, ref };
}

function axis(value: unknown, present: boolean, ref?: SourceRef): ContextOwnerAxis {
  if (!present) return { state: 'missing', basis: 'unknown-source-instance' };
  if (value === null) return { state: 'null', basis: 'source-record', ref };
  if (typeof value !== 'string') return { state: 'malformed', basis: 'source-record', ref };
  const bounded = boundedString(value);
  return { state: bounded.truncated ? 'over-limit' : 'recorded', value: bounded.value,
    truncated: bounded.truncated || undefined, basis: 'source-record', ref };
}

function emptyList<T>(state: ContextFieldState, ref?: SourceRef, name?: string): ContextList<T> {
  return { name, state, items: [], omitted: 0, ref };
}

function fieldNames(value: JsonObject): { names: string[]; omitted: number } {
  const keys = Object.keys(value);
  const names: string[] = [];
  for (const key of keys) {
    const bounded = boundedString(key);
    if (bounded.truncated) continue;
    names.push(key);
    if (names.length === MAX_CONTEXT_LIST_PREVIEW) break;
  }
  return { names, omitted: Math.max(0, keys.length - names.length) };
}

interface SummaryCandidate {
  entry: ContextRepresentationEntry;
  scopeKey: string;
}

function isSummaryRecord(record: JsonObject): boolean {
  return record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true;
}

function compactionKind(record: JsonObject, family: Family): { kind: CompactionKind; label: string } | undefined {
  const payload = objectValue(record.payload);
  if (family === 'claude' && record.type === 'system' && record.subtype === 'compact_boundary') {
    return { kind: 'claude-compact-boundary', label: 'Claude compact boundary' };
  }
  if (family === 'codex' && record.type === 'compacted') return { kind: 'codex-compacted', label: 'Codex compaction event' };
  if (family === 'codex' && record.type === 'event_msg' && payload.type === 'context_compacted') {
    return { kind: 'codex-context-compacted', label: 'Codex runtime context compaction marker' };
  }
  return undefined;
}

export class ContextWindows {
  private readonly windows: ContextWindowEntry[] = [];
  private readonly representations: ContextRepresentationEntry[] = [];
  private readonly allowedPointers = new Map<string, Set<string>>();
  private readonly lastAnchorByScope = new Map<string, ContextWindowEntry>();
  private readonly summaryCandidates: SummaryCandidate[] = [];
  private readonly sourceInstanceId: string;
  private readonly selectedActor?: ContextOwnerAxis;
  private readonly selectedRoot?: ContextOwnerAxis;
  private recordedSessionDefault?: ContextOwnerAxis;
  private recordedRootDefault?: ContextOwnerAxis;
  private firstRef?: SourceRef;
  private lastRef?: SourceRef;
  private metadataBytes = 0;
  private omittedWindows = 0;
  private omittedRepresentations = 0;
  private omittedMetadataRecords = 0;

  constructor(source: SourceFile, selectedActorId?: string, selectedIdentity?: SourceRef) {
    this.sourceInstanceId = source.id;
    this.selectedActor = selectedActorId ? {
      state: 'selected-source', value: boundedString(selectedActorId).value,
      truncated: boundedString(selectedActorId).truncated || undefined,
      basis: 'selected-source-identity', ref: selectedIdentity,
    } : undefined;
    this.selectedRoot = source.rootSessionId ? {
      state: 'selected-source', value: boundedString(source.rootSessionId).value,
      truncated: boundedString(source.rootSessionId).truncated || undefined,
      basis: 'selected-source-identity', ref: selectedIdentity,
    } : undefined;
  }

  allowsPointer(refId: string, pointer: string): boolean {
    return this.allowedPointers.get(refId)?.has(pointer) ?? false;
  }

  capture(record: JsonObject | undefined, family: Family, ref: SourceRef, target?: TimelineTarget): void {
    this.lastRef = { ...ref };
    const owner = record ? this.owner(record, family, ref) : this.unknownOwner();
    if (!this.firstRef) {
      this.firstRef = { ...ref };
      const start = this.createWindow('recording-start', owner, ref, target);
      this.windows.push(start);
      this.lastAnchorByScope.set(owner.scopeKey, start);
    }
    if (!record) return;

    const boundary = compactionKind(record, family);
    if (boundary) this.captureBoundary(record, family, ref, owner, target, boundary);

    const payload = objectValue(record.payload);
    if (family === 'codex' && record.type === 'response_item' && payload.type === 'compaction') {
      this.captureRepresentation('codex-compaction', 'Codex compaction representation', record, owner, ref, target);
    }
    if (family === 'claude' && isSummaryRecord(record)) {
      this.captureRepresentation('claude-summary', 'Claude compact-summary representation', record, owner, ref, target);
    }
  }

  page(after: number, coverage: Omit<ContextWindowCoverage, 'retainedWindows' | 'omittedWindows' | 'retainedRepresentations' | 'omittedRepresentations' | 'omittedMetadataRecords' | 'retainedMetadataBytes' | 'metadataByteLimit' | 'windowLimit' | 'representationLimit' | 'pageLimit' | 'complete'>): ContextWindowPage {
    const entries: ContextEvidenceEntry[] = [
      ...this.windows.map(window => this.presentWindow(window, coverage.scanComplete)),
      ...this.representations.map(entry => this.presentRepresentation(entry)),
    ].sort((left, right) => this.entryLine(left) - this.entryLine(right) || left.id.localeCompare(right.id));
    if (!Number.isSafeInteger(after) || after < 0 || after > entries.length) throw new DataError('invalid-cursor', 'Invalid context-window cursor.');
    const end = Math.min(entries.length, after + MAX_CONTEXT_WINDOWS_PER_PAGE);
    const page: ContextWindowCoverage = {
      ...coverage,
      retainedWindows: this.windows.length,
      omittedWindows: this.omittedWindows,
      retainedRepresentations: this.representations.length,
      omittedRepresentations: this.omittedRepresentations,
      omittedMetadataRecords: this.omittedMetadataRecords,
      retainedMetadataBytes: this.metadataBytes,
      metadataByteLimit: MAX_CONTEXT_METADATA_BYTES,
      windowLimit: MAX_CONTEXT_WINDOWS,
      representationLimit: MAX_CONTEXT_REPRESENTATIONS,
      pageLimit: MAX_CONTEXT_WINDOWS_PER_PAGE,
      complete: coverage.scanComplete && coverage.indexComplete && this.omittedWindows === 0
        && this.omittedRepresentations === 0 && this.omittedMetadataRecords === 0
        && !this.windows.some(window => window.incomplete)
        && !this.representations.some(entry => entry.owner.scopeBasis !== 'recorded-actor-and-session'
          || metadataIncomplete({ summaryFlags: entry.summaryFlags, uuid: entry.uuid, parentUuid: entry.parentUuid })),
    };
    return { entries: entries.slice(after, end), after: end < entries.length ? end : undefined, total: entries.length, coverage: page };
  }

  private entryLine(entry: ContextEvidenceEntry): number {
    return entry.kind === 'window' ? entry.startRef.line : entry.ref.line;
  }

  private unknownOwner(): ContextWindowOwner {
    const missing = (): ContextOwnerAxis => ({ state: 'missing', basis: 'unknown-source-instance' });
    return { recordedAgent: missing(), selectedSourceActor: this.selectedActor ?? missing(), providerSession: missing(),
      rootSession: this.selectedRoot ?? missing(), scopeKey: this.sourceInstanceId + ':unknown',
      scopeBasis: 'unknown-source-instance', sourceInstanceId: this.sourceInstanceId };
  }

  private owner(record: JsonObject, family: Family, ref: SourceRef): ContextWindowOwner {
    const payload = objectValue(record.payload);
    const agent = this.directIdentity(record, payload, family, 'agent', ref);
    const session = this.directIdentity(record, payload, family, 'session', ref);
    const root = this.directIdentity(record, payload, family, 'root', ref);
    const sourceMetadata = family === 'codex' && record.type === 'session_meta';
    if (sourceMetadata && session.present) this.recordedSessionDefault = session.axis;
    if (sourceMetadata && root.present) this.recordedRootDefault = root.axis;

    const inherited = (value: ContextOwnerAxis | undefined): ContextOwnerAxis | undefined => value ? { ...value, basis: 'inherited-source-record' } : undefined;
    const missing = (): ContextOwnerAxis => ({ state: 'missing', basis: 'unknown-source-instance' });
    const recordedAgent = agent.present ? agent.axis : missing();
    const providerSession = session.present ? session.axis : inherited(this.recordedSessionDefault) ?? missing();
    const rootSession = root.present ? root.axis : inherited(this.recordedRootDefault) ?? this.selectedRoot ?? missing();
    const hasAgent = recordedAgent.state === 'recorded';
    const hasSession = providerSession.state === 'recorded';
    const known = [hasAgent ? recordedAgent.value : undefined, hasSession ? providerSession.value : undefined];
    const scopeKey = this.sourceInstanceId + ':' + JSON.stringify(known);
    const scopeBasis = hasAgent && hasSession ? 'recorded-actor-and-session'
      : hasAgent || hasSession ? 'recorded-partial-scope' : 'unknown-source-instance';
    return { recordedAgent, selectedSourceActor: this.selectedActor ?? { state: 'missing', basis: 'unknown-source-instance' },
      providerSession, rootSession, scopeKey, scopeBasis, sourceInstanceId: this.sourceInstanceId };
  }

  private directIdentity(record: JsonObject, payload: JsonObject, family: Family, kind: 'agent' | 'session' | 'root', recordRef: SourceRef): {
    present: boolean; axis: ContextOwnerAxis; field: ContextField;
  } {
    const candidates: Array<{ object: JsonObject; key: string; pointer: string }> = [];
    if (kind === 'agent') {
      candidates.push({ object: record, key: 'agentId', pointer: '/agentId' });
      candidates.push({ object: payload, key: 'agent_id', pointer: '/payload/agent_id' });
      candidates.push({ object: payload, key: 'actor_id', pointer: '/payload/actor_id' });
    } else if (kind === 'session') {
      candidates.push({ object: record, key: 'sessionId', pointer: '/sessionId' });
      candidates.push({ object: record, key: 'threadId', pointer: '/threadId' });
      candidates.push({ object: payload, key: 'session_id', pointer: '/payload/session_id' });
      candidates.push({ object: payload, key: 'thread_id', pointer: '/payload/thread_id' });
      if (family === 'codex' && record.type === 'session_meta') candidates.push({ object: payload, key: 'id', pointer: '/payload/id' });
    } else {
      candidates.push({ object: record, key: 'rootSessionId', pointer: '/rootSessionId' });
      candidates.push({ object: payload, key: 'root_session_id', pointer: '/payload/root_session_id' });
      candidates.push({ object: payload, key: 'rootSessionId', pointer: '/payload/rootSessionId' });
      if (family === 'claude') candidates.push({ object: record, key: 'sessionId', pointer: '/sessionId' });
    }
    const candidate = candidates.find(item => has(item.object, item.key));
    if (!candidate) return { present: false, axis: { state: 'missing', basis: 'unknown-source-instance' }, field: { state: 'missing' } };
    const sourceRef = { ...recordRef, pointer: candidate.pointer };
    const raw = candidate.object[candidate.key];
    const field = contextField(raw, true, sourceRef);
    return { present: true, axis: axis(raw, true, sourceRef), field };
  }

  private createWindow(anchorKind: ContextWindowEntry['anchorKind'], owner: ContextWindowOwner, ref: SourceRef, target?: TimelineTarget): ContextWindowEntry {
    this.registerRefs(owner);
    return {
      kind: 'window', id: 'context-window:' + ref.id + ':' + ref.sha256 + ':' + anchorKind,
      anchorKind, owner, startRef: { ...ref }, anchorTarget: target,
      startBasis: anchorKind === 'recording-start' ? 'first-retained-complete-physical-record' : 'recorded-compaction-boundary',
      endBasis: 'indexing', endExclusive: false, incomplete: owner.scopeBasis !== 'recorded-actor-and-session',
    };
  }

  private captureBoundary(record: JsonObject, family: Family, ref: SourceRef, owner: ContextWindowOwner, target: TimelineTarget | undefined,
    boundary: { kind: CompactionKind; label: string }): void {
    const previous = this.lastAnchorByScope.get(owner.scopeKey);
    if (previous && previous.startRef.id !== ref.id) {
      previous.endRef = { ...ref };
      previous.endBasis = 'next-same-scope-boundary';
      previous.endExclusive = true;
    }
    const sameAnchor = this.windows.find(window => window.startRef.id === ref.id);
    if (sameAnchor) {
      sameAnchor.anchorTarget = target;
      sameAnchor.boundary = this.boundaryEvidence(record, family, ref, target, boundary);
      sameAnchor.incomplete ||= metadataIncomplete(sameAnchor.boundary.evidence) || owner.scopeBasis !== 'recorded-actor-and-session';
      this.lastAnchorByScope.set(owner.scopeKey, sameAnchor);
      return;
    }
    if (this.windows.length >= MAX_CONTEXT_WINDOWS) {
      this.omittedWindows++;
      this.lastAnchorByScope.delete(owner.scopeKey);
      return;
    }
    const window = this.createWindow('compaction', owner, ref, target);
    window.boundary = this.boundaryEvidence(record, family, ref, target, boundary);
    window.incomplete = owner.scopeBasis !== 'recorded-actor-and-session' || metadataIncomplete(window.boundary.evidence);
    this.windows.push(window);
    this.lastAnchorByScope.set(owner.scopeKey, window);
  }

  private boundaryEvidence(record: JsonObject, family: Family, ref: SourceRef, target: TimelineTarget | undefined,
    boundary: { kind: CompactionKind; label: string }): NonNullable<ContextWindowEntry['boundary']> {
    const evidence = this.captureEvidence(record, family, ref);
    return { ...boundary, ref: { ...ref }, target, evidence,
      summaryAssociation: { state: 'none', refs: [], omitted: 0 } };
  }

  private captureEvidence(record: JsonObject, family: Family, ref: SourceRef): ContextEvidenceFields {
    const payload = objectValue(record.payload);
    const compact = objectValue(record.compactMetadata);
    const fieldAt = (object: JsonObject, key: string, pointer: string): ContextField => {
      const sourceRef = has(object, key) ? { ...ref, pointer } : undefined;
      return contextField(object[key], has(object, key), sourceRef);
    };
    const compositeField = (value: unknown, present: boolean, pointer: string): ContextField => {
      if (!present) return { state: 'missing' };
      const sourceRef = { ...ref, pointer };
      if (value === null) return { state: 'null', ref: sourceRef };
      if (typeof value === 'object') return { state: 'recorded', ref: sourceRef };
      return contextField(value, true, sourceRef);
    };
    const choose = (candidates: Array<{ object: JsonObject; key: string; pointer: string }>): { object: JsonObject; key: string; pointer: string } | undefined =>
      candidates.find(candidate => has(candidate.object, candidate.key)) ?? candidates[0];
    const candidates = (names: Array<{ object: JsonObject; key: string; prefix: string }>): Array<{ object: JsonObject; key: string; pointer: string }> =>
      names.map(item => ({ object: item.object, key: item.key, pointer: item.prefix + '/' + pointerPart(item.key) }));
    const captureCandidates = (names: string[], sources: Array<{ object: JsonObject; prefix: string }>): Array<{ name: string; field: ContextField }> => {
      const result: Array<{ name: string; field: ContextField }> = [];
      for (const name of names) {
        let found = false;
        for (const source of sources) {
          if (!has(source.object, name)) continue;
          result.push({ name: source.prefix + '/' + name, field: fieldAt(source.object, name, source.prefix + '/' + pointerPart(name)) });
          found = true;
        }
        if (!found) result.push({ name, field: { state: 'missing' } });
      }
      return result;
    };
    const arrayList = <T>(value: unknown, present: boolean, pointer: string, name: string,
      captureItem: (entry: unknown, index: number) => T): ContextList<T> => {
      const rootRef = present ? { ...ref, pointer } : undefined;
      if (!present) return emptyList<T>('missing', undefined, name);
      if (value === null) return emptyList<T>('null', rootRef, name);
      if (!Array.isArray(value)) return emptyList<T>('malformed', rootRef, name);
      const items = value.slice(0, MAX_CONTEXT_LIST_PREVIEW).map(captureItem);
      return { name, state: 'recorded', count: value.length, items, omitted: Math.max(0, value.length - items.length), ref: rootRef };
    };
    const listField = (candidatesList: Array<{ object: JsonObject; key: string; pointer: string }>, name: string,
      captureItem: (entry: unknown, index: number) => ContextReplacementEntry | ContextMetadataEntry): ContextList<ContextReplacementEntry | ContextMetadataEntry> => {
      const selected = choose(candidatesList);
      const parentMalformed = Boolean(selected && selected.pointer.startsWith('/payload/')
        && has(record, 'payload') && !isObject(record.payload));
      return selected ? parentMalformed
        ? emptyList<ContextReplacementEntry | ContextMetadataEntry>('malformed', { ...ref, pointer: '/payload' }, name)
        : arrayList(selected.object[selected.key], has(selected.object, selected.key), selected.pointer, name, captureItem)
        : emptyList<ContextReplacementEntry | ContextMetadataEntry>('missing', undefined, name);
    };
    const captureReplacement = (entry: unknown, index: number, pointer: string): ContextReplacementEntry => {
      const entryRef = { ...ref, pointer: joinPointer(pointer, index) };
      if (entry === null) return { state: 'null', ref: entryRef, type: { state: 'missing' }, role: { state: 'missing' }, id: { state: 'missing' } };
      if (!isObject(entry)) return { state: 'malformed', ref: entryRef, type: { state: 'missing' }, role: { state: 'missing' }, id: { state: 'missing' } };
      return { state: 'object', ref: entryRef,
        type: contextField(entry.type, has(entry, 'type'), has(entry, 'type') ? { ...ref, pointer: joinPointer(entryRef.pointer!, 'type') } : undefined),
        role: contextField(entry.role, has(entry, 'role'), has(entry, 'role') ? { ...ref, pointer: joinPointer(entryRef.pointer!, 'role') } : undefined),
        id: contextField(entry.id, has(entry, 'id'), has(entry, 'id') ? { ...ref, pointer: joinPointer(entryRef.pointer!, 'id') } : undefined) };
    };
    const replacementCandidates = candidates([
      { object: payload, key: 'replacement_history', prefix: '/payload' },
      { object: payload, key: 'replacementHistory', prefix: '/payload' },
    ]);
    const selectedReplacement = choose(replacementCandidates);
    const replacementHistory = listField(replacementCandidates, 'replacement_history', (entry, index) =>
      captureReplacement(entry, index, selectedReplacement?.pointer ?? '/payload/replacement_history'));
    const metadataCandidates = candidates([
      { object: payload, key: 'replacement_history_metadata', prefix: '/payload' },
      { object: payload, key: 'replacementHistoryMetadata', prefix: '/payload' },
    ]);
    const selectedMetadata = choose(metadataCandidates);
    const replacementMetadata = listField(metadataCandidates, 'replacement_history_metadata', (entry, index) => {
      const pointer = joinPointer(selectedMetadata?.pointer ?? '/payload/replacement_history_metadata', index);
      const entryRef = { ...ref, pointer };
      if (entry === null) return { state: 'null', ref: entryRef, keys: [], omittedKeys: 0 };
      if (!isObject(entry)) return { state: 'malformed', ref: entryRef, keys: [], omittedKeys: 0 };
      const keys = fieldNames(entry);
      return { state: 'object', ref: entryRef, keys: keys.names, omittedKeys: keys.omitted };
    });

    const retainedChoice = choose(candidates([
      { object: payload, key: 'retained_context', prefix: '/payload' },
      { object: payload, key: 'retainedContext', prefix: '/payload' },
    ]));
    const retainedRaw = retainedChoice?.object[retainedChoice.key];
    const retainedPointer = retainedChoice?.pointer ?? '/payload/retained_context';
    const retainedRef = retainedChoice && has(retainedChoice.object, retainedChoice.key) ? { ...ref, pointer: retainedPointer } : undefined;
    const retainedObject = isObject(retainedRaw) ? retainedRaw : {};
    const retainedLists: ContextEvidenceFields['retainedContext']['lists'] = [];
    const knownLists = ['verified_answers', 'user_messages', 'assistant_messages'];
    const listNames = [...knownLists];
    let candidateListCount = knownLists.length;
    if (isObject(retainedRaw)) {
      for (const name of Object.keys(retainedObject)) {
        if (knownLists.includes(name) || !Array.isArray(retainedObject[name])) continue;
        candidateListCount++;
        if (listNames.length < MAX_CONTEXT_LIST_PREVIEW) listNames.push(name);
      }
    }
    const omittedLists = candidateListCount - listNames.length;
    for (const name of listNames.slice(0, MAX_CONTEXT_LIST_PREVIEW)) {
      const pointer = joinPointer(retainedPointer, name);
      const raw = retainedObject[name];
      const present = isObject(retainedRaw) && has(retainedObject, name);
      const values = arrayList(raw, present, pointer, name, (entry, index): ContextRetainedEntry => {
        const entryPointer = joinPointer(pointer, index);
        const entryRef = { ...ref, pointer: entryPointer };
        if (entry === null) return { state: 'null', ref: entryRef, fields: [] };
        if (!isObject(entry)) return { state: 'malformed', ref: entryRef, fields: [] };
        const fields = ['message_id', 'turn_id', 'order', 'revision', 'complete'].map(fieldName => ({
          name: fieldName,
          field: contextField(entry[fieldName], has(entry, fieldName), has(entry, fieldName) ? { ...ref, pointer: joinPointer(entryPointer, fieldName) } : undefined),
        }));
        return { state: 'object', ref: entryRef, fields };
      });
      const incompleteName = name + '_incomplete';
      const incomplete = isObject(retainedRaw)
        ? fieldAt(retainedObject, incompleteName, joinPointer(retainedPointer, incompleteName))
        : { state: 'missing' as const };
      retainedLists.push({ name, values, incomplete });
    }
    const retainedIncomplete = isObject(retainedRaw)
      ? fieldAt(retainedObject, 'incomplete', joinPointer(retainedPointer, 'incomplete'))
      : { state: !retainedChoice || !has(retainedChoice.object, retainedChoice.key) ? 'missing' as const : fieldState(retainedRaw, true),
        ref: retainedRef };

    const preserved: ContextEvidenceFields['preserved'] = [];
    const preservedChoice = choose(candidates([
      { object: compact, key: 'preservedMessageIds', prefix: '/compactMetadata' },
      { object: compact, key: 'preserved_message_ids', prefix: '/compactMetadata' },
      { object: compact, key: 'preservedMessages', prefix: '/compactMetadata' },
    ]));
    if (preservedChoice) {
      const raw = preservedChoice.object[preservedChoice.key];
      const rootPointer = preservedChoice.pointer;
      const rootField = compositeField(raw, true, rootPointer);
      if (Array.isArray(raw)) {
        const values = arrayList(raw, true, rootPointer, preservedChoice.key,
          (item, index) => contextField(item, true, { ...ref, pointer: joinPointer(rootPointer, index) }));
        preserved.push({ name: preservedChoice.key, field: rootField, values });
      } else if (isObject(raw)) {
        const anchorUuid = fieldAt(raw, 'anchorUuid', joinPointer(rootPointer, 'anchorUuid'));
        const uuids = arrayList(raw.uuids, has(raw, 'uuids'), joinPointer(rootPointer, 'uuids'), 'uuids',
          (item, index) => contextField(item, true, { ...ref, pointer: joinPointer(joinPointer(rootPointer, 'uuids'), index) }));
        const allUuids = arrayList(raw.allUuids, has(raw, 'allUuids'), joinPointer(rootPointer, 'allUuids'), 'allUuids',
          (item, index) => contextField(item, true, { ...ref, pointer: joinPointer(joinPointer(rootPointer, 'allUuids'), index) }));
        preserved.push({ name: preservedChoice.key, field: rootField, anchorUuid, uuids, allUuids });
      } else preserved.push({ name: preservedChoice.key, field: rootField });
    } else preserved.push({ name: 'preservedMessages', field: { state: 'missing' } });

    const summaryFlags = ['isCompactSummary', 'isVisibleInTranscriptOnly'].map(name => ({
      name, field: fieldAt(record, name, '/' + pointerPart(name)),
    }));
    const compactMetadataPresent = has(record, 'compactMetadata');
    const evidence: ContextEvidenceFields = {
      containers: [
        { name: 'payload', field: compositeField(record.payload, has(record, 'payload'), '/payload') },
        { name: 'compactMetadata', field: compositeField(record.compactMetadata, compactMetadataPresent, '/compactMetadata') },
      ],
      boundaryUuid: fieldAt(record, 'uuid', '/uuid'),
      counters: captureCandidates(['preTokens', 'pre_tokens', 'postTokens', 'post_tokens', 'cumulativeDroppedTokens', 'durationMs'], [
        { object: compact, prefix: '/compactMetadata' }, { object: payload, prefix: '/payload' },
      ]),
      triggerAndFlags: captureCandidates(['trigger', 'isAuto', 'isAutomatic', 'auto'], [
        { object: compact, prefix: '/compactMetadata' }, { object: payload, prefix: '/payload' },
      ]).concat(summaryFlags),
      windowIds: captureCandidates(['window_number', 'windowNumber', 'first_window_id', 'previous_window_id', 'window_id', 'compaction_response_id', 'firstWindowId', 'previousWindowId', 'windowId', 'compactionResponseId'], [
        { object: payload, prefix: '/payload' }, { object: compact, prefix: '/compactMetadata' },
      ]),
      replacementHistory: replacementHistory as ContextList<ContextReplacementEntry>,
      replacementHistoryMetadata: replacementMetadata as ContextList<ContextMetadataEntry>,
      retainedContext: { ref: retainedChoice ? compositeField(retainedRaw, has(retainedChoice.object, retainedChoice.key), retainedPointer) : { state: 'missing' },
        incomplete: retainedIncomplete, lists: retainedLists, omittedLists },
      preserved, summaryFlags, metadataOmitted: false,
    };
    return this.storeEvidence(evidence);
  }

  private storeEvidence(evidence: ContextEvidenceFields): ContextEvidenceFields {
    const fullSize = byteLength(evidence);
    if (this.metadataBytes + fullSize <= MAX_CONTEXT_METADATA_BYTES) {
      this.metadataBytes += fullSize;
      this.registerRefs(evidence);
      return evidence;
    }
    this.omittedMetadataRecords++;
    const reduced = this.reduceEvidence(evidence);
    const reducedSize = byteLength(reduced);
    if (this.metadataBytes + reducedSize <= MAX_CONTEXT_METADATA_BYTES) {
      this.metadataBytes += reducedSize;
      this.registerRefs(reduced);
      return reduced;
    }
    const minimal: ContextEvidenceFields = {
      containers: [], boundaryUuid: { state: 'over-limit' }, counters: [], triggerAndFlags: [], windowIds: [],
      replacementHistory: { name: 'replacement_history', state: 'over-limit', items: [], omitted: evidence.replacementHistory.count ?? evidence.replacementHistory.omitted },
      replacementHistoryMetadata: { name: 'replacement_history_metadata', state: 'over-limit', items: [], omitted: evidence.replacementHistoryMetadata.count ?? evidence.replacementHistoryMetadata.omitted },
      retainedContext: { ref: { state: 'over-limit' }, incomplete: { state: 'over-limit' }, lists: [], omittedLists: evidence.retainedContext.omittedLists },
      preserved: [], summaryFlags: [], metadataOmitted: true,
    };
    return minimal;
  }

  private reduceEvidence(evidence: ContextEvidenceFields): ContextEvidenceFields {
    const reduceList = <T>(list: ContextList<T>): ContextList<T> => ({ ...list, items: [], omitted: (list.count ?? list.omitted) });
    return { ...evidence, metadataOmitted: true,
      replacementHistory: reduceList(evidence.replacementHistory),
      replacementHistoryMetadata: reduceList(evidence.replacementHistoryMetadata),
      retainedContext: { ...evidence.retainedContext, lists: evidence.retainedContext.lists.map(list => ({ ...list, values: reduceList(list.values) })) },
      preserved: evidence.preserved.map(item => ({ ...item,
        uuids: item.uuids ? reduceList(item.uuids) : undefined,
        allUuids: item.allUuids ? reduceList(item.allUuids) : undefined,
        values: item.values ? reduceList(item.values) : undefined,
      })) };
  }

  private registerRefs(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) this.registerRefs(item); return; }
    const candidate = value as Partial<SourceRef>;
    if (typeof candidate.id === 'string' && typeof candidate.pointer === 'string') {
      const pointers = this.allowedPointers.get(candidate.id) ?? new Set<string>();
      pointers.add(candidate.pointer);
      this.allowedPointers.set(candidate.id, pointers);
    }
    for (const child of Object.values(value as JsonObject)) this.registerRefs(child);
  }

  private captureRepresentation(kind: ContextRepresentationEntry['representationKind'], label: string, record: JsonObject,
    owner: ContextWindowOwner, ref: SourceRef, target?: TimelineTarget): void {
    if (this.representations.length >= MAX_CONTEXT_REPRESENTATIONS) { this.omittedRepresentations++; return; }
    const flagNames = ['isCompactSummary', 'isVisibleInTranscriptOnly'];
    const flags = kind === 'claude-summary' ? flagNames.map(name => ({ name,
      field: contextField(record[name], has(record, name), has(record, name) ? { ...ref, pointer: '/' + pointerPart(name) } : undefined),
    })) : [];
    const uuid = kind === 'claude-summary' ? contextField(record.uuid, has(record, 'uuid'), has(record, 'uuid') ? { ...ref, pointer: '/uuid' } : undefined) : undefined;
    const parentUuid = kind === 'claude-summary' ? contextField(record.parentUuid, has(record, 'parentUuid'), has(record, 'parentUuid') ? { ...ref, pointer: '/parentUuid' } : undefined) : undefined;
    const entry: ContextRepresentationEntry = {
      kind: 'representation', id: 'context-representation:' + ref.id + ':' + ref.sha256 + ':' + kind,
      representationKind: kind, label, owner, ref: { ...ref }, target, summaryFlags: flags,
      uuid, parentUuid, summaryAssociation: kind === 'claude-summary' ? 'unlinked' : 'not-applicable',
      metadataOmitted: false,
    };
    this.registerRefs(owner);
    const metadata = { summaryFlags: flags, uuid, parentUuid };
    const size = byteLength(metadata);
    if (this.metadataBytes + size > MAX_CONTEXT_METADATA_BYTES) {
      entry.summaryFlags = [];
      entry.uuid = undefined;
      entry.parentUuid = undefined;
      entry.metadataOmitted = true;
      this.omittedMetadataRecords++;
    } else {
      this.metadataBytes += size;
      this.registerRefs(metadata);
    }
    this.representations.push(entry);
    if (kind === 'claude-summary') this.summaryCandidates.push({ entry, scopeKey: owner.scopeKey });
  }

  private presentWindow(window: ContextWindowEntry, scanComplete: boolean): ContextWindowEntry {
    const result: ContextWindowEntry = { ...window, owner: { ...window.owner }, startRef: { ...window.startRef },
      endRef: window.endRef ? { ...window.endRef } : undefined,
      boundary: window.boundary ? { ...window.boundary, ref: { ...window.boundary.ref }, evidence: window.boundary.evidence,
        summaryAssociation: this.summaryAssociation(window) } : undefined };
    if (!result.endRef) {
      result.endBasis = scanComplete ? 'last-retained-complete-source-record' : 'indexing';
      result.endRef = scanComplete && this.lastRef ? { ...this.lastRef } : undefined;
      result.endExclusive = false;
    }
    result.incomplete ||= !scanComplete || result.boundary?.evidence.metadataOmitted === true;
    return result;
  }

  private summaryAssociation(window: ContextWindowEntry): NonNullable<ContextWindowEntry['boundary']>['summaryAssociation'] {
    if (window.boundary?.kind !== 'claude-compact-boundary') return { state: 'none', refs: [], omitted: 0 };
    const boundaryUuid = window.boundary.evidence.boundaryUuid;
    const preservedAnchor = window.boundary.evidence.preserved.find(item => item.name === 'preservedMessages')?.anchorUuid;
    if (boundaryUuid?.state !== 'recorded' || typeof boundaryUuid.value !== 'string'
      || preservedAnchor?.state !== 'recorded' || typeof preservedAnchor.value !== 'string') {
      return { state: this.summaryCandidates.some(candidate => candidate.scopeKey === window.owner.scopeKey) ? 'unverified' : 'none', refs: [], omitted: 0 };
    }
    const idMatches = this.summaryCandidates.filter(candidate => candidate.entry.uuid?.state === 'recorded'
      && candidate.entry.uuid.value === preservedAnchor.value
      && candidate.entry.parentUuid?.state === 'recorded' && candidate.entry.parentUuid.value === boundaryUuid.value);
    const boundaryMatches = this.windows.filter(candidate => candidate.boundary?.kind === 'claude-compact-boundary'
      && candidate.boundary.evidence.boundaryUuid.state === 'recorded' && candidate.boundary.evidence.boundaryUuid.value === boundaryUuid.value
      && candidate.boundary.evidence.preserved.find(item => item.name === 'preservedMessages')?.anchorUuid?.state === 'recorded'
      && candidate.boundary.evidence.preserved.find(item => item.name === 'preservedMessages')?.anchorUuid?.value === preservedAnchor.value);
    const unresolvedSameScope = this.summaryCandidates.filter(candidate => candidate.scopeKey === window.owner.scopeKey
      && (candidate.entry.uuid?.state !== 'recorded' || candidate.entry.parentUuid?.state !== 'recorded'));
    if (boundaryMatches.length > 1) return { state: 'ambiguous', refs: idMatches.slice(0, MAX_CONTEXT_LIST_PREVIEW).map(candidate => candidate.entry.ref),
      omitted: Math.max(0, idMatches.length - MAX_CONTEXT_LIST_PREVIEW) };
    if (idMatches.length !== 1) {
      if (idMatches.length > 1) return { state: 'ambiguous', refs: idMatches.slice(0, MAX_CONTEXT_LIST_PREVIEW).map(candidate => candidate.entry.ref),
        omitted: Math.max(0, idMatches.length - MAX_CONTEXT_LIST_PREVIEW) };
      return { state: this.summaryCandidates.some(candidate => candidate.scopeKey === window.owner.scopeKey) ? 'unverified' : 'none', refs: [], omitted: 0 };
    }
    const candidate = idMatches[0]!;
    const sameScope = candidate.scopeKey === window.owner.scopeKey
      && window.owner.scopeBasis !== 'unknown-source-instance' && candidate.entry.owner.scopeBasis !== 'unknown-source-instance';
    if (!sameScope) return { state: 'ambiguous', refs: [candidate.entry.ref], omitted: 0 };
    if (unresolvedSameScope.length) return { state: 'unverified', refs: [candidate.entry.ref, ...unresolvedSameScope.slice(0, MAX_CONTEXT_LIST_PREVIEW - 1).map(item => item.entry.ref)],
      omitted: Math.max(0, unresolvedSameScope.length - (MAX_CONTEXT_LIST_PREVIEW - 1)) };
    return { state: 'linked', refs: [candidate.entry.ref], omitted: 0, target: candidate.entry.target };
  }

  private presentRepresentation(entry: ContextRepresentationEntry): ContextRepresentationEntry {
    if (entry.representationKind !== 'claude-summary') return { ...entry, owner: { ...entry.owner }, ref: { ...entry.ref } };
    const idMatches = this.windows.filter(window => window.boundary?.kind === 'claude-compact-boundary'
      && window.boundary.evidence.preserved.find(item => item.name === 'preservedMessages')?.anchorUuid?.state === 'recorded'
      && window.boundary.evidence.preserved.find(item => item.name === 'preservedMessages')?.anchorUuid?.value === entry.uuid?.value
      && window.boundary.evidence.boundaryUuid.state === 'recorded'
      && window.boundary.evidence.boundaryUuid.value === entry.parentUuid?.value);
    const linked = idMatches.filter(window => window.owner.scopeKey === entry.owner.scopeKey
      && window.owner.scopeBasis !== 'unknown-source-instance' && entry.owner.scopeBasis !== 'unknown-source-instance');
    const unresolvedSameScope = this.summaryCandidates.some(candidate => candidate.entry.id !== entry.id
      && candidate.scopeKey === entry.owner.scopeKey
      && (candidate.entry.uuid?.state !== 'recorded' || candidate.entry.parentUuid?.state !== 'recorded'));
    const summaryAssociation: ContextRepresentationEntry['summaryAssociation'] = linked.length === 1 && !unresolvedSameScope ? 'linked'
      : idMatches.length > 1 ? 'ambiguous' : idMatches.length === 1 ? unresolvedSameScope ? 'unverified' : 'ambiguous'
      : entry.uuid?.state === 'recorded' && entry.parentUuid?.state === 'recorded' ? 'unlinked' : 'unverified';
    return { ...entry, owner: { ...entry.owner }, ref: { ...entry.ref }, summaryAssociation,
      linkedBoundaryRef: linked.length === 1 && !unresolvedSameScope ? idMatches[0]!.boundary!.ref : undefined };
  }
}
