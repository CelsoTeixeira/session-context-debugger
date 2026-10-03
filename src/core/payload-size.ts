import type { Obj } from './json.js';
import type { TimelineEvent } from './types.js';

// Measure the selected captured fields, not previews or reconstructed requests.
// Parents retain only bytes not assigned to a nested captured field. Physical
// copies in other records remain separate; no equality-based deduplication.
export function measureCaptures(record: Obj | undefined, events: TimelineEvent[]): void {
  if (!record) return;
  const fields = new Map<string, { event: TimelineEvent; bytes: number; allocated: number }>();
  for (const event of events) {
    const pointer = event.ref.pointer ?? '';
    let value: unknown = record;
    for (const part of pointer ? pointer.slice(1).split('/') : []) {
      const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
      value = value && typeof value === 'object' && Object.hasOwn(value, key) ? (value as Obj)[key] : undefined;
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) continue;
    const bytes = Buffer.byteLength(encoded, 'utf8');
    event.serializedBytes = bytes;
    event.allocatedBytes = 0;
    if (!fields.has(pointer)) fields.set(pointer, { event, bytes, allocated: bytes });
  }
  for (const [pointer, field] of fields) {
    if (!pointer) continue;
    let parent = pointer;
    while (parent) {
      parent = parent.slice(0, parent.lastIndexOf('/'));
      const ancestor = fields.get(parent);
      if (ancestor) { ancestor.allocated -= field.bytes; break; }
    }
  }
  for (const field of fields.values()) field.event.allocatedBytes = field.allocated;
}
