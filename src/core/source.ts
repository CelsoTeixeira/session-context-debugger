import { opendir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Candidate, Family, SourceListing } from './types.js';

export class DataError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new DataError('cancelled', 'Operation cancelled.', 409);
};
export const within = (root: string, path: string): boolean => {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
};

export class Sources {
  readonly candidates = new Map<string, Candidate>();
  private roots: string[] = [];
  private listings = new Map<string, { items: Candidate[]; complete: boolean; warnings: string[]; inspected: number; at: number }>();

  constructor(private configuredRoots = [
    resolve(homedir(), '.codex/sessions'),
    resolve(homedir(), '.codex/archived_sessions'),
    resolve(homedir(), '.claude/projects'),
  ]) {}
  async initialize(): Promise<void> {
    for (const root of this.configuredRoots) {
      try { if ((await stat(root)).isDirectory()) this.roots.push(await realpath(root)); }
      catch { /* Missing default roots are permitted. */ }
    }
  }
  allowedRoots(): string[] { return [...this.roots]; }
  async resolve(path: string): Promise<{ path: string; family: Family }> {
    if (!isAbsolute(path) || !path.toLowerCase().endsWith('.jsonl')) {
      throw new DataError('unsupported-path', 'Choose an absolute path to a JSONL session file.');
    }
    let resolved: string;
    try { resolved = await realpath(path); }
    catch { throw new DataError('unavailable-source', 'The source file is unavailable.', 404); }
    if (!this.roots.some(root => within(root, resolved))) {
      throw new DataError('unsupported-path', 'The resolved file is outside the allowed roots.', 403);
    }
    if (!(await stat(resolved)).isFile()) throw new DataError('unsupported-path', 'Source must be a regular file.');
    return { path: resolved, family: this.family(resolved) };
  }
  family(path: string): Family {
    const normalized = path.replaceAll('\\', '/').toLowerCase();
    return normalized.includes('/.codex/') ? 'codex' : normalized.includes('/.claude/') ? 'claude' : 'unknown';
  }
  async list(cursor?: string, signal?: AbortSignal): Promise<SourceListing> {
    abortIfNeeded(signal);
    let key: string;
    let start = 0;
    if (cursor) {
      const parts = cursor.split(':');
      key = parts[0] ?? '';
      start = Number(parts[1]);
      if (!this.listings.has(key) || !Number.isSafeInteger(start) || start < 0) {
        throw new DataError('invalid-cursor', 'Source listing expired; rescan the list.');
      }
    } else {
      key = randomUUID();
      const items: Candidate[] = [];
      const warnings: string[] = [];
      const queue = [...this.roots];
      const started = Date.now();
      let inspected = 0;
      let inspectedDirectories = 0;
      let complete = true;
      outer: while (queue.length) {
        abortIfNeeded(signal);
        if (Date.now() - started > 4000 || inspectedDirectories++ >= 20000) { complete = false; break; }
        const dirPath = queue.shift()!;
        let dir;
        try {
          const actual = await realpath(dirPath);
          if (!this.roots.some(root => within(root, actual))) { warnings.push('Skipped a directory outside the resolved roots.'); continue; }
          dir = await opendir(actual);
        }
        catch { warnings.push('Could not enumerate ' + dirPath); continue; }
        for await (const entry of dir) {
          abortIfNeeded(signal);
          if (Date.now() - started > 4000 || inspected >= 20000) { complete = false; break outer; }
          const path = resolve(dirPath, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) queue.push(path);
          else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            inspected++;
            try {
              const info = await stat(path);
              items.push({ id: randomUUID(), path, family: this.family(path), bytes: info.size, modifiedAt: info.mtime.toISOString() });
            } catch { warnings.push('A candidate disappeared while listing.'); }
          }
        }
      }
      items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
      if (!complete) warnings.push('Stat scan stopped at its time/file limit. Ordering is recent within the inspected candidates.');
      this.candidates.clear();
      this.listings.clear();
      for (const item of items) this.candidates.set(item.id, item);
      this.listings.set(key, { items, complete, warnings, inspected, at: Date.now() });
    }
    const listing = this.listings.get(key)!;
    if (Date.now() - listing.at > 10 * 60_000) throw new DataError('invalid-cursor', 'Source listing expired; rescan the list.');
    const end = start + 50;
    return {
      candidates: listing.items.slice(start, end),
      cursor: end < listing.items.length ? key + ':' + end : undefined,
      inspectedFiles: listing.inspected,
      complete: listing.complete,
      warnings: listing.warnings,
    };
  }
}
