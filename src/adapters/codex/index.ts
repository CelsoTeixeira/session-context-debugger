import { array, identifier as string, object, text } from '../../core/json.js';
import { codexTypes } from '../../core/normalize.js';
import type { Adapter } from '../../core/normalize.js';
import type { Origin } from '../../core/types.js';

const runtimeEvents = new Set(['task_started', 'task_complete', 'token_count', 'agent_message', 'agent_reasoning', 'user_message', 'turn_aborted', 'context_compacted', 'warning', 'error']);

export const adaptCodex: Adapter = (record, meta, normalizer) => {
  const payload = object(record.payload);
  const type = string(record.type);
  const ref = meta.ref;
  if (type === 'session_meta') {
    meta.disposition = 'metadata';
    normalizer.source.actorId = string(payload.id);
    normalizer.source.rootSessionId = string(payload.session_id) ?? string(payload.id);
    normalizer.source.runtime = string(payload.originator) ?? string(payload.source);
    normalizer.source.version = string(payload.cli_version);
    const base = payload.base_instructions;
    if (typeof base === 'string' || typeof object(base).text === 'string') {
      const pointer = typeof base === 'string' ? '/payload/base_instructions' : '/payload/base_instructions/text';
      normalizer.item(ref, pointer, 'Runtime base instructions', text(base), { origin: 'harness-injected' });
    }
    if (Array.isArray(payload.dynamic_tools)) {
      normalizer.item(ref, '/payload/dynamic_tools', 'Captured dynamic tool definitions', '', {
        kind: 'tool', representation: 'metadata',
        detail: 'Recorded session configuration. Definitions do not prove request delivery or active inclusion.',
      });
    }
  } else if (type === 'token_usage_record') {
    meta.disposition = 'event';
    normalizer.codexUsage(ref, payload, '/payload');
  } else if (type === 'compacted') {
    meta.disposition = 'event';
    const alias = object(payload.latest_token_usage_record);
    if (Object.keys(alias).length) normalizer.codexUsage(ref, alias, '/payload/latest_token_usage_record');
  } else if (type === 'turn_context' || type === 'world_state') {
    meta.disposition = 'metadata';
    if (type === 'turn_context') normalizer.currentTurn = string(payload.turn_id);
    else normalizer.item(ref, '/payload', 'World-state metadata', '', {
      kind: 'metadata', representation: 'metadata',
      detail: 'Stored runtime metadata; overlapping instruction text does not establish another injection.',
    });
  } else if (type === 'item_started' || type === 'item_completed') {
    // Runtime item envelopes stay separate from the conversation representation.
    if (string(object(payload.item).type)) meta.disposition = 'metadata';
  } else if (type === 'event_msg') {
    if (runtimeEvents.has(string(payload.type) ?? '')) meta.disposition = 'metadata';
    if (payload.type === 'token_count' && payload.info === null) {
      normalizer.warnings.add('A token_count record has info:null: usage is unavailable, not zero.');
    }
  } else if (type === 'response_item') {
    const payloadType = string(payload.type) ?? '';
    if (!codexTypes.has(payloadType)) return;
    meta.disposition = 'event';
    if (payloadType !== 'message') return;
    const role = string(payload.role);
    if (role !== 'user' && role !== 'developer' && role !== 'system') return;
    const kinds = array(object(payload.internal_chat_message_metadata_passthrough).content_item_kinds);
    const content = array(payload.content);
    const mapped = kinds.length === content.length && kinds.every(kind => typeof kind === 'string');
    if (kinds.length && !mapped) normalizer.warnings.add('A captured content-kind mapping is incomplete or inconsistent; item classification stays unknown.');
    content.forEach((value, index) => {
      const block = object(value);
      const body = typeof block.text === 'string' ? block.text : undefined;
      if (body === undefined) return;
      const kind = mapped ? string(kinds[index]) : undefined;
      let origin: Origin = 'unknown';
      let label = 'Unclassified user-role content';
      let resourceKind: 'prompt' | 'instruction' | 'memory' | 'skill' | 'tool' = 'instruction';
      if (role === 'developer' || role === 'system') { origin = 'harness-injected'; label = role + ' instructions'; }
      else if (kind === 'agents_md.instructions') { origin = 'harness-injected'; label = 'Captured agents entrypoint'; }
      else if (kind === 'environments.environment_context') { origin = 'harness-injected'; label = 'Captured environment context'; }
      else if (kind === 'user.text') { origin = 'submitted-author-unknown'; label = 'Submitted prompt'; }
      if (role === 'user' && origin !== 'harness-injected') resourceKind = 'prompt';
      if (origin === 'harness-injected' && kind === 'memories.instructions') { resourceKind = 'memory'; label = 'Captured memory instructions'; }
      if (origin === 'harness-injected' && kind === 'host_skills.instructions') { resourceKind = 'skill'; label = 'Captured skill catalog'; }
      if (origin === 'harness-injected' && kind === 'plugins.recommendations') { resourceKind = 'tool'; label = 'Recommended plugin catalog'; }
      const pointer = '/payload/content/' + index + '/text';
      normalizer.item(ref, pointer, label, body, {
        kind: resourceKind,
        origin, basis: origin === 'unknown' ? 'unknown' : 'explicit',
        detail: kind ? 'Recorded content_item_kinds[' + index + ']=' + kind + '. Human authorship, delivery, and active inclusion require separate evidence.'
          : role === 'user' ? 'No supported item-kind mapping. Role alone does not prove human authorship or injection.'
          : 'Captured ' + role + '-role instructions. Delivery and active inclusion are not reconstructed.',
      });
      if (origin === 'harness-injected' && resourceKind === 'instruction') normalizer.sectionItems(ref, pointer, body);
    });
  }
};
