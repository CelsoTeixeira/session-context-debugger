import { array, identifier as string, number, numericFields, object, stable } from './json.js';
import { MAX_ITEMS, PREVIEW_UNITS } from './scanner.js';
import type { EvidenceItem, ModelCall, RecordMeta, SourceFile, SourceRef, UsageValues } from './types.js';
import type { Obj } from './json.js';

export class Normalizer {
  readonly items: EvidenceItem[] = [];
  readonly calls = new Map<string, ModelCall>();
  readonly warnings = new Set<string>();
  limitedItems = 0;
  currentTurn?: string;
  constructor(readonly source: SourceFile) {}

  item(ref: SourceRef, pointer: string, label: string, value: unknown,
    options: Partial<Omit<EvidenceItem, 'id' | 'label' | 'preview' | 'previewLimited' | 'ref'>> = {}): void {
    if (this.items.length >= MAX_ITEMS) { this.limitedItems++; return; }
    // Do not stringify a large captured body merely to create an index preview.
    const content = typeof value === 'string' ? value : '';
    const preview = content.slice(0, PREVIEW_UNITS);
    this.items.push({
      id: ref.id + ':' + pointer, ref: { ...ref, pointer }, label, kind: 'instruction',
      origin: 'unknown', representation: 'primary', evidence: 'recorded-content',
      basis: 'explicit', detail: 'Captured content; request delivery and active inclusion are unknown.',
      preview, previewLimited: content.length > preview.length, ...options,
    });
  }
  call(ref: SourceRef, pointer: string, usage: Obj, identity: string | undefined,
    values: UsageValues, model?: string): void {
    if (this.calls.size >= 20_000) { this.warnings.add('Model-call index limit reached; usage coverage is incomplete.'); return; }
    const actor = this.source.actorId ?? this.source.id;
    const id = actor + ':' + (identity ?? 'unassigned:' + ref.line);
    const original = numericFields(usage);
    // Keep numeric iteration detail as well as top-level fields so differing
    // measurement scopes cannot silently collapse to an identical total.
    if (Array.isArray(usage.iterations)) {
      original.iterations = array(usage.iterations).map(item => numericFields(item));
    }
    const signature = stable(original);
    const existing = this.calls.get(id);
    const evidenceRef = { ...ref, pointer };
    if (existing) {
      const variant = existing.variants.find(item => stable(item.original) === signature);
      if (variant) {
        if (variant.refs.length < 500) variant.refs.push(evidenceRef);
        else this.warnings.add('Usage reference limit reached; all physical records remain in coverage.');
      } else {
        existing.status = 'ambiguous';
        if (existing.variants.length < 100) existing.variants.push({ values, original, refs: [evidenceRef] });
        else this.warnings.add('Usage variant limit reached; ambiguous observations excluded.');
      }
    } else {
      this.calls.set(id, {
        id, actorId: actor, identityBasis: identity ? 'explicit' : 'unknown',
        identityDetail: identity ? 'Recorded identity scoped to this source actor/thread.' : 'Missing recorded call identity; observation is unassigned.',
        model, scope: 'recorded-response; invocation-scope-unknown',
        status: identity ? 'resolved' : 'ambiguous', firstLine: ref.line,
        variants: [{ values, original, refs: [evidenceRef] }],
      });
    }
  }
  codexUsage(ref: SourceRef, payload: Obj, pointer: string): void {
    const usage = object(payload.usage);
    if (!Object.keys(usage).length) return;
    this.call(ref, pointer + '/usage', usage, string(payload.response_id), {
      input: number(usage.input_tokens), cached: number(usage.cached_input_tokens),
      cacheCreation: number(usage.cache_write_input_tokens), output: number(usage.output_tokens),
      reasoning: number(usage.reasoning_output_tokens),
    });
  }
  claudeUsage(ref: SourceRef, record: Obj): void {
    const message = object(record.message);
    const usage = object(message.usage);
    if (!Object.keys(usage).length) return;
    const input = number(usage.input_tokens);
    const creation = number(usage.cache_creation_input_tokens);
    const cached = number(usage.cache_read_input_tokens);
    const requestId = string(record.requestId);
    const messageId = string(message.id);
    const actor = string(record.agentId) ?? string(record.sessionId) ?? this.source.actorId;
    this.call(ref, '/message/usage', usage,
      requestId && messageId ? stable([actor, requestId, messageId]) : undefined, {
        input: input !== null && creation !== null && cached !== null ? input + creation + cached : null,
        cached, cacheCreation: creation, output: number(usage.output_tokens),
        reasoning: number(object(usage.output_tokens_details).thinking_tokens),
      }, string(message.model));
  }
  sectionItems(ref: SourceRef, pointer: string, value: string): void {
    const sections: Array<[RegExp, EvidenceItem['kind'], string]> = [
      [/(?:^|\n)#{1,3}\s+(?:Memory|memory_summary)\b|<memory_summary>/i, 'memory', 'Memory guidance/catalog in captured instructions'],
      [/(?:^|\n)#{1,3}\s+(?:Available )?Skills\b|<skills_instructions>/i, 'skill', 'Skill catalog in captured instructions'],
      [/(?:^|\n)#{1,3}\s+(?:Tools|Apps|Plugins)\b/i, 'tool', 'Tool/app catalog in captured instructions'],
    ];
    for (const [pattern, kind, label] of sections) {
      if (pattern.test(value)) this.item(ref, pointer, label, '', {
        kind, origin: 'harness-injected', basis: 'inferred',
        detail: 'Section-heading match in captured instructions. Inspect the referenced text; mention/catalog is not proof of loading.',
      });
    }
  }
}

export const codexTypes = new Set(['message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'reasoning', 'web_search_call', 'local_shell_call', 'compaction']);
export type Adapter = (record: Obj, meta: RecordMeta, normalizer: Normalizer) => void;
