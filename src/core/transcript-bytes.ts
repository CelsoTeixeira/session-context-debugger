import type { CoverageLedger, Overview, RecordMeta, TranscriptBytesPage, TranscriptBytesPoint } from './types.js';

export const MAX_TRANSCRIPT_BYTES_POINTS = 200;

export function createTranscriptBytesPage(
  records: readonly RecordMeta[],
  after: number,
  sourceSnapshotBytes: number,
  scannedBytes: number,
  state: Overview['state'],
  coverage: CoverageLedger,
  firstEventTarget: (refId: string) => { id: string; position: number } | undefined,
): TranscriptBytesPage {
  const retainedPhysicalBytes = records.reduce((total, record) => total + record.ref.byteLength + record.ref.delimiterLength, 0);
  const pendingRecords = coverage.dispositions.pending;
  const pendingBytes = coverage.pendingBytes;
  const unretainedRecords = Math.max(0, coverage.completeLines + pendingRecords - records.length);
  const end = Math.min(records.length, after + MAX_TRANSCRIPT_BYTES_POINTS);
  const points: TranscriptBytesPoint[] = records.slice(after, end).map((record, index) => ({
    id: record.ref.id,
    ordinal: after + index + 1,
    ref: record.ref,
    disposition: record.disposition,
    contentBytes: record.ref.byteLength,
    delimiterBytes: record.ref.delimiterLength,
    physicalBytes: record.ref.byteLength + record.ref.delimiterLength,
    cumulativePhysicalBytes: record.ref.offset + record.ref.byteLength + record.ref.delimiterLength,
    firstEventTarget: firstEventTarget(record.ref.id),
  }));
  return {
    points,
    before: after > 0 ? Math.max(0, after - MAX_TRANSCRIPT_BYTES_POINTS) : undefined,
    after: end < records.length ? end : undefined,
    total: records.length,
    pageLimit: MAX_TRANSCRIPT_BYTES_POINTS,
    coverage: {
      sourceSnapshotBytes,
      scannedBytes,
      scanState: state,
      retainedRecords: records.length,
      retainedPhysicalBytes,
      pendingBytes,
      pendingRecords,
      unretainedRecords,
      physicalCoverageComplete: state === 'ready' && scannedBytes === sourceSnapshotBytes
        && unretainedRecords === 0 && retainedPhysicalBytes === sourceSnapshotBytes,
      unknownRecords: coverage.dispositions.unknown,
      malformedRecords: coverage.dispositions.malformed,
      limitedRecords: coverage.dispositions.limited,
    },
  };
}
