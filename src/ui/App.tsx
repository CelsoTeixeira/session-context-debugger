import { useEffect, useRef, useState } from 'react';
import type { Overview, SourceListing, SourceRef } from '../core/types';
import { api, consumeAccessLink } from './api';
import { Beginning } from './Beginning';
import { Coverage } from './Coverage';
import { EvidenceInspector } from './EvidenceInspector';

const formatBytes = (bytes: number): string => bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : (bytes / 1024).toFixed(1) + ' KB';
export function App() {
  const [hasAccess, setHasAccess] = useState(consumeAccessLink);
  const [accessGeneration, setAccessGeneration] = useState(0);
  const [listing, setListing] = useState<SourceListing>();
  const [path, setPath] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [overview, setOverview] = useState<Overview>();
  const [selectedRef, setSelectedRef] = useState<SourceRef>();
  const [error, setError] = useState('');
  const [listingBusy, setListingBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const listController = useRef<AbortController | null>(null);
  const selectionSerial = useRef(0);
  useEffect(() => {
    const onHashChange = () => {
      if (new URLSearchParams(location.hash.slice(1)).has('access') && consumeAccessLink()) {
        selectionSerial.current++;
        setHasAccess(true);
        setAccessGeneration(value => value + 1);
        setSessionId('');
        setOverview(undefined);
        setSelectedRef(undefined);
        setError('');
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  async function list(cursor?: string) {
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    setListingBusy(true);
    setError('');
    try { setListing(await api<SourceListing>('/api/sources' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), { signal: controller.signal })); }
    catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
    finally { if (!controller.signal.aborted) setListingBusy(false); }
  }
  useEffect(() => {
    if (hasAccess) void list();
    return () => listController.current?.abort();
  }, [hasAccess, accessGeneration]);
  async function openPath(value: string, sourceId?: string) {
    const serial = ++selectionSerial.current;
    setOpening(true);
    setError('');
    setOverview(undefined);
    setSelectedRef(undefined);
    setSessionId('');
    setPath(value);
    try {
      const result = await api<{ id: string }>('/api/sessions/open', {
        method: 'POST', body: JSON.stringify(sourceId ? { sourceId } : { path: value }),
      });
      if (serial === selectionSerial.current) setSessionId(result.id);
    } catch (error) { if (serial === selectionSerial.current) setError((error as Error).message); }
    finally { if (serial === selectionSerial.current) setOpening(false); }
  }
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await api<Overview>('/api/sessions/' + sessionId + '/overview', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setOverview(value);
        if (value.state === 'indexing') timer = setTimeout(poll, 350);
      } catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId]);
  if (!hasAccess) return <div className="access-page"><span className="brand-mark">↳</span><h1>Session Context Debugger</h1><p>Open the access link printed in the terminal when you launch the app.</p><p className="muted">The access credential stays in this tab. Reopening the link restores access after a reload.</p></div>;
  return <>
    <header className="app-header"><div className="brand"><span className="brand-mark">↳</span><strong>Session Context Debugger</strong></div><span className="local-indicator"><span className="dot" /> Local · read-only</span></header>
    <div className={'workspace ' + (selectedRef ? 'with-inspector' : '')}>
      <nav className="session-sidebar" aria-label="Session sources">
        <div className="section-label">Select a recording</div>
        <form onSubmit={event => { event.preventDefault(); void openPath(path); }}>
          <label htmlFor="source-path">Absolute JSONL path</label>
          <textarea id="source-path" value={path} onChange={event => setPath(event.target.value)} placeholder="Paste a local session file path" rows={3} />
          <button className="primary" disabled={!path.trim() || opening} type="submit">{opening ? 'Opening…' : 'Open session →'}</button>
        </form>
        <div className="sidebar-heading"><h2>Recent files</h2><button onClick={() => void list()} disabled={listingBusy}>Rescan</button></div>
        <p className="muted sidebar-note">Listed from file stats. Content loads when selected.</p>
        {listingBusy ? <div className="notice">Reading file stats… <button onClick={() => { listController.current?.abort(); setListingBusy(false); }}>Cancel</button></div> : null}
        {listing?.warnings.map((warning, i) => <p className="sidebar-warning" key={i}>{warning}</p>)}
        <div className="source-list">{listing?.candidates.map(candidate => <button key={candidate.id} className={'source-candidate ' + (overview?.source.originalPath === candidate.path ? 'active' : '')} onClick={() => void openPath(candidate.path, candidate.id)}>
          <span className="source-family">{candidate.family} · {formatBytes(candidate.bytes)}</span>
          <span className="source-name">{candidate.path.split(/[\\/]/).at(-1)}</span>
          <time>{new Date(candidate.modifiedAt).toLocaleString()}</time>
        </button>)}</div>
        {listing?.cursor ? <button className="more-sources" onClick={() => void list(listing.cursor)}>Next files →</button> : null}
      </nav>
      <main className="main-content">
        {error ? <div className="error" role="alert">{error}</div> : null}
        {overview ? <>
          <div className="session-strip"><div><span className="muted">{overview.source.runtime ?? 'Runtime unknown'} · {overview.source.version ?? 'Version unknown'} · {formatBytes(overview.source.size)}</span><div className="path">{overview.source.originalPath}</div></div><button onClick={() => void openPath(overview.source.originalPath)}>Reopen</button></div>
          {overview.state === 'indexing' ? <div className="scan-progress"><progress max={overview.coverage.inspectedBytes || 1} value={overview.coverage.scannedBytes} /><span>Indexing recording… <button onClick={() => void api('/api/sessions/' + overview.id + '/cancel', { method: 'POST', body: '{}' })}>Cancel</button></span></div> : null}
          {overview.warnings.length ? <details className="warnings"><summary>{overview.warnings.length} evidence/coverage note{overview.warnings.length === 1 ? '' : 's'}</summary><ul>{overview.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details> : null}
          <Beginning overview={overview} onInspect={setSelectedRef} />
          <Coverage key={overview.id} overview={overview} onInspect={setSelectedRef} />
        </> : <div className="empty-state"><div className="section-label">A recording, with its receipts</div><h1>Start at the beginning.</h1><p>Select a session to inspect the first input, captured instructions, diagnostic snapshots, and provider-reported usage.</p><div className="empty-rule" /><p className="muted">Recorded data, request payloads, active-context evidence, and unknowns keep their own meaning.</p></div>}
      </main>
      {overview && selectedRef ? <div className="inspector-wrapper"><button className="inspector-close" onClick={() => setSelectedRef(undefined)} aria-label="Close source inspector">×</button><EvidenceInspector key={overview.id + ':' + selectedRef.id + ':' + selectedRef.pointer} sessionId={overview.id} ref={selectedRef} /></div> : null}
    </div>
  </>;
}
