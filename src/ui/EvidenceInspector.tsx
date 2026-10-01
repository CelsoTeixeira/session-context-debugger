import { useEffect, useState } from 'react';
import type { RecordView, SourceRef } from '../core/types';
import { api } from './api';

export function EvidenceInspector({ sessionId, ref }: { sessionId: string; ref: SourceRef }) {
  const [view, setView] = useState<RecordView>();
  const [offset, setOffset] = useState(0);
  const [raw, setRaw] = useState(!ref.pointer);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setView(undefined);
    const params = new URLSearchParams({ offset: String(offset) });
    if (!raw && ref.pointer) params.set('pointer', ref.pointer);
    api<RecordView>('/api/sessions/' + sessionId + '/records/' + ref.id + '?' + params, { signal: controller.signal })
      .then(setView).catch(error => { if (!controller.signal.aborted) setError(String(error.message)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId, ref.id, ref.pointer, offset, raw]);
  return <aside className="inspector" aria-label="Source inspector">
    <div className="section-label">Source inspector</div>
    <h2>Line {ref.line.toLocaleString()}</h2>
    <div className="segmented">
      <button className={!raw ? 'selected' : ''} disabled={!ref.pointer} onClick={() => { setRaw(false); setOffset(0); }}>Captured field</button>
      <button className={raw ? 'selected' : ''} onClick={() => { setRaw(true); setOffset(0); }}>Raw record</button>
    </div>
    <dl className="source-details">
      <dt>Pointer</dt><dd>{raw ? 'Whole record' : ref.pointer}</dd>
      <dt>Record bytes</dt><dd>{ref.offset.toLocaleString()} + {ref.byteLength.toLocaleString()} · delimiter {ref.delimiterLength}</dd>
      <dt>SHA-256</dt><dd className="hash">{ref.sha256}</dd>
    </dl>
    {loading ? <div className="notice">Validating source bytes…</div> : null}
    {error ? <div className="error" role="alert">{error}</div> : null}
    {view ? <>
      <div className="source-status"><span className="dot" /> Hash validated · {view.returnedBytes.toLocaleString()} of {view.totalBytes.toLocaleString()} bytes</div>
      <pre className="raw-body" tabIndex={0}>{view.text || '(empty field or record)'}</pre>
      {view.limited ? <p className="muted">Showing a bounded range from byte {offset.toLocaleString()}. More content remains outside this view.</p> : null}
      <div className="pager">
        {offset > 0 ? <button onClick={() => setOffset(0)}>Back to start</button> : null}
        {view.nextOffset !== undefined ? <button onClick={() => setOffset(view.nextOffset!)}>Next range →</button> : null}
      </div>
    </> : null}
  </aside>;
}
