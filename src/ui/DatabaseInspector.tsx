import { useEffect, useState } from 'react';
import type { DatabaseRef, DatabaseView } from '../core/types';
import { api } from './api';

export function DatabaseInspector({ reference }: { reference: DatabaseRef }) {
  const [view, setView] = useState<DatabaseView>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api<DatabaseView>('/api/t3/evidence/' + reference.id, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setView(value);
    }).catch(error => { if (!controller.signal.aborted) setError((error as Error).message); });
    return () => controller.abort();
  }, [reference.id]);
  return <aside className="inspector" aria-label="T3 database evidence">
    <div className="section-label">Recorded database evidence</div><h2>T3 row projection</h2>
    <dl className="source-details"><dt>Database</dt><dd>{reference.databasePath}</dd><dt>Environment</dt><dd>Local T3 Code</dd><dt>Generation</dt><dd>{reference.generation}</dd><dt>Table</dt><dd>{reference.table}</dd><dt>Row key</dt><dd>{reference.key}</dd><dt>Columns</dt><dd>{reference.columns.join(', ')}</dd>{reference.pointer ? <><dt>Cursor field</dt><dd>resume_cursor_json {reference.pointer}</dd></> : null}<dt>Captured</dt><dd>{reference.inspectedAt}</dd><dt>SHA-256</dt><dd className="hash">{reference.sha256}</dd></dl>
    <p className="muted">Hash covers the displayed allowlisted SQL columns serialized as JSON, including the original cursor string. It does not cover the full database or all row columns.</p>
    {error ? <div className="error" role="alert">{error}</div> : view ? <><p className="source-status">Captured projection hash revalidated · read-only</p><pre className="raw-body">{view.text}</pre></> : <p className="muted">Revalidating captured row…</p>}
  </aside>;
}
