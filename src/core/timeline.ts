import { array, identifier, object } from './json.js';
import { timelineCategory, timelineCategoryMatches } from './timeline-category.js';
import { measureCaptures } from './payload-size.js';
import { claudeResponse, codexResponse, RecordedResponses } from './responses.js';
import type { Obj } from './json.js';
import type { EventKind, RecordMeta, ResponseNavigation, SourceFile, SourceRef, TimelineEvent, TimelineFilter, TimelineMap, TimelinePage, TimelineRelationship, TimelineRelationshipBasis, TimelineRelationshipKind, TimelineRelationshipLink } from './types.js';

const MAX_EVENTS = 40_000;
const MAX_EVENT_LINKS = 20;
const PREVIEW = 256;
const matches = (event: TimelineEvent, filter: TimelineFilter): boolean => timelineCategoryMatches(timelineCategory(event), filter);
type CodexItemSide = 'lifecycle' | 'response';
interface CodexItemGroup { lifecycle: TimelineEvent[]; response: TimelineEvent[] }
interface ClaudeRecordEvents {
  runtime?: TimelineEvent;
  runtimeToolId?: string;
  results: TimelineEvent[];
  resultIds: Set<string>;
  resultsByToolId: Map<string, TimelineEvent[]>;
  missingToolIds: number;
  incomplete: boolean;
}
const relationshipLink = (kind: TimelineRelationshipKind, basis: TimelineRelationshipBasis, target: TimelineEvent): TimelineRelationshipLink => ({
  kind, basis, target: { id: target.id, position: target.position, label: target.label.slice(0, 100), source: { ...target.ref } },
});
const otherEvents = (events: TimelineEvent[], source: TimelineEvent, limit: number): TimelineEvent[] =>
  events.slice(0, limit + 1).filter(event => event.id !== source.id).slice(0, limit);

// Only small metadata and previews survive the scan. Bodies stay behind refs.
export class Timeline {
  readonly events: TimelineEvent[] = [];
  private readonly fields = new Set<string>();
  private readonly records = new Map<string, TimelineEvent[]>();
  private readonly tools = new Map<string, { calls: TimelineEvent[]; results: TimelineEvent[] }>();
  private readonly codexItemGroups = new Map<string, CodexItemGroup>();
  private readonly codexItemMembership = new Map<string, { key?: string; side: CodexItemSide }>();
  private readonly claudeRecords = new Map<string, ClaudeRecordEvents>();
  omitted = 0;
  readonly responses: RecordedResponses;
  constructor(readonly source: SourceFile) { this.responses = new RecordedResponses(source); }
  allows(id: string, pointer: string): boolean { return this.fields.has(id + ':' + pointer); }
  capture(record: Obj | undefined, meta: RecordMeta): void {
    if (this.events.length >= MAX_EVENTS) {
      this.omitted++;
      const claude = this.claudeRecords.get(meta.ref.id);
      if (claude) claude.incomplete = true;
      return;
    }
    const start = this.events.length;
    const actorId = identifier(record?.agentId) ?? identifier(record?.sessionId) ?? this.source.actorId ?? this.source.id;
    const timestamp = identifier(record?.timestamp);
    const response = record && this.source.family === 'claude' ? claudeResponse(this.source, record)
      : this.source.family === 'codex' && record?.type === 'token_usage_record' ? codexResponse(this.source, object(record.payload)) : undefined;
    const add = (kind: EventKind, label: string, pointer?: string, value?: unknown, options: Partial<TimelineEvent> = {}, identity = response) => {
      if (this.events.length >= MAX_EVENTS) {
        this.omitted++;
        const claude = this.claudeRecords.get(meta.ref.id);
        if (claude) claude.incomplete = true;
        return;
      }
      const text = typeof value === 'string' ? value : '';
      const event: TimelineEvent = {
        id: meta.ref.id + ':event:' + (this.events.length - start), position: this.events.length, ref: { ...meta.ref, pointer },
        kind, label, actorId, timestamp, origin: 'unknown', representation: 'unknown',
        detail: 'Recorded content; request delivery and active inclusion are unknown.',
        serializedBytes: null, allocatedBytes: null,
        preview: text.slice(0, PREVIEW), previewLimited: text.length > PREVIEW, ...options,
      };
      this.events.push(event);
      this.responses.add(event, identity);
      if (!identity && this.capturedAssistantRecord(record, pointer, event)) this.responses.addCapturedRecord(event);
      const recordEvents = this.records.get(meta.ref.id) ?? [];
      recordEvents.push(event);
      this.records.set(meta.ref.id, recordEvents);
      if (pointer) this.fields.add(meta.ref.id + ':' + pointer);
      if (event.toolId && (kind === 'tool-call' || kind === 'tool-result')) {
        const key = JSON.stringify([event.actorId, event.toolId]);
        const group = this.tools.get(key) ?? { calls: [], results: [] };
        (kind === 'tool-call' ? group.calls : group.results).push(event);
        this.tools.set(key, group);
      }
      if (this.source.family === 'codex' && record) {
        const payload = object(record.payload);
        const lifecycle = record.type === 'item_started' || record.type === 'item_completed'
          || record.type === 'event_msg' && (payload.type === 'item_started' || payload.type === 'item_completed');
        const side: CodexItemSide | undefined = record.type === 'response_item' && options.representation === 'primary' ? 'response'
          : lifecycle && options.representation === 'metadata' ? 'lifecycle' : undefined;
        if (side) {
          const item = side === 'response' ? payload : object(payload.item);
          const itemId = identifier(item.id);
          const threadId = identifier(record.thread_id) ?? identifier(payload.thread_id) ?? this.source.actorId ?? this.source.id;
          const key = itemId ? JSON.stringify([this.source.id, event.actorId, threadId, itemId]) : undefined;
          this.codexItemMembership.set(event.id, { key, side });
          if (key) {
            const group = this.codexItemGroups.get(key) ?? { lifecycle: [], response: [] };
            group[side].push(event);
            this.codexItemGroups.set(key, group);
          }
        }
      }
      if (this.source.family === 'claude' && record && (pointer === '/toolUseResult' && kind === 'metadata' || kind === 'tool-result')) {
        const group = this.claudeRecords.get(meta.ref.id) ?? { results: [], resultIds: new Set<string>(), resultsByToolId: new Map<string, TimelineEvent[]>(), missingToolIds: 0, incomplete: false };
        if (pointer === '/toolUseResult' && kind === 'metadata') {
          group.runtime = event;
          group.runtimeToolId = identifier(object(record.toolUseResult).tool_use_id);
        } else if (kind === 'tool-result') {
          group.results.push(event);
          group.resultIds.add(event.id);
          if (event.toolId) {
            const byId = group.resultsByToolId.get(event.toolId) ?? [];
            byId.push(event);
            group.resultsByToolId.set(event.toolId, byId);
          } else group.missingToolIds++;
        }
        this.claudeRecords.set(meta.ref.id, group);
      }
    };
    if (record && this.source.family === 'codex') {
      const payload = object(record.payload);
      const type = identifier(payload.type);
      const lifecycleItem = object(payload.item);
      const item = record.type === 'response_item' ? payload : lifecycleItem;
      const base = record.type === 'response_item' ? '/payload' : '/payload/item';
      if (record.type === 'response_item') {
        const options: Partial<TimelineEvent> = { recordedId: identifier(item.id), representation: 'primary' };
        if (item.type === 'message') {
          const role = identifier(item.role);
          const kinds = array(object(payload.internal_chat_message_metadata_passthrough).content_item_kinds);
          const content = array(item.content);
          const mapped = kinds.length === content.length && kinds.every(kind => typeof kind === 'string');
          content.forEach((value, i) => {
            const block = object(value);
            const capturedKind = mapped ? identifier(kinds[i]) : undefined;
            const media = ['input_image', 'output_image', 'image'].includes(String(block.type));
            add(media ? 'attachment' : typeof block.text === 'string' ? 'message' : 'unknown', media ? 'Captured image block' : role ? role + ' message' : 'Message', base + '/content/' + i, block.text, {
              ...options, role,
              origin: capturedKind === 'user.text' ? 'submitted-author-unknown'
                : role === 'developer' || role === 'system' || capturedKind === 'agents_md.instructions' || capturedKind === 'environments.environment_context' ? 'harness-injected' : 'unknown',
              detail: capturedKind ? 'Recorded content kind: ' + capturedKind + '. Delivery and active inclusion remain unknown.' : 'Captured message block. Authorship and delivery are unknown.',
            });
          });
        } else if (['function_call', 'custom_tool_call'].includes(String(item.type))) {
          add('tool-call', identifier(item.name) ?? 'Tool call', base, item.arguments ?? item.input, { ...options, toolId: identifier(item.call_id) });
        } else if (['function_call_output', 'custom_tool_call_output'].includes(String(item.type))) {
          add('tool-result', 'Tool result', base, item.output, { ...options, toolId: identifier(item.call_id) });
        } else if (item.type === 'web_search_call' || item.type === 'local_shell_call') {
          add('tool-call', item.type, base, undefined, { ...options, toolId: identifier(item.call_id) ?? identifier(item.id),
            detail: 'Recorded native tool activity. Embedded action/status fields remain in the source; absence of a separate result is not proof of failure.',
          });
        } else if (item.type === 'reasoning') {
          const summary = array(item.summary);
          add('reasoning', 'Captured reasoning', base, object(summary[0]).text, {
            ...options, detail: 'Preview uses the first recorded summary block only. Inspect source for all captured reasoning fields; missing fields are unknown.',
          });
        } else if (item.type === 'compaction') add('lifecycle', 'Compaction representation', base, undefined, options);
      } else if (record.type === 'token_usage_record') {
        add('usage', 'Provider usage', '/payload/usage', undefined, {
          recordedId: identifier(payload.response_id), representation: 'primary',
          detail: 'Recorded response usage; invocation scope remains unknown.',
        });
      } else if (record.type === 'event_msg' && type === 'token_count') {
        add('usage', 'Runtime token counter', '/payload', undefined, {
          detail: 'Runtime counter stream; call association unknown. Missing/null fields are not zero.',
        });
      } else if (record.type === 'event_msg' && ['user_message', 'agent_message', 'agent_reasoning'].includes(type ?? '')) {
        add(type === 'agent_reasoning' ? 'reasoning' : 'message', 'Runtime ' + type, '/payload', payload.message ?? payload.text, {
          detail: 'Runtime representation. No supported identity join to a response item; retained separately without equality-based collapse.',
        });
      } else if (record.type === 'item_started' || record.type === 'item_completed' || record.type === 'event_msg' && (type === 'item_started' || type === 'item_completed')) {
        add('lifecycle', (record.type === 'event_msg' ? type : record.type) + ' · ' + (identifier(lifecycleItem.type) ?? 'unknown item'), '/payload', undefined, {
          recordedId: identifier(lifecycleItem.id), representation: 'metadata', detail: 'Recorded item lifecycle; item identity is preserved. This is not another tool execution.',
        });
      } else if (record.type === 'compacted') {
        add('lifecycle', 'Recorded compaction', '/payload', undefined);
        const alias = object(payload.latest_token_usage_record);
        if (alias.usage !== undefined) add('usage', 'Embedded provider usage observation', '/payload/latest_token_usage_record/usage', undefined, {
          recordedId: identifier(alias.response_id), representation: 'metadata', detail: 'Usage alias candidate. The usage index reconciles matching recorded response identities and measurements; this is not another model call.',
        }, codexResponse(this.source, alias));
      }
    } else if (record && this.source.family === 'claude') {
      const message = object(record.message);
      if ((record.type === 'user' || record.type === 'assistant') && message.role === record.type) {
        const options: Partial<TimelineEvent> = { role: identifier(message.role), recordedId: identifier(message.id) ?? identifier(record.uuid), representation: 'primary',
          origin: record.type === 'user' && (object(record.origin).kind === 'human' || record.turnOrigin === 'human') ? 'human-recorded' : record.type === 'user' && record.turnOrigin === 'sdk' ? 'submitted-author-unknown' : 'unknown',
          detail: record.isVisibleInTranscriptOnly === true ? 'Recorded transcript-only content; not evidence of active input.' : record.isCompactSummary === true ? 'Recorded compaction summary; active inclusion is separate.' : 'Captured content; delivery and active inclusion are unknown.',
        };
        if (typeof message.content === 'string') add('message', String(record.type) + ' message', '/message/content', message.content, options);
        else array(message.content).forEach((value, i) => {
          const block = object(value);
          const pointer = '/message/content/' + i;
          const blockType = identifier(block.type);
          if (blockType === 'tool_use') add('tool-call', identifier(block.name) ?? 'Tool call', pointer, undefined, { ...options, toolId: identifier(block.id) });
          else if (blockType === 'tool_result') add('tool-result', 'Tool result', pointer, typeof block.content === 'string' ? block.content : undefined, { ...options, toolId: identifier(block.tool_use_id) });
          else if (blockType === 'thinking' || blockType === 'redacted_thinking') add('reasoning', blockType === 'thinking' ? 'Captured reasoning' : 'Redacted reasoning', pointer, block.thinking, options);
          else add(blockType === 'text' ? 'message' : blockType === 'image' || blockType === 'document' ? 'attachment' : 'unknown', blockType === 'text' ? String(record.type) + ' message' : 'Captured ' + (blockType ?? 'unknown block'), pointer, block.text, {
            ...options, origin: record.type === 'user' && (object(record.origin).kind === 'human' || record.turnOrigin === 'human') ? 'human-recorded' : record.type === 'user' && record.turnOrigin === 'sdk' ? 'submitted-author-unknown' : 'unknown',
            detail: record.isCompactSummary === true ? 'Recorded compaction summary; active inclusion is separate.' : record.isVisibleInTranscriptOnly === true ? 'Recorded transcript-only content; not evidence of active input.' : 'Captured content; delivery and active inclusion are unknown.',
          });
        });
        if (message.usage !== undefined) add('usage', 'Provider usage', '/message/usage', undefined, {
          recordedId: identifier(message.id), detail: 'Recorded message usage. Request ID: ' + (identifier(record.requestId) ?? 'unknown') + '. Identical measurements are reconciled separately in usage groups.',
        });
        if (record.toolUseResult !== undefined) add('metadata', 'Runtime toolUseResult metadata', '/toolUseResult', undefined, {
          representation: 'metadata', detail: 'Runtime result metadata recorded on this physical record. It remains a separate representation; a relationship does not establish identical content, another execution, request membership, or active inclusion.',
        });
      } else if (record.type === 'attachment') {
        const diagnostic = object(record.attachment).type === 'prompt_snapshot';
        add('attachment', diagnostic ? 'Diagnostic prompt snapshot' : 'Attachment · ' + (identifier(object(record.attachment).type) ?? 'unknown'), '/attachment', undefined, {
          representation: diagnostic ? 'diagnostic-snapshot' : 'unknown', detail: diagnostic ? 'Diagnostic evidence; not automatically another injection. Call association is unassigned.' : 'Recorded attachment; request delivery and active inclusion are unknown.',
        });
      }
    }
    if (this.events.length === start && this.events.length < MAX_EVENTS) {
      add(meta.disposition === 'metadata' ? 'metadata' : meta.disposition === 'event' ? 'lifecycle' : 'unknown',
        [meta.outerType, meta.payloadType, meta.itemType].filter(Boolean).join(' / '), undefined, undefined, {
          representation: meta.disposition === 'metadata' ? 'metadata' : 'unknown',
          detail: meta.reason ?? 'Physical record retained with disposition: ' + meta.disposition + '. Inspect raw source for its full content.',
        });
    }
    measureCaptures(record, this.events.slice(start));
  }
  private capturedAssistantRecord(record: Obj | undefined, pointer: string | undefined, event: TimelineEvent): boolean {
    if (!record || event.representation !== 'primary') return false;
    if (this.source.family === 'codex' && record.type === 'response_item') {
      const payload = object(record.payload);
      if (payload.type === 'message') return payload.role === 'assistant' && event.role === 'assistant'
        && event.kind !== 'tool-result' && event.kind !== 'usage';
      if (payload.type === 'reasoning') return event.kind === 'reasoning';
      return ['function_call', 'custom_tool_call', 'web_search_call', 'local_shell_call'].includes(String(payload.type))
        && event.kind === 'tool-call';
    }
    if (this.source.family === 'claude' && record.type === 'assistant' && object(record.message).role === 'assistant'
      && pointer && (pointer === '/message/content' || pointer.startsWith('/message/content/'))) {
      return event.kind !== 'tool-result' && event.kind !== 'usage';
    }
    return false;
  }
  responseNavigation(ref: SourceRef, matchingRefs: readonly SourceRef[] = [ref]): ResponseNavigation | undefined {
    // Matching refs already belong to one reconciled identity/measurement.
    // Each content link additionally requires usage on that physical record.
    const recordEvents: TimelineEvent[] = [];
    const usages: TimelineEvent[] = [];
    const seen = new Set<string>();
    for (const reference of matchingRefs) {
      if (seen.has(reference.id)) continue;
      seen.add(reference.id);
      const events = this.records.get(reference.id) ?? [];
      const usage = events.find(event => event.kind === 'usage' && event.ref.pointer === reference.pointer);
      if (usage) { usages.push(usage); recordEvents.push(...events); }
    }
    if (!usages.length) return undefined;
    const response = this.source.family === 'claude'
      ? recordEvents.filter(event => event.role === 'assistant' && event.representation === 'primary') : [];
    const target = response.find(event => event.kind === 'message') ?? response.find(event => event.kind === 'tool-call') ?? response[0] ?? usages[0]!;
    const related = [...response, ...usages].filter(event => event.id !== target.id);
    return {
      target: { id: target.id, position: target.position },
      detail: response.length ? 'Explicit recorded association: each response block shares a physical record with usage in this reconciled response group. Matching copies remain separate. Prompt, instruction, and snapshot associations remain unknown.'
        : 'Jump targets the recorded usage evidence. Association with response content, prompts, instructions, or snapshots remains unknown.',
      related: related.slice(0, 20).map(event => ({ id: event.id, position: event.position, label: event.label, ref: event.ref })),
      omitted: Math.max(0, related.length - 20),
    };
  }
  recordTarget(refId: string): { id: string; position: number } | undefined {
    const event = this.records.get(refId)?.[0];
    return event ? { id: event.id, position: event.position } : undefined;
  }
  page(after: number, filter: TimelineFilter, scanComplete: boolean): TimelinePage {
    const events: TimelineEvent[] = [];
    let position = after;
    for (; position < this.events.length && events.length < 50; position++) {
      const event = this.events[position]!;
      if (!matches(event, filter)) continue;
      const relationships = this.eventRelationships(event, scanComplete);
      if (event.kind === 'tool-call' || event.kind === 'tool-result') {
        const group = event.toolId ? this.tools.get(JSON.stringify([event.actorId, event.toolId])) : undefined;
        const calls = group?.calls ?? [];
        const results = group?.results ?? [];
        const opposite = event.kind === 'tool-call' ? results : calls;
        const pairStatus = !event.toolId ? 'unassigned' : !opposite.length ? 'orphan' : calls.length === 1 && results.length === 1 ? 'paired' : 'ambiguous';
        events.push({ ...event, pairStatus, relationships });
      } else events.push({ ...event, ...(relationships.length ? { relationships } : {}) });
    }
    let before: number | undefined;
    for (let i = after - 1, found = 0; i >= 0 && found < 50; i--) {
      if (matches(this.events[i]!, filter)) { before = i; found++; }
    }
    return { events, before, after: position < this.events.length ? position : undefined, total: this.events.length, omitted: this.omitted,
      complete: scanComplete && !this.omitted, maxEvents: MAX_EVENTS };
  }
  map(filter: TimelineFilter): TimelineMap {
    const bins: TimelineMap['bins'] = [];
    const ranking = new Map<string, TimelineMap['ranking'][number]>();
    const width = Math.max(1, Math.ceil(this.events.length / 120));
    let matching = 0;
    for (let start = 0; start < this.events.length; start += width) {
      const end = Math.min(this.events.length, start + width);
      const bin: TimelineMap['bins'][number] = { start, end, firstLine: this.events[start]!.ref.line,
        lastLine: this.events[end - 1]!.ref.line, counts: {}, matching: 0 };
      for (let i = start; i < end; i++) {
        const event = this.events[i]!;
        const category = timelineCategory(event);
        const key = event.representation + ':' + category;
        const row = ranking.get(key) ?? { category, representation: event.representation, events: 0, measuredEvents: 0, bytes: 0, firstRef: event.ref };
        row.events++;
        if (event.allocatedBytes !== null) {
          row.measuredEvents++; row.bytes += event.allocatedBytes;
          if (!row.largest || event.allocatedBytes > row.largest.bytes) row.largest = { bytes: event.allocatedBytes, ref: event.ref };
        }
        ranking.set(key, row);
        bin.counts[category] = (bin.counts[category] ?? 0) + 1;
        if (matches(event, filter)) { bin.matching++; bin.firstMatch ??= i; matching++; }
      }
      bins.push(bin);
    }
    return { bins, total: this.events.length, matching, omitted: this.omitted, ranking: [...ranking.values()] };
  }
  private eventRelationships(event: TimelineEvent, scanComplete: boolean): TimelineRelationship[] {
    const relationships: TimelineRelationship[] = [];
    if (event.kind === 'tool-call' || event.kind === 'tool-result') relationships.push(this.toolRelationship(event, scanComplete));
    const membership = this.codexItemMembership.get(event.id);
    if (membership) relationships.push(this.codexItemRelationship(event, membership, scanComplete));
    const claude = this.claudeRelationship(event, scanComplete);
    if (claude) relationships.push(claude);
    return relationships;
  }
  private toolRelationship(event: TimelineEvent, scanComplete: boolean): TimelineRelationship {
    const group = event.toolId ? this.tools.get(JSON.stringify([event.actorId, event.toolId])) : undefined;
    const calls = group?.calls ?? [];
    const results = group?.results ?? [];
    const opposite = event.kind === 'tool-call' ? results : calls;
    const status: TimelineRelationship['status'] = !event.toolId ? 'unassigned' : !opposite.length ? 'orphan' : calls.length === 1 && results.length === 1 ? 'linked' : 'ambiguous';
    const kind: TimelineRelationshipKind = 'tool-counterpart';
    const basis: TimelineRelationshipBasis | undefined = event.toolId ? 'recorded-tool-id-within-actor' : undefined;
    const links = opposite.slice(0, MAX_EVENT_LINKS).map(target => relationshipLink(kind, basis!, target));
    const omitted = Math.max(0, opposite.length - links.length);
    return { kind, status, basis, links, omitted, complete: scanComplete && !this.omitted && !omitted,
      detail: basis ? 'Recorded tool ID within this source actor; counterpart links keep the existing call/result semantics.'
        : 'No recorded tool ID; the counterpart remains unassigned.' };
  }
  private codexItemRelationship(event: TimelineEvent, membership: { key?: string; side: CodexItemSide }, scanComplete: boolean): TimelineRelationship {
    const kind: TimelineRelationshipKind = 'codex-item-representation';
    if (!membership.key) return { kind, status: 'unassigned', links: [], omitted: 0, complete: scanComplete && !this.omitted,
      detail: 'No explicit recorded item.id; no link is inferred from text, timing, or proximity.' };
    const group = this.codexItemGroups.get(membership.key)!;
    const lifecycleTargets = membership.side === 'response' ? group.lifecycle : otherEvents(group.lifecycle, event, MAX_EVENT_LINKS);
    const responseTargets = membership.side === 'lifecycle' ? group.response.slice(0, MAX_EVENT_LINKS) : [];
    const selected = membership.side === 'response' ? lifecycleTargets
      : [...responseTargets, ...otherEvents(group.lifecycle, event, Math.max(0, MAX_EVENT_LINKS - responseTargets.length))];
    const total = membership.side === 'response' ? group.lifecycle.length : group.response.length + Math.max(0, group.lifecycle.length - 1);
    const basis: TimelineRelationshipBasis = 'recorded-item.id-within-actor-thread';
    const links = selected.slice(0, MAX_EVENT_LINKS).map(target => relationshipLink(kind, basis, target));
    const omitted = Math.max(0, total - links.length);
    const detail = links.length
      ? 'Recorded item.id matches within this source actor/thread. Content blocks remain distinct; this does not prove identical content, another execution, request membership, or active inclusion.'
      : 'Recorded item.id is present, but no other lifecycle/content event with that ID is retained within this source actor/thread.';
    return { kind, status: links.length ? 'linked' : 'orphan', basis, links, omitted, complete: scanComplete && !this.omitted && !omitted, detail };
  }
  private claudeRelationship(event: TimelineEvent, scanComplete: boolean): TimelineRelationship | undefined {
    if (this.source.family !== 'claude') return undefined;
    const group = this.claudeRecords.get(event.ref.id);
    if (!group || event.id !== group.runtime?.id && !group.resultIds.has(event.id)) return undefined;
    const kind: TimelineRelationshipKind = 'claude-runtime-result';
    const isRuntime = event.id === group.runtime?.id;
    const candidates = group.runtimeToolId ? group.resultsByToolId.get(group.runtimeToolId) ?? [] : group.results;
    let status: TimelineRelationship['status'] = 'unassigned';
    let basis: TimelineRelationshipBasis | undefined;
    let targets: TimelineEvent[] = [];
    let targetCount = 0;
    let detail: string;
    if (group.runtime && group.runtimeToolId) {
      if (candidates.length) {
        basis = 'same-record-tool_use_id';
        targets = isRuntime ? candidates.slice(0, MAX_EVENT_LINKS) : event.toolId === group.runtimeToolId ? [group.runtime] : [];
        targetCount = isRuntime ? candidates.length : targets.length;
        const uncertainCandidates = group.missingToolIds > 0 || group.incomplete;
        status = candidates.length === 1 && !uncertainCandidates ? 'linked' : 'ambiguous';
        detail = candidates.length === 1 && !uncertainCandidates
          ? 'Recorded tool_use_id matches the runtime and tool_result representations on this physical record; content remains independent.'
          : 'Recorded tool_use_id matches ' + candidates.length.toLocaleString() + ' retained tool_result blocks' + (group.missingToolIds ? '; ' + group.missingToolIds.toLocaleString() + ' result blocks lack IDs.' : '.') + (group.incomplete ? ' Record indexing is incomplete.' : ' Each candidate remains separate.');
      } else if (group.missingToolIds) {
        status = 'ambiguous';
        detail = 'Runtime tool_use_id is recorded, but same-record tool_result blocks lack an ID to confirm or reject the match.';
      } else {
        detail = 'No retained same-record tool_result has the runtime tool_use_id.';
      }
    } else if (group.runtime && !group.runtimeToolId) {
      if (group.results.length === 1 && !group.incomplete) {
        basis = 'unique-same-record-tool_result';
        targets = isRuntime ? [group.results[0]!] : [group.runtime];
        targetCount = 1;
        status = 'linked';
        detail = 'One retained tool_result block is present on this physical record. Runtime metadata remains separate; this does not establish identical content, request membership, or another execution.';
      } else if (group.results.length > 1 || group.results.length === 1 && group.incomplete) {
        status = 'ambiguous';
        detail = group.results.length + ' retained same-record tool_result candidates' + (group.incomplete ? '; record indexing is incomplete, so uniqueness is unknown.' : '; no candidate is selected without a recorded ID.');
      } else if (group.incomplete) {
        status = 'ambiguous';
        detail = 'Record indexing is incomplete; the presence of a same-record tool_result is unknown.';
      } else {
        detail = 'No same-record tool_result block is retained.';
      }
    } else if (group.incomplete) {
      status = 'ambiguous';
      detail = 'Record indexing is incomplete; runtime toolUseResult presence is unknown.';
    } else if (group.results.length > 1) {
      status = 'ambiguous';
      detail = group.results.length + ' same-record tool_result candidates have no runtime ID; no candidate is selected.';
    } else {
      detail = 'No runtime toolUseResult metadata is retained on this physical record.';
    }
    if (!isRuntime && group.runtime && group.runtimeToolId && event.toolId !== group.runtimeToolId) {
      targets = []; targetCount = 0;
      if (event.toolId) {
        status = 'unassigned'; basis = undefined;
        detail = 'This tool_result has no matching recorded tool_use_id for the same-record runtime metadata.';
      } else {
        status = 'ambiguous'; basis = undefined;
        detail = 'This same-record tool_result has no recorded tool_use_id to confirm or reject the runtime match.';
      }
    } else if (!isRuntime && group.runtime && !group.runtimeToolId && group.results.length !== 1) {
      targets = []; targetCount = 0;
    } else if (!isRuntime && !group.runtime) { targets = []; targetCount = 0; }
    const links = targets.slice(0, MAX_EVENT_LINKS).map(target => relationshipLink(kind, basis!, target));
    const omitted = Math.max(0, targetCount - links.length);
    return { kind, status, basis, links, omitted, complete: scanComplete && !this.omitted && !group.incomplete && !omitted, detail };
  }
}
