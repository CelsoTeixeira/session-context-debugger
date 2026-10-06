import { identifier, object, stable } from './json.js';
import type { Obj } from './json.js';
import type { ModelCall, ResponseIdentity, ResponseLink, ResponseView, SourceFile, TimelineEvent } from './types.js';

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

interface Group { identity: ResponseIdentity; events: TimelineEvent[]; position: number }
const link = (event: TimelineEvent): ResponseLink => ({ id: event.id, position: event.position, label: event.label, ref: event.ref });

// Metadata shares the existing bounded timeline events; captured bodies stay
// behind their original hashed references. No ordering or text-based joins.
export class RecordedResponses {
  private readonly groups = new Map<string, Group>();
  private readonly byEvent = new Map<string, string>();
  private readonly order: Group[] = [];
  constructor(readonly source: SourceFile) {}
  add(event: TimelineEvent, identity?: ResponseIdentity): void {
    if (!identity) return;
    const key = responseKey(this.source, identity);
    let group = this.groups.get(key);
    if (!group) {
      group = { identity, events: [], position: this.order.length };
      this.groups.set(key, group); this.order.push(group);
    }
    group.events.push(event); this.byEvent.set(event.id, key);
  }
  view(event: TimelineEvent, calls: ReadonlyMap<string, ModelCall>, complete: boolean): ResponseView {
    const key = this.byEvent.get(event.id), group = key ? this.groups.get(key) : undefined;
    if (!key || !group) return {
      detail: this.source.family === 'codex'
        ? 'No supported response-ID association on this event. Item IDs, runtime counters and nearby usage do not establish a response link.'
        : 'No supported actor/requestId/message.id association on this event. Nearby response content, snapshots and usage are not assigned by order.',
      complete, events: [], eventCount: 0, omittedEvents: 0, usageStatus: 'unknown', variants: [], omittedVariants: 0, total: this.order.length,
    };
    const call = calls.get(key);
    const events = group.events.slice(0, 20);
    if (!events.includes(event) && group.events.length > 20) events[19] = event;
    return {
      identity: group.identity,
      detail: this.source.family === 'claude'
        ? 'Explicit association: recorded actor, requestId and message.id match. Captured blocks remain separate; this grouping does not reconstruct the request or establish active context.'
        : 'Explicit association: recorded response_id matches within this source actor/thread. Usage aliases remain separate source evidence. Response content, prompts and snapshots are unassigned.',
      complete, events: events.map(link), eventCount: group.events.length, omittedEvents: group.events.length - events.length,
      usageStatus: call?.status ?? 'unknown',
      variants: call?.variants.slice(0, 10).map(variant => ({ values: variant.values, ref: variant.refs[0]!, matchingRefs: variant.refs.length })) ?? [],
      omittedVariants: Math.max(0, (call?.variants.length ?? 0) - 10),
      previous: this.order[group.position - 1] ? link(this.order[group.position - 1]!.events[0]!) : undefined,
      next: this.order[group.position + 1] ? link(this.order[group.position + 1]!.events[0]!) : undefined,
      position: group.position, total: this.order.length,
    };
  }
}
