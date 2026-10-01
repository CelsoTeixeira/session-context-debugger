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
