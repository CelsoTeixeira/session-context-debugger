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
export interface ResponseIdentity {
  actorId: string;
  requestId?: string;
  messageId?: string;
  responseId?: string;
}
export interface ResponseLink {
  id: string;
  position: number;
  label: string;
  ref: SourceRef;
}
export interface ResponseGroupView {
  detail: string;
  complete: boolean;
  events: ResponseLink[];
  eventCount: number;
  omittedEvents: number;
  previous?: ResponseLink;
  next?: ResponseLink;
  position: number;
  total: number;
}
export interface ProviderResponseView extends ResponseGroupView {
  groupKind: 'provider-response';
  basis: 'recorded-provider-identifiers';
  identity: ResponseIdentity;
  usageStatus: 'resolved' | 'ambiguous' | 'unknown';
  variants: Array<{ values: UsageValues; ref: SourceRef; matchingRefs: number }>;
  omittedVariants: number;
}
export interface CapturedRecordResponseView extends ResponseGroupView {
  groupKind: 'captured-record';
  basis: 'same-physical-record';
  source: SourceRef;
  actorId: string;
  requestAssociation: 'unknown';
  providerUsageAssociation: 'unknown';
  usageStatus: 'unknown';
  variants: [];
  omittedVariants: 0;
}
export interface UnknownResponseView {
  groupKind: 'unknown';
  basis: 'none';
  detail: string;
  complete: boolean;
  events: [];
  eventCount: 0;
  omittedEvents: 0;
  usageStatus: 'unknown';
  variants: [];
  omittedVariants: 0;
  total: number;
}
export type ResponseView = ProviderResponseView | CapturedRecordResponseView | UnknownResponseView;
export interface UsageSummary {
  includedCalls: number;
  excludedCalls: number;
  fields: Record<keyof UsageValues, { tokens: number | null; calls: number; overflow: boolean }>;
}
export interface UsagePage {
  calls: Array<Pick<ModelCall, 'id' | 'actorId' | 'identityDetail' | 'model' | 'status' | 'firstLine'> & {
    variants: Array<{ values: UsageValues; ref: SourceRef; matchingRefs: number; navigation?: ResponseNavigation }>;
  }>;
  after?: number;
  total: number;
}
export interface ResponseNavigation {
  target: { id: string; position: number };
  detail: string;
  related: Array<{ id: string; position: number; label: string; ref: SourceRef }>;
  omitted: number;
}
export interface UsageJump {
  sessionId: string;
  navigation: ResponseNavigation;
  values: UsageValues;
  ref: SourceRef;
  status: ModelCall['status'];
  identityDetail: string;
}
export interface UsageChartObservation {
  values: UsageValues;
  ref: SourceRef;
  matchingRefs: number;
  responseNavigation?: ResponseNavigation;
}
export interface UsageChartPoint {
  id: string;
  ordinal: number;
  firstLine: number;
  actorId: string;
  model?: string;
  status: ModelCall['status'];
  identityDetail: string;
  input: number | null;
  reason: string;
  ref: SourceRef;
  retainedRefs: number;
  variantCount: number;
  observation: UsageChartObservation;
  sourceAvailable: boolean;
}
export type CompactionKind = 'claude-compact-boundary' | 'codex-compacted' | 'codex-context-compacted' | 'codex-compaction-representation';
export interface CompactionMetadata {
  preTokens?: number;
  postTokens?: number;
  cumulativeDroppedTokens?: number;
  durationMs?: number;
  replacementHistoryCount?: number;
  preservedMessageCount?: number;
  discoveredToolCount?: number;
  recordedWindowNumber?: number;
  trigger?: string;
  flags?: Record<string, boolean>;
}
export interface CompactionMarker {
  id: string;
  kind: CompactionKind;
  label: string;
  boundary: 'recorded' | 'representation';
  ref: SourceRef;
  metadata: CompactionMetadata;
  target?: { id: string; position: number };
}
export interface UsageChartCoverage {
  sourceFamily: Family;
  scanComplete: boolean;
  indexComplete: boolean;
  usageComplete: boolean;
  usageLimited: boolean;
  compactionCaptureComplete: boolean;
  indexedRecords: number;
  scannedLines: number;
  pendingRecords: number;
  unknownRecords: number;
  malformedRecords: number;
  limitedRecords: number;
  recordLimit: number;
  retainedCalls: number;
  usageCallLimit: number;
  usageReferenceLimit: number;
  usageVariantLimit: number;
  pointPageLimit: number;
  runtimeCounterRecords: number;
  retainedCompactions: number;
  omittedCompactionCaptures: number;
  compactionCaptureLimit: number;
  markerPageLimit: number;
  sourceEndLine: number;
}
export interface UsageChartPage {
  points: UsageChartPoint[];
  compactions: CompactionMarker[];
  sourceRange: { firstLine: number; lastLine: number };
  omittedCompactions: number;
  after?: number;
  total: number;
  coverage: UsageChartCoverage;
}
export interface SearchMatch {
  ref: SourceRef;
  matchOffset: number;
  preview: string;
  pending: boolean;
  target?: { id: string; position: number };
}
export interface SearchView {
  id: string;
  query: string;
  state: 'searching' | 'complete' | 'cancelled' | 'limited' | 'error';
  scannedBytes: number;
  snapshotBytes: number;
  scannedRecords: number;
  matches: SearchMatch[];
  maxMatches: number;
  detail: string;
}
export interface RecordMeta {
  ref: SourceRef;
  outerType: string;
  payloadType?: string;
  itemType?: string;
  disposition: Disposition;
  reason?: string;
}
export interface LedgerPage {
  records: RecordMeta[];
  after?: number;
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
  relationships: RelationListing;
  limits: { parseBytes: number; previewCodeUnits: number; maxRecords: number; maxItems: number };
}
export interface SessionRelation {
  id: string;
  direction: 'parent' | 'child';
  label: string;
  targetId?: string;
  toolId?: string;
  agentPath?: string;
  conflict?: boolean;
  refs: SourceRef[];
}
export interface RelationListing {
  links: SessionRelation[];
  complete: boolean;
  omitted: number;
  detail: string;
}
export interface RelationEvidence {
  id: string;
  label: string;
  path: string;
  ref?: SourceRef;
  sha256: string;
  bytes: number;
}
export interface RelationMatch {
  id: string;
  path: string;
  actorId: string;
  rootId: string;
  status: 'verified' | 'conflicting' | 'unverified';
  detail: string;
  evidence: RelationEvidence[];
}
export interface RelationResolution {
  id: string;
  relation: SessionRelation;
  status: 'verified' | 'ambiguous' | 'missing' | 'unavailable';
  matches: RelationMatch[];
  complete: boolean;
  warnings: string[];
}
export interface RelationOpen { id: string; returnToken: string; returnLabel: string; returnRole: 'parent' | 'child' }
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
  relationships?: TimelineRelationship[];
  serializedBytes: number | null;
  allocatedBytes: number | null;
}
export type TimelineRelationshipKind = 'tool-counterpart' | 'codex-item-representation' | 'claude-runtime-result';
export type TimelineRelationshipBasis = 'recorded-tool-id-within-actor' | 'recorded-item.id-within-actor-thread'
  | 'same-record-tool_use_id' | 'unique-same-record-tool_result';
export interface TimelineRelationshipTarget {
  id: string;
  position: number;
  label: string;
  source: SourceRef;
}
export interface TimelineRelationshipLink {
  kind: TimelineRelationshipKind;
  basis: TimelineRelationshipBasis;
  target: TimelineRelationshipTarget;
}
export interface TimelineRelationship {
  kind: TimelineRelationshipKind;
  status: 'linked' | 'orphan' | 'ambiguous' | 'unassigned';
  basis?: TimelineRelationshipBasis;
  links: TimelineRelationshipLink[];
  omitted: number;
  complete: boolean;
  detail: string;
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
