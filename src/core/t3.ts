import { DatabaseSync } from 'node:sqlite';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DataError } from './source.js';
import { string } from './json.js';
import type { DatabaseRef, DatabaseView, T3Listing, T3Thread } from './types.js';

const threadTable = 'orchestration_v2_projection_threads';
const projectTable = 'projection_projects';
const providerThreadTable = 'orchestration_v2_projection_provider_threads';
const sessionBindingTable = 'orchestration_v2_projection_provider_session_bindings';

const schemaColumns = {
  [threadTable]: ['thread_id', 'project_id', 'title', 'default_provider', 'active_provider_thread_id', 'created_at', 'updated_at', 'archived_at', 'deleted_at', 'provider_instance_id'],
  [projectTable]: ['project_id', 'title', 'workspace_root'],
  [providerThreadTable]: ['provider_thread_id', 'thread_id', 'provider', 'driver', 'provider_instance_id', 'provider_session_id', 'payload_json'],
  [sessionBindingTable]: ['provider_session_id', 'thread_id'],
} as const;
type Table = keyof typeof schemaColumns;
type Row = Record<string, unknown>;
type LinkBindingSnapshot = {
  threadId: string;
  activeProviderThreadId: string;
  providerInstanceId: string;
  deletedAt: unknown;
};

const evidenceColumns: Record<Table, string[]> = {
  [threadTable]: [...schemaColumns[threadTable]],
  [projectTable]: [...schemaColumns[projectTable]],
  [providerThreadTable]: [
    'provider_thread_id', 'thread_id', 'provider', 'driver', 'provider_instance_id', 'provider_session_id',
    'payload_json_bytes (computed)', 'payload_json_valid (bounded computed)',
    'native_id_type (computed from payload_json.nativeThreadRef.nativeId)',
    'native_id_bytes (computed from payload_json.nativeThreadRef.nativeId)',
    'payload_json.nativeThreadRef.nativeId (bounded computed JSON leaf)',
  ],
  [sessionBindingTable]: [...schemaColumns[sessionBindingTable]],
};

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const rowText = (row: Row): string => JSON.stringify(row, null, 2);
const ttl = 10 * 60_000;
const maxRowBytes = 24 * 1024;
const maxEvidenceBytes = 32 * 1024;
const maxProviderPayloadBytes = 24 * 1024;
const maxNativeIdBytes = 512;
const maxReferenceKeyBytes = 4096;

export class T3Catalog {
  readonly databasePath = resolve(homedir(), '.t3/userdata/statev2.sqlite');
  private refs = new Map<string, DatabaseRef>();
  private linkBindings = new Map<string, LinkBindingSnapshot>();
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
      for (const [table, required] of Object.entries(schemaColumns)) {
        const found = new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name));
        if (!required.every(column => found.has(column))) {
          throw new DataError('unsupported-catalog', 'The installed T3 v2 catalog schema is unsupported. Claude/Codex file views remain available.');
        }
      }
      return fn(db, path, generation);
    } catch (error) {
      if (error instanceof DataError) throw error;
      throw new DataError('unavailable-catalog', 'Cannot read the local T3 catalog. It may be absent, busy, or unavailable. Try Refresh or select Claude/Codex.', 503);
    } finally { db?.close(); }
  }

  private checkSize(bytes: number, message: string): void {
    if (bytes > maxRowBytes) throw new DataError('processing-limit', message, 413);
  }

  private row(db: DatabaseSync, table: Table, key: string): Row | undefined {
    if (table === providerThreadTable) return this.providerThread(db, key);
    if (table === sessionBindingTable) {
      const [sessionId, threadId] = this.bindingKey(key);
      return this.sessionBinding(db, sessionId, threadId);
    }

    const keyColumn = table === projectTable ? 'project_id' : 'thread_id';
    const selected = schemaColumns[table];
    const size = db.prepare(
      'SELECT ' + selected.map(column => 'coalesce(length(CAST(' + column + ' AS BLOB)), 0)').join(' + ') +
      ' bytes FROM ' + table + ' WHERE ' + keyColumn + ' = ?',
    ).get(key);
    this.checkSize(Number(size?.bytes ?? 0), 'T3 row values exceed the bounded metadata limit; no binding was inferred.');
    return db.prepare('SELECT ' + selected.join(', ') + ' FROM ' + table + ' WHERE ' + keyColumn + ' = ?').get(key);
  }

  private providerThread(db: DatabaseSync, providerThreadId: string): Row | undefined {
    const metadataColumns = ['provider_thread_id', 'thread_id', 'provider', 'driver', 'provider_instance_id', 'provider_session_id'];
    const size = db.prepare(
      'SELECT ' + metadataColumns.map(column => 'coalesce(length(CAST(' + column + ' AS BLOB)), 0)').join(' + ') +
      ' bytes FROM ' + providerThreadTable + ' WHERE provider_thread_id = ?',
    ).get(providerThreadId);
    this.checkSize(Number(size?.bytes ?? 0), 'T3 provider-thread metadata exceeds the bounded limit; no binding was inferred.');

    const leaf = '$.nativeThreadRef.nativeId';
    return db.prepare(
      'WITH bounded AS (' +
        'SELECT provider_thread_id, thread_id, provider, driver, provider_instance_id, provider_session_id, ' +
          'coalesce(length(CAST(payload_json AS BLOB)), 0) AS payload_json_bytes, ' +
          'CASE WHEN coalesce(length(CAST(payload_json AS BLOB)), 0) <= ? ' +
            'THEN CASE WHEN json_valid(payload_json) THEN 1 ELSE 0 END ELSE NULL END AS payload_json_valid, ' +
          'payload_json FROM ' + providerThreadTable + ' WHERE provider_thread_id = ?' +
      '), typed AS (' +
        'SELECT provider_thread_id, thread_id, provider, driver, provider_instance_id, provider_session_id, ' +
          'payload_json_bytes, payload_json_valid, payload_json, ' +
          'CASE WHEN payload_json_valid = 1 THEN json_type(payload_json, ?) END AS native_id_type ' +
        'FROM bounded' +
      ') ' +
      'SELECT provider_thread_id, thread_id, provider, driver, provider_instance_id, provider_session_id, ' +
        'payload_json_bytes, payload_json_valid, native_id_type, ' +
        'CASE WHEN native_id_type = \'text\' THEN length(CAST(json_extract(payload_json, ?) AS BLOB)) END AS native_id_bytes, ' +
        'CASE WHEN native_id_type = \'text\' AND length(CAST(json_extract(payload_json, ?) AS BLOB)) <= ? ' +
          'THEN json_extract(payload_json, ?) END AS "payload_json.nativeThreadRef.nativeId" ' +
      'FROM typed',
    ).get(maxProviderPayloadBytes, providerThreadId, leaf, leaf, leaf, maxNativeIdBytes, leaf);
  }

  private sessionBinding(db: DatabaseSync, sessionId: string, threadId: string): Row | undefined {
    this.checkSize(Buffer.byteLength(sessionId, 'utf8') + Buffer.byteLength(threadId, 'utf8'),
      'T3 provider-session binding key exceeds the bounded metadata limit.');
    return db.prepare(
      'SELECT provider_session_id, thread_id FROM ' + sessionBindingTable +
      ' WHERE provider_session_id = ? AND thread_id = ?',
    ).get(sessionId, threadId);
  }

  private bindingKey(key: string): [string, string] {
    if (Buffer.byteLength(key, 'utf8') > maxReferenceKeyBytes) {
      throw new DataError('stale-reference', 'T3 binding evidence key is invalid or oversized.', 409);
    }
    try {
      const value: unknown = JSON.parse(key);
      if (Array.isArray(value) && value.length === 2 &&
        typeof value[0] === 'string' && typeof value[1] === 'string' &&
        Buffer.byteLength(value[0], 'utf8') <= maxReferenceKeyBytes &&
        Buffer.byteLength(value[1], 'utf8') <= maxReferenceKeyBytes) return [value[0], value[1]];
    } catch { /* Invalid evidence keys are stale, not SQL parameters. */ }
    throw new DataError('stale-reference', 'T3 binding evidence key is invalid or oversized.', 409);
  }

  private capture(table: Table, row: Row, path: string, generation: string): DatabaseRef {
    const text = rowText(row);
    if (Buffer.byteLength(text, 'utf8') > maxEvidenceBytes) {
      throw new DataError('processing-limit', 'T3 metadata exceeds the 32 KiB evidence limit; this row cannot be resolved.', 413);
    }
    let key: string;
    if (table === sessionBindingTable) {
      const sessionId = string(row.provider_session_id);
      const threadId = string(row.thread_id);
      if (sessionId === undefined || threadId === undefined) {
        throw new DataError('unsupported-catalog', 'The T3 provider-session binding key is unsupported.');
      }
      key = JSON.stringify([sessionId, threadId]);
    } else {
      const keyColumn = table === projectTable ? 'project_id'
        : table === providerThreadTable ? 'provider_thread_id' : 'thread_id';
      const value = string(row[keyColumn]);
      if (value === undefined) throw new DataError('unsupported-catalog', 'The T3 catalog row key is unsupported.');
      key = value;
    }
    if (Buffer.byteLength(key, 'utf8') > maxReferenceKeyBytes) {
      throw new DataError('processing-limit', 'T3 evidence key exceeds the bounded metadata limit.', 413);
    }
    const ref: DatabaseRef = {
      id: randomUUID(), databasePath: path, generation, table, key,
      columns: [...evidenceColumns[table]], sha256: hash(text), inspectedAt: new Date().toISOString(),
    };
    if (table === providerThreadTable) ref.pointer = '/nativeThreadRef/nativeId';
    while (this.refs.size >= 200) {
      const oldest = this.refs.keys().next().value!;
      this.refs.delete(oldest);
      this.linkBindings.delete(oldest);
    }
    this.refs.set(ref.id, ref);
    return ref;
  }

  private thread(row: Row): T3Thread {
    return {
      id: String(row.thread_id),
      title: String(row.title ?? 'Untitled thread').slice(0, 512),
      project: String(row.project_title ?? 'Unknown project').slice(0, 512),
      workspace: string(row.workspace_root)?.slice(0, 2048),
      provider: string(row.provider_name) ?? string(row.default_provider),
      updatedAt: String(row.updated_at),
      archived: row.archived_at != null,
    };
  }

  async list(cursor?: string): Promise<T3Listing> {
    const page = cursor ? this.cursors.get(cursor) : undefined;
    if (cursor && (!page || Date.now() - page.at > ttl)) throw new DataError('invalid-cursor', 'T3 listing cursor expired; refresh the list.');
    return this.read((db, path) => {
      const rows = db.prepare(
        'SELECT t.thread_id, substr(t.title, 1, 512) title, t.updated_at, t.archived_at, ' +
          'substr(p.title, 1, 512) project_title, substr(p.workspace_root, 1, 2048) workspace_root, ' +
          'coalesce(a.provider, t.default_provider) provider_name ' +
        'FROM ' + threadTable + ' t LEFT JOIN ' + projectTable + ' p ON p.project_id = t.project_id ' +
        'LEFT JOIN ' + providerThreadTable + ' a ON a.provider_thread_id = t.active_provider_thread_id ' +
          'AND a.thread_id = t.thread_id AND a.provider = a.driver ' +
          'AND t.provider_instance_id IS NOT NULL AND a.provider_instance_id = t.provider_instance_id ' +
          'AND a.provider_session_id IS NOT NULL AND EXISTS (' +
            'SELECT 1 FROM ' + sessionBindingTable + ' b ' +
            'WHERE b.provider_session_id = a.provider_session_id AND b.thread_id = t.thread_id) ' +
        'WHERE t.deleted_at IS NULL ' +
          (page ? 'AND (t.updated_at < ? OR (t.updated_at = ? AND t.thread_id < ?)) ' : '') +
        'ORDER BY t.updated_at DESC, t.thread_id DESC LIMIT 51',
      ).all(...(page ? [page.updated, page.updated, page.id] : []));
      const last = rows[49];
      let next: string | undefined;
      if (rows.length > 50 && last) {
        next = randomUUID();
        while (this.cursors.size >= 20) this.cursors.delete(this.cursors.keys().next().value!);
        this.cursors.set(next, { updated: String(last.updated_at), id: String(last.thread_id), at: Date.now() });
      }
      return {
        threads: rows.slice(0, 50).map(row => this.thread(row)),
        databasePath: path,
        cursor: next,
        warnings: ['Current non-deleted T3 threads, including archived threads. Pages are live reads, not an immutable catalog snapshot. Titles/workspaces use bounded display prefixes. A displayed default provider is a preference when no active provider binding is available.'],
      };
    });
  }

  async binding(id: string): Promise<{ thread: T3Thread; refs: DatabaseRef[]; providerThread?: Row; bindingIssue?: string }> {
    return this.read((db, path, generation) => {
      const threadRow = this.row(db, threadTable, id);
      if (!threadRow || threadRow.deleted_at != null) {
        throw new DataError('unavailable-thread', 'T3 thread is unavailable or deleted. Refresh the catalog.', 404);
      }
      const project = this.row(db, projectTable, String(threadRow.project_id));
      const threadRef = this.capture(threadTable, threadRow, path, generation);
      const refs = [threadRef];
      if (project) refs.push(this.capture(projectTable, project, path, generation));

      let activeProviderThread: Row | undefined;
      let bindingIssue: string | undefined;
      const activeId = string(threadRow.active_provider_thread_id);
      if (!activeId) {
        bindingIssue = 'This thread has no active provider-thread reference; its default provider is only a preference.';
      } else if (Buffer.byteLength(activeId, 'utf8') > maxReferenceKeyBytes) {
        bindingIssue = 'The active provider-thread reference exceeds the bounded metadata limit.';
      } else {
        const providerThread = this.providerThread(db, activeId);
        if (!providerThread) {
          bindingIssue = 'The active provider-thread reference has no row in the current projection.';
        } else {
          refs.push(this.capture(providerThreadTable, providerThread, path, generation));
          if (providerThread.thread_id !== id) {
            bindingIssue = 'The active provider-thread row belongs to a different T3 thread.';
          } else if (!string(providerThread.provider) || providerThread.provider !== providerThread.driver) {
            bindingIssue = 'The active provider-thread provider and driver fields are missing or inconsistent.';
          } else if (!string(threadRow.provider_instance_id) ||
            providerThread.provider_instance_id !== threadRow.provider_instance_id) {
            bindingIssue = 'The active provider-thread instance does not match the thread provider instance.';
          } else {
            const sessionId = string(providerThread.provider_session_id);
            if (!sessionId) {
              bindingIssue = 'The active provider-thread has no provider-session ID.';
            } else if (Buffer.byteLength(sessionId, 'utf8') > maxReferenceKeyBytes) {
              bindingIssue = 'The active provider-session ID exceeds the bounded metadata limit.';
            } else {
              const binding = this.sessionBinding(db, sessionId, id);
              if (!binding) {
                bindingIssue = 'The matching provider-session binding row is absent for this T3 thread.';
              } else {
                refs.push(this.capture(sessionBindingTable, binding, path, generation));
                activeProviderThread = providerThread;
              }
            }
          }
        }
      }

      const displayProvider = activeProviderThread?.provider ?? threadRow.default_provider;
      const thread = this.thread({
        ...threadRow,
        project_title: project?.title,
        workspace_root: project?.workspace_root,
        provider_name: displayProvider,
      });
      const activeProviderThreadId = string(threadRow.active_provider_thread_id);
      const providerInstanceId = string(threadRow.provider_instance_id);
      if (activeProviderThread && activeProviderThreadId !== undefined && providerInstanceId !== undefined &&
        this.refs.has(threadRef.id)) {
        this.linkBindings.set(threadRef.id, {
          threadId: id,
          activeProviderThreadId,
          providerInstanceId,
          deletedAt: threadRow.deleted_at ?? null,
        });
      }
      return { thread, refs, providerThread: activeProviderThread, bindingIssue };
    });
  }

  async validateLinkBinding(id: string): Promise<void> {
    const ref = this.refs.get(id);
    const snapshot = this.linkBindings.get(id);
    if (!ref || ref.table !== threadTable || !snapshot || ref.key !== snapshot.threadId ||
      Date.now() - Date.parse(ref.inspectedAt) > ttl) {
      throw new DataError('stale-reference', 'T3 active binding snapshot expired or was evicted. Reselect the thread.', 409);
    }
    await this.read((db, path, generation) => {
      if (path !== ref.databasePath || generation !== ref.generation) {
        throw new DataError('stale-reference', 'T3 database identity changed. Refresh the catalog.', 409);
      }
      const row = db.prepare(
        'SELECT thread_id, active_provider_thread_id, provider_instance_id, deleted_at FROM ' + threadTable +
        ' WHERE thread_id = ?',
      ).get(snapshot.threadId);
      if (!row || row.thread_id !== snapshot.threadId ||
        row.active_provider_thread_id !== snapshot.activeProviderThreadId ||
        row.provider_instance_id !== snapshot.providerInstanceId || row.deleted_at !== snapshot.deletedAt) {
        throw new DataError('stale-reference', 'The captured T3 active binding changed. Reselect the thread.', 409);
      }
    });
  }

  async evidence(id: string): Promise<DatabaseView> {
    const ref = this.refs.get(id);
    if (!ref || Date.now() - Date.parse(ref.inspectedAt) > ttl) {
      throw new DataError('stale-reference', 'T3 evidence expired or was evicted. Reselect the thread.', 409);
    }
    return this.read((db, path, generation) => {
      if (path !== ref.databasePath || generation !== ref.generation) {
        throw new DataError('stale-reference', 'T3 database identity changed. Refresh the catalog.', 409);
      }
      let row: Row | undefined;
      try { row = this.row(db, ref.table, ref.key); }
      catch (error) {
        if (error instanceof DataError && error.code === 'processing-limit') {
          throw new DataError('stale-reference', 'The captured T3 projection changed beyond its evidence bounds. Reselect the thread.', 409);
        }
        throw error;
      }
      if (!row || hash(rowText(row)) !== ref.sha256) {
        throw new DataError('stale-reference', 'The captured T3 row projection changed. Reselect the thread; current values are not substituted.', 409);
      }
      return { ref, text: rowText(row), validated: true };
    });
  }
}
