import { array, identifier, object } from './json.js';
import { timelineCategory } from './timeline-category.js';
import type { Obj } from './json.js';
import type { EventKind, RecordMeta, SourceFile, TimelineEvent, TimelineMap, TimelinePage } from './types.js';

const MAX_EVENTS = 40_000;
const PREVIEW = 256;
const matches = (event: TimelineEvent, filter: string): boolean => filter === 'all'
  || (filter === 'tools' ? event.kind === 'tool-call' || event.kind === 'tool-result' : event.kind === filter);

// Only small metadata and previews survive the scan. Bodies stay behind refs.
export class Timeline {
  readonly events: TimelineEvent[] = [];
  private readonly fields = new Set<string>();
  private readonly tools = new Map<string, TimelineEvent[]>();
  omitted = 0;
  constructor(readonly source: SourceFile) {}
  allows(id: string, pointer: string): boolean { return this.fields.has(id + ':' + pointer); }
  capture(record: Obj | undefined, meta: RecordMeta): void {
    if (this.events.length >= MAX_EVENTS) { this.omitted++; return; }
    const start = this.events.length;
    const actorId = identifier(record?.agentId) ?? identifier(record?.sessionId) ?? this.source.actorId ?? this.source.id;
    const timestamp = identifier(record?.timestamp);
    const add = (kind: EventKind, label: string, pointer?: string, value?: unknown, options: Partial<TimelineEvent> = {}) => {
      if (this.events.length >= MAX_EVENTS) { this.omitted++; return; }
      const text = typeof value === 'string' ? value : '';
      const event: TimelineEvent = {
        id: meta.ref.id + ':event:' + (this.events.length - start), position: this.events.length, ref: { ...meta.ref, pointer },
        kind, label, actorId, timestamp, origin: 'unknown', representation: 'unknown',
        detail: 'Recorded content; request delivery and active inclusion are unknown.',
        preview: text.slice(0, PREVIEW), previewLimited: text.length > PREVIEW, ...options,
      };
      this.events.push(event);
      if (pointer) this.fields.add(meta.ref.id + ':' + pointer);
      if (event.toolId && (kind === 'tool-call' || kind === 'tool-result')) {
        const key = JSON.stringify([event.actorId, event.toolId]);
        const group = this.tools.get(key) ?? [];
        group.push(event);
        this.tools.set(key, group);
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
        });
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
        if (record.toolUseResult !== undefined) add('metadata', 'Runtime toolUseResult copy', '/toolUseResult', undefined, {
          representation: 'metadata', detail: 'Runtime copy on the same record as tool results. Retained separately; not another execution or another primary result.',
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
  }
  page(after: number, filter: string, scanComplete: boolean): TimelinePage {
    const events: TimelineEvent[] = [];
    let position = after;
    for (; position < this.events.length && events.length < 50; position++) {
      const event = this.events[position]!;
      if (!matches(event, filter)) continue;
      if (event.kind !== 'tool-call' && event.kind !== 'tool-result') { events.push(event); continue; }
      const group = event.toolId ? this.tools.get(JSON.stringify([event.actorId, event.toolId])) ?? [] : [];
      const calls = group.filter(item => item.kind === 'tool-call');
      const results = group.filter(item => item.kind === 'tool-result');
      const opposite = event.kind === 'tool-call' ? results : calls;
      events.push({ ...event, pairStatus: !event.toolId ? 'unassigned' : !opposite.length ? 'orphan' : calls.length === 1 && results.length === 1 ? 'paired' : 'ambiguous', related: opposite.slice(0, 20).map(item => item.ref), relatedPositions: opposite.slice(0, 20).map(item => item.position),
        detail: event.detail + ' Pairing uses only recorded tool ID within this actor. At most 20 opposite references are displayed.' });
    }
    let before: number | undefined;
    for (let i = after - 1, found = 0; i >= 0 && found < 50; i--) {
      if (matches(this.events[i]!, filter)) { before = i; found++; }
    }
    return { events, before, after: position < this.events.length ? position : undefined, total: this.events.length, omitted: this.omitted,
      complete: scanComplete && !this.omitted, maxEvents: MAX_EVENTS };
  }
  map(filter: string): TimelineMap {
    const bins: TimelineMap['bins'] = [];
    const width = Math.max(1, Math.ceil(this.events.length / 120));
    let matching = 0;
    for (let start = 0; start < this.events.length; start += width) {
      const end = Math.min(this.events.length, start + width);
      const bin: TimelineMap['bins'][number] = { start, end, firstLine: this.events[start]!.ref.line,
        lastLine: this.events[end - 1]!.ref.line, counts: {}, matching: 0 };
      for (let i = start; i < end; i++) {
        const event = this.events[i]!;
        const category = timelineCategory(event);
        bin.counts[category] = (bin.counts[category] ?? 0) + 1;
        if (matches(event, filter)) { bin.matching++; bin.firstMatch ??= i; matching++; }
      }
      bins.push(bin);
    }
    return { bins, total: this.events.length, matching, omitted: this.omitted };
  }
}
