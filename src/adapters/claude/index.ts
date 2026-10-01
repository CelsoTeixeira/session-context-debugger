import { array, identifier as string, object, pointerPart } from '../../core/json.js';
import type { Adapter } from '../../core/normalize.js';

const metadataTypes = new Set(['queue-operation', 'last-prompt', 'custom-title', 'agent-name', 'atis-latch', 'bridge-session', 'file-history-snapshot']);
const metadataAttachments = new Set(['environment', 'model', 'agent_listing_delta', 'auto_mode', 'total_tokens_reminder', 'session_context', 'date', 'credential_org']);
const knownBlocks = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result', 'image', 'document']);

export const adaptClaude: Adapter = (record, meta, normalizer) => {
  const type = string(record.type);
  const ref = meta.ref;
  const message = object(record.message);
  normalizer.source.actorId ??= string(record.agentId) ?? string(record.sessionId);
  normalizer.source.rootSessionId ??= string(record.sessionId);
  normalizer.source.runtime ??= string(record.entrypoint);
  normalizer.source.version ??= string(record.version);
  if (metadataTypes.has(type ?? '')) {
    // Require an inspected identifying field in addition to the type name.
    if (type === 'file-history-snapshot' && record.snapshot ||
      type === 'queue-operation' && typeof record.operation === 'string' ||
      string(record.sessionId) || string(record.uuid)) meta.disposition = 'metadata';
    return;
  }
  if (type === 'user' || type === 'assistant') {
    if (message.role !== type || !(typeof message.content === 'string' || Array.isArray(message.content))) return;
    const blocks = array(message.content);
    if (blocks.some(value => !knownBlocks.has(string(object(value).type) ?? ''))) return;
    meta.disposition = 'event';
    if (type === 'assistant') { normalizer.claudeUsage(ref, record); return; }
    if (record.isMeta === true || record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true) return;
    const human = object(record.origin).kind === 'human' || record.turnOrigin === 'human';
    const submitted = human || record.turnOrigin === 'sdk';
    // A user-role tool_result is not a submitted prompt.
    if (!submitted && blocks.some(value => object(value).type === 'tool_result')) return;
    const options = {
      kind: 'prompt' as const,
      origin: human ? 'human-recorded' as const : submitted ? 'submitted-author-unknown' as const : 'unknown' as const,
      basis: submitted ? 'explicit' as const : 'unknown' as const,
      detail: human ? 'Recorded origin.kind/turnOrigin identifies human input.'
        : submitted ? 'Recorded SDK turnOrigin; author is unknown.'
        : 'Captured user-role text without supported authorship/submission evidence.',
    };
    if (typeof message.content === 'string') {
      normalizer.item(ref, '/message/content', human ? 'First human-recorded input' : 'Captured user input', message.content, options);
    } else blocks.forEach((value, index) => {
      const block = object(value);
      if (typeof block.text === 'string') normalizer.item(ref, '/message/content/' + index + '/text', 'Captured user input', block.text, options);
    });
    return;
  }
  if (type === 'system' && typeof record.subtype === 'string') {
    if (['compact_boundary', 'local_command', 'stop_hook_summary', 'turn_duration'].includes(record.subtype)) meta.disposition = 'event';
    return;
  }
  if (type !== 'attachment') return;
  const attachment = object(record.attachment);
  const attachmentType = string(attachment.type);
  if (attachmentType === 'instructions' && Array.isArray(attachment.files)) {
    meta.disposition = 'event';
    array(attachment.files).forEach((value, index) => {
      const file = object(value);
      const path = string(file.path);
      const memory = file.type === 'AutoMem' || /(?:^|[\\/])memory[\\/]|MEMORY\.md$/i.test(path ?? '');
      normalizer.item(ref, '/attachment/files/' + index + '/content', memory ? 'Captured memory' : 'Captured instruction file', file.content, {
        kind: memory ? 'memory' : 'instruction', origin: 'harness-injected', capturedPath: path,
        detail: 'Captured instructions.files content and path. Current file contents are not substituted; delivery and active inclusion remain separate.',
      });
    });
  } else if (attachmentType === 'prompt_snapshot' && (attachment.systemPrompt !== undefined || attachment.tools !== undefined)) {
    meta.disposition = 'metadata';
    normalizer.item(ref, '/attachment', 'Diagnostic prompt snapshot', '', {
      kind: 'snapshot', representation: 'diagnostic-snapshot', evidence: 'diagnostic-snapshot',
      basis: 'unknown',
      detail: 'Recorded diagnostic representation. Request association is unassigned; parentUuid/order alone is not a universal call identity. This does not add an injection.',
    });
    for (const key of ['systemPrompt', 'tools']) {
      if (attachment[key] !== undefined) normalizer.item(ref, '/attachment/' + pointerPart(key), 'Snapshot ' + key, attachment[key], {
        kind: key === 'tools' ? 'tool' : 'instruction', representation: 'diagnostic-snapshot', evidence: 'diagnostic-snapshot',
        basis: 'unknown', detail: 'Diagnostic snapshot field. Captured presence does not prove request delivery, eager loading, or active inclusion.',
      });
    }
  } else if (attachmentType === 'skill_listing' && (attachment.content !== undefined || Array.isArray(attachment.names))) {
    meta.disposition = 'event';
    normalizer.item(ref, '/attachment', 'Captured skill catalog', '', {
      kind: 'skill', origin: 'harness-injected', detail: 'Recorded skill_listing attachment. Catalog presence is not a skill read or active inclusion.',
    });
  } else if (attachmentType === 'deferred_tools_delta' && Array.isArray(attachment.addedNames)) {
    meta.disposition = 'event';
    normalizer.item(ref, '/attachment', 'Deferred tool listing delta', '', {
      kind: 'tool', origin: 'harness-injected', detail: 'Recorded tool-name listing/delta. Definitions, loading, and request inclusion require separate evidence.',
    });
  } else if (attachmentType === 'mcp_instructions_delta' && Array.isArray(attachment.addedBlocks)) {
    meta.disposition = 'event';
    normalizer.item(ref, '/attachment', 'MCP instruction delta', '', { origin: 'harness-injected' });
  } else if (metadataAttachments.has(attachmentType ?? '')) {
    meta.disposition = 'metadata';
  }
};
