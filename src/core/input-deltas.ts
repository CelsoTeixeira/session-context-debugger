import type { InputComparisonEvidence, InputDelta, InputDeltaEndpoint, ModelCall, SourceRef } from './types.js';

type Interval = (start: SourceRef, end: SourceRef, sessionId: string, agentId?: string) =>
  { ok: true; basis: string } | { ok: false; reason: string };
type Navigation = (ref: SourceRef, refs: readonly SourceRef[]) => InputDeltaEndpoint['navigation'];

function orderedRefs(call: ModelCall): SourceRef[] {
  return call.variants.flatMap(variant => variant.refs).slice().sort((a, b) => a.line - b.line || a.offset - b.offset);
}

function gap(reason: string, previous?: InputDeltaEndpoint, current?: InputDeltaEndpoint): InputDelta {
  return { status: 'gap', reason, ...(previous ? { previous } : {}), ...(current ? { current } : {}) };
}

function evidence(call: ModelCall): { evidence?: InputComparisonEvidence[]; reason?: string } {
  if (call.status !== 'resolved' || call.variants.length !== 1) return { reason: 'The response group is ambiguous or has multiple usage variants.' };
  const variant = call.variants[0]!;
  if (!Number.isSafeInteger(variant.values.input) || variant.values.input === null || variant.values.input < 0) {
    return { reason: 'The response group has no safe integer input total.' };
  }
  const found = variant.comparisonEvidence ?? [];
  if (!found.length || found.length !== variant.refs.length || found.some(item => !variant.refs.some(ref => ref.id === item.ref.id))) {
    return { reason: 'A retained usage alias lacks complete comparison provenance.' };
  }
  const first = found[0]!;
  if (!first.model) return { reason: 'The exact recorded model is missing; no compatible comparison is established.' };
  if (first.provider !== 'claude' || first.method !== 'assistant /message/usage input_tokens + cache_creation_input_tokens + cache_read_input_tokens') {
    return { reason: 'This provider or recorded measurement method does not support a compatible comparison.' };
  }
  if (!first.model || !first.sessionId) return { reason: 'The exact recorded model or session ownership is missing.' };
  if (first.agentId === undefined ? first.isSidechain !== false : !first.agentId) {
    return { reason: 'Root ownership requires explicit isSidechain:false; child ownership requires agentId and sessionId.' };
  }
  const identity = (item: InputComparisonEvidence): string => JSON.stringify([
    item.provider, item.method, item.model, item.sessionId, item.agentId, item.isSidechain,
  ]);
  if (found.some(item => identity(item) !== identity(first))) return { reason: 'Recorded aliases disagree on model, actor, session, provider, or measurement method.' };
  return { evidence: found };
}

function endpoint(call: ModelCall, refs: SourceRef[], items: InputComparisonEvidence[], navigation: Navigation,
  sourceAvailable: (ref: SourceRef) => boolean, windowBasis = 'Recorded window evidence not established', edge: 'first' | 'last' = 'first'): InputDeltaEndpoint | undefined {
  const first = edge === 'last' ? refs.at(-1) : refs[0];
  const item = items[0];
  if (!first) return undefined;
  const variant = call.variants[0];
  return { ref: first, retainedRefs: refs.length, input: call.status === 'resolved' && call.variants.length === 1 ? variant?.values.input ?? null : null,
    values: variant?.values ?? { input: null, cached: null, cacheCreation: null, output: null, reasoning: null },
    model: item?.model, actorId: item?.agentId ?? item?.sessionId ?? call.actorId, method: item?.method,
    windowBasis, navigation: navigation(first, refs), sourceAvailable: refs.every(sourceAvailable) };
}

export function compareInputCalls(previousCall: ModelCall | undefined, current: ModelCall,
  interval: Interval, navigation: Navigation, sourceAvailable: (ref: SourceRef) => boolean): InputDelta {
  if (!previousCall) return gap('First retained response group has no predecessor.');
  const prevEvidence = evidence(previousCall), currEvidence = evidence(current);
  const prevRefs = orderedRefs(previousCall), currRefs = orderedRefs(current);
  const prevPoint = endpoint(previousCall, prevRefs, prevEvidence.evidence ?? [], navigation, sourceAvailable, undefined, 'last');
  const currPoint = endpoint(current, currRefs, currEvidence.evidence ?? [], navigation, sourceAvailable);
  if (prevEvidence.reason) return gap('Immediate predecessor: ' + prevEvidence.reason, prevPoint, currPoint);
  if (currEvidence.reason) return gap(currEvidence.reason, prevPoint, currPoint);
  const a = prevEvidence.evidence![0]!, b = currEvidence.evidence![0]!;
  if (a.provider !== b.provider || a.model !== b.model || a.method !== b.method || a.sessionId !== b.sessionId || a.agentId !== b.agentId) {
    return gap('Adjacent response groups change provider, exact model, actor, session, or measurement method.', prevPoint, currPoint);
  }
  if (prevRefs.length === 0 || currRefs.length === 0 || prevRefs.at(-1)!.line >= currRefs[0]!.line) {
    return gap('Overlapping aliases or same-line observations make response chronology ambiguous.', prevPoint, currPoint);
  }
  if (prevRefs.some(ref => !sourceAvailable(ref)) || currRefs.some(ref => !sourceAvailable(ref))) {
    return gap('A source or usage alias is no longer retained.', prevPoint, currPoint);
  }
  const window = interval(prevRefs[0]!, currRefs.at(-1)!, a.sessionId!, a.agentId);
  if (!window.ok) return gap(window.reason, prevPoint, currPoint);
  const previous = endpoint(previousCall, prevRefs, prevEvidence.evidence!, navigation, sourceAvailable, window.basis, 'last')!;
  const currentEndpoint = endpoint(current, currRefs, currEvidence.evidence!, navigation, sourceAvailable, window.basis)!;
  const delta = currentEndpoint.input! - previous.input!;
  if (!Number.isSafeInteger(delta)) return gap('The signed difference exceeds safe integer precision.', previous, currentEndpoint);
  return { status: 'result', delta, previous, current: currentEndpoint, windowBasis: window.basis };
}
