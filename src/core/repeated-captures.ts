import { createHash } from 'node:crypto';
import { timelineCategory } from './timeline-category.js';
import { DataError } from './source.js';
import { MAX_RETAINED_TIMELINE_EVENTS } from './types.js';
import type { CaptureMeasurements } from './payload-size.js';
import type { RepeatedCaptureGroup, RepeatedCaptureOccurrence, RepeatedCaptureScope, TimelineCategory, TimelineEvent } from './types.js';

interface Candidate {
  group: Omit<RepeatedCaptureGroup, 'occurrenceCount' | 'retainedOccurrences' | 'omittedOccurrences' | 'retainedEncodedBytes'>;
  first: RepeatedCaptureOccurrence;
  additional: RepeatedCaptureOccurrence[];
  occurrenceCount: number;
  omittedOccurrences: number;
}
export interface RepeatedCaptureGroupPage {
  groups: RepeatedCaptureGroup[];
  after?: number;
  total: number;
}
export interface RepeatedCaptureOccurrencePage {
  group: RepeatedCaptureGroup;
  occurrences: RepeatedCaptureOccurrence[];
  after?: number;
  total: number;
}

export class RepeatedCaptures {
  private readonly candidates = new Map<string, Candidate>();
  private metadataEntries = 0;
  private finished = false;
  private examinedUniqueFields = 0;
  private eligibleFields = 0;
  private aliasesExcluded = 0;
  private overlapFieldsExcluded = 0;
  private unresolvedFields = 0;
  private omittedByMetadataLimit = 0;

  capture(measurements: CaptureMeasurements, scope: RepeatedCaptureScope): void {
    if (this.finished) return;
    this.examinedUniqueFields += measurements.examinedUniqueFields;
    this.eligibleFields += measurements.eligibleFields;
    this.aliasesExcluded += measurements.aliasesExcluded;
    this.overlapFieldsExcluded += measurements.overlapFieldsExcluded;
    this.unresolvedFields += measurements.unresolvedFields;
    for (const field of measurements.fields) {
      const event = field.event;
      const category = timelineCategory(event);
      const key = JSON.stringify([event.ref.sourceId, scope.kind, scope.id ?? null, event.representation,
        category, event.kind, event.role ?? null, field.sha256, field.bytes]);
      const id = 'rc_' + createHash('sha256').update(key, 'utf8').digest('hex');
      const existing = this.candidates.get(id);
      if (existing) {
        existing.occurrenceCount++;
        if (this.metadataEntries < MAX_RETAINED_TIMELINE_EVENTS) {
          existing.additional.push(this.occurrence(event));
          this.metadataEntries++;
        } else {
          existing.omittedOccurrences++;
          this.omittedByMetadataLimit++;
        }
        continue;
      }
      if (this.metadataEntries >= MAX_RETAINED_TIMELINE_EVENTS) {
        this.omittedByMetadataLimit++;
        continue;
      }
      const group: Candidate['group'] = {
        id, category, representation: event.representation, kind: event.kind,
        ...(event.role === undefined ? {} : { role: event.role }),
        scope: { ...scope }, firstLine: event.ref.line, bytesPerCopy: field.bytes,
      };
      this.candidates.set(id, { group, first: this.occurrence(event), additional: [], occurrenceCount: 1, omittedOccurrences: 0 });
      this.metadataEntries++;
    }
  }

  finish(): void {
    if (this.finished) return;
    for (const [id, candidate] of this.candidates) {
      if (candidate.occurrenceCount > 1) continue;
      this.candidates.delete(id);
      this.metadataEntries--;
    }
    this.finished = true;
  }

  summary() {
    let retainedOccurrences = 0;
    let omittedOccurrences = 0;
    let repeatedGroups = 0;
    for (const candidate of this.candidates.values()) {
      if (candidate.occurrenceCount < 2) continue;
      repeatedGroups++;
      retainedOccurrences += 1 + candidate.additional.length;
      omittedOccurrences += candidate.omittedOccurrences;
    }
    return {
      examinedUniqueFields: this.examinedUniqueFields,
      eligibleFields: this.eligibleFields,
      aliasesExcluded: this.aliasesExcluded,
      overlapFieldsExcluded: this.overlapFieldsExcluded,
      unresolvedFields: this.unresolvedFields,
      omittedByMetadataLimit: this.omittedByMetadataLimit,
      candidateMetadata: this.metadataEntries,
      candidateMetadataLimit: MAX_RETAINED_TIMELINE_EVENTS,
      repeatedGroups,
      retainedOccurrences,
      omittedOccurrences,
    };
  }

  page(after: number, representation: 'all' | TimelineEvent['representation'], category: 'all' | TimelineCategory): RepeatedCaptureGroupPage {
    const groups = [...this.candidates.values()]
      .filter(candidate => candidate.occurrenceCount > 1
        && (representation === 'all' || candidate.group.representation === representation)
        && (category === 'all' || candidate.group.category === category))
      .sort((left, right) => left.group.firstLine - right.group.firstLine || left.group.id.localeCompare(right.group.id));
    const selected = groups.slice(after, after + 50);
    const end = after + selected.length;
    return { groups: selected.map(candidate => this.groupView(candidate)), total: groups.length,
      after: end < groups.length ? end : undefined };
  }

  occurrences(groupId: string, after: number): RepeatedCaptureOccurrencePage {
    const candidate = this.candidates.get(groupId);
    if (!candidate || candidate.occurrenceCount < 2) throw new DataError('unavailable-group', 'Repeated-capture group is unavailable.', 404);
    const all = [candidate.first, ...candidate.additional];
    if (after > all.length) throw new DataError('invalid-cursor', 'Invalid repeated-capture occurrence cursor.');
    const selected = all.slice(after, after + 50);
    const end = after + selected.length;
    return { group: this.groupView(candidate), occurrences: selected.map(occurrence => ({
      ref: { ...occurrence.ref }, ...(occurrence.target ? { target: { ...occurrence.target } } : {}),
    })), total: all.length, after: end < all.length ? end : undefined };
  }

  private occurrence(event: TimelineEvent): RepeatedCaptureOccurrence {
    return { ref: { ...event.ref }, target: { id: event.id, position: event.position } };
  }

  private groupView(candidate: Candidate): RepeatedCaptureGroup {
    const retainedOccurrences = 1 + candidate.additional.length;
    return { ...candidate.group, scope: { ...candidate.group.scope },
      occurrenceCount: candidate.occurrenceCount, retainedOccurrences,
      omittedOccurrences: candidate.omittedOccurrences,
      retainedEncodedBytes: candidate.group.bytesPerCopy * retainedOccurrences };
  }
}
