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
    <div className="section-label">Recorded database evidence</div><h2>T3 catalog projection</h2>
    <dl className="source-details"><dt>Database</dt><dd>{reference.databasePath}</dd><dt>Environment</dt><dd>Local T3 Code</dd><dt>Generation</dt><dd>{reference.generation}</dd><dt>Table</dt><dd>{reference.table}</dd><dt>Row key</dt><dd>{reference.key}</dd><dt>Projection fields</dt><dd>{reference.columns.join(', ')}</dd>{reference.pointer ? <><dt>JSON field</dt><dd>payload_json{reference.pointer}</dd></> : null}<dt>Captured</dt><dd>{reference.inspectedAt}</dd><dt>SHA-256</dt><dd className="hash">{reference.sha256}</dd></dl>
    <p className="muted">Hash covers the displayed allowlisted SQL fields and bounded computed JSON metadata serialized as JSON. Provider-thread evidence includes only the nativeThreadRef.nativeId leaf and required metadata, never the full provider-state payload. It does not cover the full database or unlisted row fields.</p>
    {error ? <div className="error" role="alert">{error}</div> : view ? <><p className="source-status">Captured projection hash revalidated · read-only</p><pre className="raw-body">{view.text}</pre></> : <p className="muted">Revalidating captured row…</p>}
  </aside>;
}
