import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { SourceFile, SourceRef } from './types.js';
import { abortIfNeeded, DataError } from './source.js';

export const PARSE_BYTES = 8 * 1024 * 1024;
export const MAX_RECORDS = 100_000;
export const MAX_ITEMS = 3000;
export const PREVIEW_UNITS = 768;
export interface ScannedRecord { ref: SourceRef; bytes?: Buffer; pending: boolean }

export async function scan(
  source: SourceFile,
  onRecord: (record: ScannedRecord) => void,
  onProgress: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const handle = await open(source.resolvedPath, 'r');
  const prefixHash = createHash('sha256');
  let lineHash = createHash('sha256');
  let lineOffset = 0;
  let lineLength = 0;
  let line = 1;
  let lastByte: number | undefined;
  let parts: Buffer[] = [];
  let capturedLength = 0;
  let position = 0;
  const append = (part: Buffer): void => {
    if (!part.length) return;
    if (lastByte !== undefined) lineHash.update(Buffer.from([lastByte]));
    if (part.length > 1) lineHash.update(part.subarray(0, -1));
    lastByte = part[part.length - 1];
    lineLength += part.length;
    if (capturedLength <= PARSE_BYTES) {
      const capture = part.subarray(0, Math.max(0, PARSE_BYTES + 1 - capturedLength));
      parts.push(Buffer.from(capture));
      capturedLength += capture.length;
    }
  };
  const finish = (pending: boolean): void => {
    const crlf = !pending && lastByte === 13;
    if (lastByte !== undefined && !crlf) lineHash.update(Buffer.from([lastByte]));
    const byteLength = lineLength - (crlf ? 1 : 0);
    const ref: SourceRef = {
      id: 'r' + line, sourceId: source.id, generation: source.generation, line,
      offset: lineOffset, byteLength, delimiterLength: pending ? 0 : crlf ? 2 : 1,
      sha256: lineHash.digest('hex'),
    };
    const bytes = byteLength <= PARSE_BYTES ? Buffer.concat(parts).subarray(0, byteLength) : undefined;
    onRecord({ ref, bytes, pending });
    lineOffset += lineLength + (pending ? 0 : 1);
    line++;
    lineHash = createHash('sha256');
    lineLength = capturedLength = 0;
    lastByte = undefined;
    parts = [];
  };
  try {
    while (position < source.size) {
      abortIfNeeded(signal);
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, source.size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) throw new DataError('stale-reference', 'Source was truncated during indexing.', 409);
      const chunk = buffer.subarray(0, bytesRead);
      prefixHash.update(chunk);
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(10, start);
        if (newline < 0) { append(chunk.subarray(start)); break; }
        append(chunk.subarray(start, newline));
        finish(false);
        start = newline + 1;
      }
      position += bytesRead;
      onProgress(position);
    }
    if (lineLength) finish(true);
    const after = await handle.stat();
    if (after.size < source.size) throw new DataError('stale-reference', 'Source was truncated during indexing.', 409);
    return prefixHash.digest('hex');
  } finally { await handle.close(); }
}
