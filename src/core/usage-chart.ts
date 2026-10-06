import { object } from './json.js';
import type { CompactionKind, CompactionMarker, CompactionMetadata, Family, ModelCall, ResponseNavigation, SourceRef, UsageChartCoverage, UsageChartPage, UsageChartPoint } from './types.js';

export const MAX_USAGE_CHART_POINTS = 200;
export const MAX_USAGE_REFERENCES_PER_VARIANT = 500;
export const MAX_USAGE_VARIANTS_PER_CALL = 100;
export const MAX_COMPACTION_CAPTURES = 1000;
export const MAX_COMPACTIONS_PER_PAGE = 200;

type TimelineTarget = { id: string; position: number };

const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const shortLabel = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9 _-]{1,40}$/.test(value) ? value : undefined;

function compactionMetadata(record: Record<string, unknown>, payload: Record<string, unknown>): CompactionMetadata {
  const compact = object(record.compactMetadata);
  const metadata: CompactionMetadata = {};
  const preTokens = count(compact.preTokens) ?? count(compact.pre_tokens) ?? count(payload.preTokens) ?? count(payload.pre_tokens);
  const postTokens = count(compact.postTokens) ?? count(compact.post_tokens) ?? count(payload.postTokens) ?? count(payload.post_tokens);
  const cumulativeDroppedTokens = count(compact.cumulativeDroppedTokens) ?? count(payload.cumulativeDroppedTokens);
  const durationMs = count(compact.durationMs) ?? count(payload.durationMs);
  const windowNumber = count(payload.window_number) ?? count(payload.windowNumber) ?? count(compact.windowNumber);
  const replacementHistory = payload.replacement_history ?? payload.replacementHistory;
  const preservedIds = compact.preservedMessageIds ?? compact.preserved_message_ids ?? compact.preservedMessages;
  const discoveredTools = compact.preCompactDiscoveredTools;
  const trigger = shortLabel(compact.trigger) ?? shortLabel(payload.trigger);
  if (preTokens !== undefined) metadata.preTokens = preTokens;
  if (postTokens !== undefined) metadata.postTokens = postTokens;
  if (cumulativeDroppedTokens !== undefined) metadata.cumulativeDroppedTokens = cumulativeDroppedTokens;
  if (durationMs !== undefined) metadata.durationMs = durationMs;
  if (windowNumber !== undefined) metadata.recordedWindowNumber = windowNumber;
  if (Array.isArray(replacementHistory)) metadata.replacementHistoryCount = replacementHistory.length;
  if (Array.isArray(preservedIds)) metadata.preservedMessageCount = preservedIds.length;
  else if (preservedIds && typeof preservedIds === 'object') metadata.preservedMessageCount = Object.keys(preservedIds).length;
  if (Array.isArray(discoveredTools)) metadata.discoveredToolCount = discoveredTools.length;
  if (trigger) metadata.trigger = trigger;

  const flags: Record<string, boolean> = {};
  for (const [key, value] of [
    ['isAuto', compact.isAuto ?? payload.isAuto],
    ['isAutomatic', compact.isAutomatic ?? payload.isAutomatic],
    ['auto', compact.auto ?? payload.auto],
    ['isCompactSummary', record.isCompactSummary],
    ['isVisibleInTranscriptOnly', record.isVisibleInTranscriptOnly],
  ] as const) if (typeof value === 'boolean') flags[key] = value;
  if (Object.keys(flags).length) metadata.flags = flags;
  return metadata;
}

export function readCompactionCapture(
  record: Record<string, unknown>, family: Family, ref: SourceRef, target?: TimelineTarget,
): CompactionMarker | undefined {
  let kind: CompactionKind | undefined;
  let label = '';
  let boundary: CompactionMarker['boundary'] = 'recorded';
  const payload = object(record.payload);

  if (family === 'claude' && record.type === 'system' && record.subtype === 'compact_boundary') {
    kind = 'claude-compact-boundary';
    label = 'Claude compact boundary';
  } else if (family === 'codex' && record.type === 'compacted') {
    kind = 'codex-compacted';
    label = 'Codex compaction event';
  } else if (family === 'codex' && record.type === 'event_msg' && payload.type === 'context_compacted') {
    kind = 'codex-context-compacted';
    label = 'Codex runtime context compaction marker';
  } else if (family === 'codex' && record.type === 'response_item' && payload.type === 'compaction') {
    kind = 'codex-compaction-representation';
    label = 'Codex compaction representation';
    boundary = 'representation';
  }

  if (!kind) return undefined;
  return { id: ref.id + ':compaction', kind, label, boundary, ref: { ...ref }, metadata: compactionMetadata(record, payload), target };
}

function pointFor(call: ModelCall, ordinal: number, sourceIds: ReadonlySet<string>, navigate: (ref: SourceRef, refs: readonly SourceRef[]) => ResponseNavigation | undefined): UsageChartPoint | undefined {
  const observations = call.variants.flatMap(variant => variant.refs.map(ref => ({ variant, ref })))
    .sort((left, right) => left.ref.line - right.ref.line || left.ref.offset - right.ref.offset);
  const first = observations[0];
  if (!first) return undefined;
  const input = call.status === 'resolved' && call.variants.length === 1 ? first.variant.values.input : null;
  const reason = call.status === 'ambiguous'
    ? 'Conflicting or unassigned retained measurements; no unique input value is plotted.'
    : input === null
      ? 'The resolved provider observation has no supported input value; it remains a gap.'
      : 'One resolved provider-reported input value; invocation scope remains unknown.';
  const responseNavigation = navigate(first.ref, first.variant.refs);
  const retainedRefs = call.variants.reduce((total, variant) => total + variant.refs.length, 0);
  return {
    id: call.id,
    ordinal,
    firstLine: call.firstLine,
    actorId: call.actorId,
    model: call.model,
    status: call.status,
    identityDetail: call.identityDetail,
    input,
    reason,
    ref: first.ref,
    retainedRefs,
    variantCount: call.variants.length,
    observation: {
      values: first.variant.values,
      ref: first.ref,
      matchingRefs: first.variant.refs.length,
      responseNavigation,
    },
    sourceAvailable: sourceIds.has(first.ref.id),
  };
}

export function createUsageChartPage(args: {
  calls: readonly ModelCall[];
  compactions: readonly CompactionMarker[];
  after: number;
  sourceEndLine: number;
  indexedSourceIds: ReadonlySet<string>;
  coverage: UsageChartCoverage;
  responseNavigation: (ref: SourceRef, refs: readonly SourceRef[]) => ResponseNavigation | undefined;
}): UsageChartPage {
  const { calls, compactions, after, sourceEndLine, indexedSourceIds, coverage, responseNavigation } = args;
  const end = Math.min(calls.length, after + MAX_USAGE_CHART_POINTS);
  const firstLine = after === 0 ? 1 : (calls[after]?.firstLine ?? sourceEndLine + 1);
  const nextPageLine = end < calls.length ? calls[end]!.firstLine : sourceEndLine + 1;
  const lastLine = Math.min(sourceEndLine, Math.max(firstLine - 1, nextPageLine - 1));
  const inRange = compactions.filter(marker => marker.ref.line >= firstLine && marker.ref.line <= lastLine);
  const visibleCompactions = inRange.slice(0, MAX_COMPACTIONS_PER_PAGE);
  const points = calls.slice(after, end).map((call, index) => pointFor(call, after + index + 1, indexedSourceIds, responseNavigation))
    .filter((point): point is UsageChartPoint => point !== undefined);

  return {
    points,
    compactions: visibleCompactions,
    sourceRange: { firstLine, lastLine },
    omittedCompactions: inRange.length - visibleCompactions.length,
    after: end < calls.length ? end : undefined,
    total: calls.length,
    coverage,
  };
}
