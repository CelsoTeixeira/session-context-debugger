import { identifier, object, stable } from './json.js';
import type { Obj } from './json.js';
import type { CapturedRecordResponseView, ModelCall, ProviderResponseView, ResponseGroupView, ResponseIdentity, ResponseLink, ResponseView, SourceFile, SourceRef, TimelineEvent, UnknownResponseView } from './types.js';

export function claudeResponse(source: SourceFile, record: Obj): ResponseIdentity | undefined {
  const message = object(record.message);
  const requestId = identifier(record.requestId), messageId = identifier(message.id);
  const actorId = identifier(record.agentId) ?? identifier(record.sessionId) ?? source.actorId;
  return record.type === 'assistant' && message.role === 'assistant' && actorId && requestId && messageId
    ? { actorId, requestId, messageId } : undefined;
}
export function codexResponse(source: SourceFile, payload: Obj): ResponseIdentity | undefined {
  const responseId = identifier(payload.response_id);
  return responseId ? { actorId: source.actorId ?? source.id, responseId } : undefined;
}
export function responseKey(source: SourceFile, identity: ResponseIdentity): string {
  return (source.actorId ?? source.id) + ':' + (identity.responseId ?? stable([identity.actorId, identity.requestId, identity.messageId]));
}

interface GroupBase { events: TimelineEvent[]; position: number }
interface ProviderGroup extends GroupBase { groupKind: 'provider-response'; key: string; identity: ResponseIdentity }
interface CapturedRecordGroup extends GroupBase { groupKind: 'captured-record'; source: SourceRef; actorId: string }
type Group = ProviderGroup | CapturedRecordGroup;

const link = (event: TimelineEvent): ResponseLink => ({ id: event.id, position: event.position, label: event.label, ref: event.ref });
const physicalSource = (ref: SourceRef): SourceRef => {
  const source = { ...ref };
  delete source.pointer;
  return source;
};
const neighboringLinks = (order: Group[], position: number): Pick<ResponseGroupView, 'previous' | 'next'> => ({
  previous: order[position - 1] ? link(order[position - 1]!.events[0]!) : undefined,
  next: order[position + 1] ? link(order[position + 1]!.events[0]!) : undefined,
});
const boundedEvents = (group: Group, selected: TimelineEvent): ResponseLink[] => {
  const events = group.events.slice(0, 20);
  if (!events.includes(selected) && group.events.length > 20) events[19] = selected;
  return events.map(link);
};

// Metadata shares the existing bounded timeline events; captured bodies stay
// behind their original hashed references. No ordering or text-based joins.
export class RecordedResponses {
  private readonly providerGroups = new Map<string, ProviderGroup>();
  private readonly capturedGroups = new Map<string, CapturedRecordGroup>();
  private readonly byEvent = new Map<string, Group>();
  private readonly order: Group[] = [];
  constructor(readonly source: SourceFile) {}
  add(event: TimelineEvent, identity?: ResponseIdentity): void {
    if (!identity) return;
    const key = responseKey(this.source, identity);
    let group = this.providerGroups.get(key);
    if (!group) {
      group = { groupKind: 'provider-response', key, identity, events: [], position: this.order.length };
      this.providerGroups.set(key, group); this.order.push(group);
    }
    group.events.push(event); this.byEvent.set(event.id, group);
  }
  addCapturedRecord(event: TimelineEvent): void {
    const key = JSON.stringify([this.source.id, event.ref.id]);
    let group = this.capturedGroups.get(key);
    if (!group) {
      group = { groupKind: 'captured-record', source: physicalSource(event.ref), actorId: event.actorId,
        events: [], position: this.order.length };
      this.capturedGroups.set(key, group); this.order.push(group);
    }
    group.events.push(event); this.byEvent.set(event.id, group);
  }
  view(event: TimelineEvent, calls: ReadonlyMap<string, ModelCall>, complete: boolean): ResponseView {
    const group = this.byEvent.get(event.id);
    if (!group) {
      const unknown: UnknownResponseView = {
        groupKind: 'unknown', basis: 'none',
        detail: this.source.family === 'codex'
          ? 'No supported response-ID or eligible same-record assistant capture association on this event. Item IDs, runtime counters and nearby usage do not establish a response link.'
          : 'No supported actor/requestId/message.id or eligible same-record assistant capture association on this event. Nearby response content, snapshots and usage are not assigned by order.',
        complete, events: [], eventCount: 0, omittedEvents: 0, usageStatus: 'unknown', variants: [], omittedVariants: 0, total: this.order.length,
      };
      return unknown;
    }
    const events = boundedEvents(group, event);
    const neighbors = neighboringLinks(this.order, group.position);
    if (group.groupKind === 'captured-record') {
      const captured: CapturedRecordResponseView = {
        groupKind: 'captured-record', basis: 'same-physical-record', source: group.source, actorId: group.actorId,
        requestAssociation: 'unknown', providerUsageAssociation: 'unknown',
        detail: 'Capture-only group: retained assistant blocks share physical record line ' + group.source.line + ' in selected source instance ' + group.source.sourceId + '. This does not establish a provider response, request, or model invocation.',
        complete, events, eventCount: group.events.length, omittedEvents: group.events.length - events.length,
        usageStatus: 'unknown', variants: [], omittedVariants: 0,
        ...neighbors, position: group.position, total: this.order.length,
      };
      return captured;
    }
    const call = calls.get(group.key);
    const provider: ProviderResponseView = {
      groupKind: 'provider-response', basis: 'recorded-provider-identifiers', identity: group.identity,
      detail: this.source.family === 'claude'
        ? 'Explicit association: recorded actor, requestId and message.id match. Captured blocks remain separate; this grouping does not reconstruct the request or establish active context.'
        : 'Explicit association: recorded response_id matches within this source actor/thread. Usage aliases remain separate source evidence. Response content, prompts and snapshots are unassigned.',
      complete, events, eventCount: group.events.length, omittedEvents: group.events.length - events.length,
      usageStatus: call?.status ?? 'unknown',
      variants: call?.variants.slice(0, 10).map(variant => ({ values: variant.values, ref: variant.refs[0]!, matchingRefs: variant.refs.length })) ?? [],
      omittedVariants: Math.max(0, (call?.variants.length ?? 0) - 10),
      ...neighbors, position: group.position, total: this.order.length,
    };
    return provider;
  }
}
