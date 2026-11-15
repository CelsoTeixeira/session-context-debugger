import { createHash } from 'node:crypto';
import type { Obj } from './json.js';
import type { TimelineEvent } from './types.js';

export interface MeasuredCaptureField {
  event: TimelineEvent;
  pointer: string;
  bytes: number;
  sha256: string;
}
export interface CaptureMeasurements {
  fields: MeasuredCaptureField[];
  examinedUniqueFields: number;
  eligibleFields: number;
  aliasesExcluded: number;
  overlapFieldsExcluded: number;
  unresolvedFields: number;
}

interface PointerNode {
  pointer?: string;
  children: Map<string, PointerNode>;
  containsSelected?: boolean;
}
interface SelectedPointer { pointer: string; events: TimelineEvent[] }

function pointerParts(pointer: string): string[] {
  return pointer ? pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~')) : [];
}

function overlappingPointers(selected: Iterable<SelectedPointer>): Set<string> {
  const root: PointerNode = { children: new Map() };
  for (const { pointer } of selected) {
    let node = root;
    for (const part of pointerParts(pointer)) {
      let child = node.children.get(part);
      if (!child) { child = { children: new Map() }; node.children.set(part, child); }
      node = child;
    }
    node.pointer = pointer;
  }
  const containsSelected = (node: PointerNode): boolean => {
    if (node.containsSelected !== undefined) return node.containsSelected;
    node.containsSelected = node.pointer !== undefined || [...node.children.values()].some(containsSelected);
    return node.containsSelected;
  };
  const result = new Set<string>();
  const mark = (node: PointerNode, selectedAncestor: boolean): void => {
    const ownSelected = node.pointer !== undefined;
    const hasSelectedDescendant = [...node.children.values()].some(containsSelected);
    if (ownSelected && (selectedAncestor || hasSelectedDescendant)) result.add(node.pointer!);
    for (const child of node.children.values()) mark(child, selectedAncestor || ownSelected);
  };
  mark(root, false);
  return result;
}

// Measure the exact fields Timeline selected. Parents retain only bytes not
// assigned to a nested captured field; physical copies remain independent.
// Comparison fingerprints are transient facts for the repeated-capture index.
export function measureCaptures(record: Obj | undefined, events: TimelineEvent[]): CaptureMeasurements {
  const selected = new Map<string, SelectedPointer>();
  for (const event of events) {
    const pointer = event.ref.pointer ?? '';
    const bucket = selected.get(pointer) ?? { pointer, events: [] };
    bucket.events.push(event);
    selected.set(pointer, bucket);
  }
  const overlaps = overlappingPointers(selected.values());
  const aliasesExcluded = [...selected.values()].reduce((sum, field) => sum + field.events.length - 1, 0);
  const result: CaptureMeasurements = {
    fields: [], examinedUniqueFields: selected.size, eligibleFields: 0,
    aliasesExcluded, overlapFieldsExcluded: overlaps.size, unresolvedFields: 0,
  };
  if (!record) {
    result.unresolvedFields = selected.size;
    return result;
  }

  const fields = new Map<string, { event: TimelineEvent; bytes: number; allocated: number }>();
  for (const event of events) {
    const pointer = event.ref.pointer ?? '';
    let value: unknown = record;
    for (const part of pointerParts(pointer)) {
      value = value && typeof value === 'object' && Object.hasOwn(value, part) ? (value as Obj)[part] : undefined;
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) continue;
    const bytes = Buffer.byteLength(encoded, 'utf8');
    event.serializedBytes = bytes;
    event.allocatedBytes = 0;
    if (!fields.has(pointer)) {
      fields.set(pointer, { event, bytes, allocated: bytes });
      if (!overlaps.has(pointer)) result.fields.push({ event, pointer, bytes,
        sha256: createHash('sha256').update(encoded, 'utf8').digest('hex') });
    }
  }

  for (const { pointer } of selected.values()) if (!fields.has(pointer)) result.unresolvedFields++;
  result.eligibleFields = result.fields.length;

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
  return result;
}
