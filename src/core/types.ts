export type Family = 'codex' | 'claude' | 'unknown';
export type Origin = 'human-recorded' | 'submitted-author-unknown' | 'harness-injected' | 'unknown';
export type Basis = 'explicit' | 'inferred' | 'unknown';
export type Representation = 'primary' | 'diagnostic-snapshot' | 'metadata' | 'unknown';
export type Disposition = 'event' | 'metadata' | 'unknown' | 'malformed' | 'limited' | 'pending';

export interface SourceRef {
  id: string;
  sourceId: string;
  generation: string;
  line: number;
  offset: number;
  byteLength: number;
  delimiterLength: number;
  sha256: string;
  pointer?: string;
}
export interface EvidenceItem {
  id: string;
  label: string;
  kind: 'prompt' | 'instruction' | 'memory' | 'skill' | 'tool' | 'snapshot' | 'metadata';
  origin: Origin;
  representation: Representation;
  evidence: 'recorded-content' | 'diagnostic-snapshot';
  basis: Basis;
  detail: string;
  preview: string;
  previewLimited: boolean;
  ref: SourceRef;
  capturedPath?: string;
}
export interface UsageValues {
  input: number | null;
  cached: number | null;
  cacheCreation: number | null;
  output: number | null;
  reasoning: number | null;
}
export interface UsageVariant {
  values: UsageValues;
  original: Record<string, unknown>;
  refs: SourceRef[];
}
export interface ModelCall {
  id: string;
  actorId: string;
  identityBasis: Basis;
  identityDetail: string;
  model?: string;
  scope: 'recorded-response; invocation-scope-unknown';
  status: 'resolved' | 'ambiguous';
  variants: UsageVariant[];
  firstLine: number;
}
export interface UsageSummary {
  includedCalls: number;
  excludedCalls: number;
  fields: Record<keyof UsageValues, { tokens: number | null; calls: number; overflow: boolean }>;
}
export interface UsagePage {
  calls: Array<Pick<ModelCall, 'id' | 'actorId' | 'identityDetail' | 'model' | 'status' | 'firstLine'> & {
    variants: Array<{ values: UsageValues; ref: SourceRef; matchingRefs: number }>;
  }>;
  after?: number;
  total: number;
}
export interface RecordMeta {
  ref: SourceRef;
  outerType: string;
  payloadType?: string;
  itemType?: string;
  disposition: Disposition;
  reason?: string;
}
export interface CoverageLedger {
  inspectedBytes: number;
  scannedBytes: number;
  completeLines: number;
  pendingBytes: number;
  dispositions: Record<Disposition, number>;
  outerTypes: Record<string, number>;
  payloadTypes: Record<string, number>;
  itemTypes: Record<string, number>;
  indexedRecords: number;
  normalizedItems: number;
  normalizationLimited: number;
  prefixSha256?: string;
  complete: boolean;
}
export interface SourceFile {
  id: string;
  generation: string;
  originalPath: string;
  resolvedPath: string;
  family: Family;
  size: number;
  modifiedAt: string;
  actorId?: string;
  rootSessionId?: string;
  runtime?: string;
  version?: string;
}
export interface Overview {
  id: string;
  state: 'indexing' | 'ready' | 'cancelled' | 'error';
  source: SourceFile;
  coverage: CoverageLedger;
  firstPrompt?: EvidenceItem;
  startup: EvidenceItem[];
  snapshots: EvidenceItem[];
  firstCall?: ModelCall;
  callCount: number;
  ambiguousCalls: number;
  usage: UsageSummary;
  warnings: string[];
  limits: { parseBytes: number; previewCodeUnits: number; maxRecords: number; maxItems: number };
}
export interface Candidate {
  id: string;
  path: string;
  family: Family;
  bytes: number;
  modifiedAt: string;
}
export interface SourceListing {
  candidates: Candidate[];
  cursor?: string;
  inspectedFiles: number;
  complete: boolean;
  warnings: string[];
}
export interface RecordView {
  ref: SourceRef;
  view: 'raw' | 'field';
  text: string;
  offsetWithinRecord: number;
  returnedBytes: number;
  totalBytes: number;
  nextOffset?: number;
  limited: boolean;
  validated: true;
}
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export type EventKind = 'message' | 'tool-call' | 'tool-result' | 'reasoning' | 'usage' | 'attachment' | 'lifecycle' | 'metadata' | 'unknown';
export interface TimelineEvent {
  id: string;
  position: number;
  ref: SourceRef;
  kind: EventKind;
  label: string;
  actorId: string;
  role?: string;
  timestamp?: string;
  recordedId?: string;
  origin: Origin;
  representation: Representation | 'mirror';
  detail: string;
  preview: string;
  previewLimited: boolean;
  toolId?: string;
  pairStatus?: 'paired' | 'orphan' | 'ambiguous' | 'unassigned';
  related?: SourceRef[];
  relatedPositions?: number[];
  serializedBytes: number | null;
  allocatedBytes: number | null;
}
export interface TimelinePage {
  events: TimelineEvent[];
  after?: number;
  before?: number;
  total: number;
  omitted: number;
  complete: boolean;
  maxEvents: number;
}
export type TimelineCategory = EventKind | 'user' | 'assistant' | 'instruction' | 'snapshot';
export type TimelineFilter = 'all' | 'tools' | TimelineCategory;
export interface TimelineBin {
  start: number;
  end: number;
  firstLine: number;
  lastLine: number;
  counts: Partial<Record<TimelineCategory, number>>;
  matching: number;
  firstMatch?: number;
}
export interface TimelineMap {
  bins: TimelineBin[];
  total: number;
  matching: number;
  omitted: number;
  ranking: Array<{
    category: TimelineCategory;
    representation: TimelineEvent['representation'];
    events: number;
    measuredEvents: number;
    bytes: number;
    firstRef: SourceRef;
    largest?: { bytes: number; ref: SourceRef };
  }>;
}

export type SourceMode = 't3' | 'claude' | 'codex';
export interface T3Thread {
  id: string;
  title: string;
  project: string;
  workspace?: string;
  provider?: string;
  updatedAt: string;
  archived: boolean;
}
export interface T3Listing {
  threads: T3Thread[];
  databasePath: string;
  cursor?: string;
  warnings: string[];
}
// A captured SQL projection has a row key and value hash, never a JSONL line.
export interface DatabaseRef {
  id: string;
  databasePath: string;
  generation: string;
  table: 'projection_threads' | 'projection_projects' | 'provider_session_runtime';
  key: string;
  columns: string[];
  sha256: string;
  inspectedAt: string;
  pointer?: string;
}
export interface DatabaseView { ref: DatabaseRef; text: string; validated: true }
export interface LogMatch {
  id: string;
  path: string;
  identity: SourceRef;
}
export interface T3Resolution {
  id: string;
  thread: T3Thread;
  refs: DatabaseRef[];
  providerId?: string;
  providerInstance?: string;
  status: 'verified' | 'ambiguous' | 'log-missing' | 'unlinked' | 'unsupported';
  matches: LogMatch[];
  complete: boolean | null;
  warnings: string[];
}
