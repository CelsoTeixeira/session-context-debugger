import { DatabaseSync } from 'node:sqlite';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DataError } from './source.js';
import { string } from './json.js';
import type { DatabaseRef, DatabaseView, T3Listing, T3Thread } from './types.js';

const columns = {
  projection_threads: ['thread_id', 'project_id', 'title', 'created_at', 'updated_at', 'archived_at', 'deleted_at'],
  projection_projects: ['project_id', 'title', 'workspace_root'],
  provider_session_runtime: ['thread_id', 'provider_name', 'provider_instance_id', 'resume_cursor_json'],
} as const;
type Table = keyof typeof columns;
type Row = Record<string, unknown>;
const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const rowText = (row: Row): string => JSON.stringify(row, null, 2);
const keyColumn = (table: Table): string => table === 'projection_projects' ? 'project_id' : 'thread_id';
const ttl = 10 * 60_000;

export class T3Catalog {
  readonly databasePath = resolve(homedir(), '.t3/userdata/state.sqlite');
  private refs = new Map<string, DatabaseRef>();
  private cursors = new Map<string, { updated: string; id: string; at: number }>();

  // Each operation uses one short read transaction. No persistent connection,
  // source copy, migrations, orchestration/message scans, or arbitrary SQL API.
  private async read<T>(fn: (db: DatabaseSync, path: string, generation: string) => T): Promise<T> {
    let db: DatabaseSync | undefined;
    try {
      const path = await realpath(this.databasePath);
      const info = await stat(path, { bigint: true });
      if (!info.isFile()) throw new DataError('unavailable-catalog', 'T3 catalog is not a regular file.');
      const generation = [info.dev, info.ino, info.birthtimeNs].join(':');
      db = new DatabaseSync(path, { readOnly: true });
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; BEGIN');
      for (const [table, required] of Object.entries(columns)) {
        const found = new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name));
        if (!required.every(column => found.has(column))) throw new DataError('unsupported-catalog', 'The installed T3 catalog schema is unsupported. Claude/Codex file views remain available.');
      }
      return fn(db, path, generation);
    } catch (error) {
      if (error instanceof DataError) throw error;
      throw new DataError('unavailable-catalog', 'Cannot read the local T3 catalog. It may be absent, busy, or unavailable. Try Refresh or select Claude/Codex.', 503);
    } finally { db?.close(); }
  }

  private capture(table: Table, row: Row, path: string, generation: string): DatabaseRef {
    const text = rowText(row);
    if (Buffer.byteLength(text) > 32 * 1024) throw new DataError('processing-limit', 'T3 metadata exceeds the 32 KiB evidence limit; this row cannot be resolved.', 413);
    const ref: DatabaseRef = { id: randomUUID(), databasePath: path, generation, table,
      key: String(row[keyColumn(table)]), columns: [...columns[table]], sha256: hash(text), inspectedAt: new Date().toISOString() };
    while (this.refs.size >= 200) this.refs.delete(this.refs.keys().next().value!);
    this.refs.set(ref.id, ref);
    return ref;
  }

  private row(db: DatabaseSync, table: Table, key: string): Row | undefined {
    const keyField = keyColumn(table);
    const size = db.prepare('SELECT ' + columns[table].map(column => 'coalesce(length(CAST(' + column + ' AS BLOB)), 0)').join(' + ') + ' bytes FROM ' + table + ' WHERE ' + keyField + ' = ?').get(key);
    if (Number(size?.bytes ?? 0) > 24 * 1024) throw new DataError('processing-limit', 'T3 row values exceed the bounded metadata limit; no binding was inferred.', 413);
    return db.prepare('SELECT ' + columns[table].join(', ') + ' FROM ' + table + ' WHERE ' + keyField + ' = ?').get(key);
  }

  private thread(row: Row): T3Thread {
    return { id: String(row.thread_id), title: String(row.title ?? 'Untitled thread').slice(0, 512),
      project: String(row.project_title ?? 'Unknown project').slice(0, 512), workspace: string(row.workspace_root)?.slice(0, 2048),
      provider: string(row.provider_name), updatedAt: String(row.updated_at), archived: row.archived_at != null };
  }

  async list(cursor?: string): Promise<T3Listing> {
    const page = cursor ? this.cursors.get(cursor) : undefined;
    if (cursor && (!page || Date.now() - page.at > ttl)) throw new DataError('invalid-cursor', 'T3 listing cursor expired; refresh the list.');
    return this.read((db, path) => {
      const rows = db.prepare(`SELECT t.thread_id, substr(t.title, 1, 512) title, t.updated_at, t.archived_at,
        substr(p.title, 1, 512) project_title, substr(p.workspace_root, 1, 2048) workspace_root, r.provider_name
        FROM projection_threads t LEFT JOIN projection_projects p ON p.project_id = t.project_id
        LEFT JOIN provider_session_runtime r ON r.thread_id = t.thread_id
        WHERE t.deleted_at IS NULL ${page ? 'AND (t.updated_at < ? OR (t.updated_at = ? AND t.thread_id < ?))' : ''}
        ORDER BY t.updated_at DESC, t.thread_id DESC LIMIT 51`).all(...(page ? [page.updated, page.updated, page.id] : []));
      const last = rows[49];
      let next: string | undefined;
      if (rows.length > 50 && last) {
        next = randomUUID();
        while (this.cursors.size >= 20) this.cursors.delete(this.cursors.keys().next().value!);
        this.cursors.set(next, { updated: String(last.updated_at), id: String(last.thread_id), at: Date.now() });
      }
      return { threads: rows.slice(0, 50).map(row => this.thread(row)), databasePath: path, cursor: next,
        warnings: ['Current non-deleted T3 threads, including archived threads. Pages are live reads, not an immutable catalog snapshot. Titles/workspaces use bounded display prefixes.'] };
    });
  }

  async binding(id: string): Promise<{ thread: T3Thread; refs: DatabaseRef[]; runtime?: Row }> {
    return this.read((db, path, generation) => {
      const row = this.row(db, 'projection_threads', id);
      if (!row || row.deleted_at != null) throw new DataError('unavailable-thread', 'T3 thread is unavailable or deleted. Refresh the catalog.', 404);
      const project = this.row(db, 'projection_projects', String(row.project_id));
      // These are current runtime cursors. projection_thread_sessions legacy ID
      // columns are not authoritative, and T3 message text is not a wire request.
      const runtime = this.row(db, 'provider_session_runtime', id);
      const refs = [this.capture('projection_threads', row, path, generation)];
      if (project) refs.push(this.capture('projection_projects', project, path, generation));
      if (runtime) refs.push(this.capture('provider_session_runtime', runtime, path, generation));
      return { thread: this.thread({ ...row, project_title: project?.title, workspace_root: project?.workspace_root, provider_name: runtime?.provider_name }), refs, runtime };
    });
  }

  async evidence(id: string): Promise<DatabaseView> {
    const ref = this.refs.get(id);
    if (!ref || Date.now() - Date.parse(ref.inspectedAt) > ttl) throw new DataError('stale-reference', 'T3 evidence expired or was evicted. Reselect the thread.', 409);
    return this.read((db, path, generation) => {
      if (path !== ref.databasePath || generation !== ref.generation) throw new DataError('stale-reference', 'T3 database identity changed. Refresh the catalog.', 409);
      const row = this.row(db, ref.table, ref.key);
      if (!row || hash(rowText(row)) !== ref.sha256) throw new DataError('stale-reference', 'The captured T3 row projection changed. Reselect the thread; current values are not substituted.', 409);
      return { ref, text: rowText(row), validated: true };
    });
  }
}
