import { useEffect, useRef, useState } from 'react';
import type { DatabaseRef, LogMatch, Overview, SourceListing, SourceMode, SourceRef, T3Listing, T3Resolution } from '../core/types';
import { api, consumeAccessLink } from './api';
import { Beginning } from './Beginning';
import { Coverage } from './Coverage';
import { EvidenceInspector } from './EvidenceInspector';
import { DatabaseInspector } from './DatabaseInspector';
import { T3Context } from './T3Context';
import { Timeline } from './Timeline';

const formatBytes = (bytes: number): string => bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : (bytes / 1024).toFixed(1) + ' KB';
export function App() {
  const [hasAccess, setHasAccess] = useState(consumeAccessLink);
  const [accessGeneration, setAccessGeneration] = useState(0);
  const [mode, setMode] = useState<SourceMode>('t3');
  const [sessionView, setSessionView] = useState<'timeline' | 'beginning'>('timeline');
  const [listing, setListing] = useState<{ kind: 't3'; data: T3Listing } | { kind: 'claude' | 'codex'; data: SourceListing }>();
  const [resolution, setResolution] = useState<T3Resolution>();
  const [linkIdentity, setLinkIdentity] = useState<SourceRef>();
  const [databaseRef, setDatabaseRef] = useState<DatabaseRef>();
  const [path, setPath] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [overview, setOverview] = useState<Overview>();
  const [selectedRef, setSelectedRef] = useState<SourceRef>();
  const [error, setError] = useState('');
  const [listingBusy, setListingBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const listController = useRef<AbortController | null>(null);
  const openController = useRef<AbortController | null>(null);
  const selectionSerial = useRef(0);
  function clearSelection() {
    selectionSerial.current++;
    openController.current?.abort();
    setOpening(false);
    setSessionId('');
    setOverview(undefined);
    setSelectedRef(undefined);
    setDatabaseRef(undefined);
    setResolution(undefined);
    setLinkIdentity(undefined);
    setError('');
  }
  function inspect(ref: SourceRef) { setDatabaseRef(undefined); setSelectedRef(ref); }
  function inspectDatabase(ref: DatabaseRef) { setSelectedRef(undefined); setDatabaseRef(ref); }
  function changeMode(value: SourceMode) {
    listController.current?.abort();
    clearSelection();
    setListing(undefined);
    setMode(value);
  }
  useEffect(() => {
    const onHashChange = () => {
      if (new URLSearchParams(location.hash.slice(1)).has('access') && consumeAccessLink()) {
        clearSelection();
        setHasAccess(true);
        setAccessGeneration(value => value + 1);
        setListing(undefined);
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
    try {
      const params = new URLSearchParams(cursor ? { cursor } : {});
      if (mode === 't3') {
        const data = await api<T3Listing>('/api/t3/threads?' + params, { signal: controller.signal });
        if (!controller.signal.aborted) setListing({ kind: 't3', data });
      } else {
        params.set('family', mode);
        const data = await api<SourceListing>('/api/sources?' + params, { signal: controller.signal });
        if (!controller.signal.aborted) setListing({ kind: mode, data });
      }
    }
    catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
    finally { if (!controller.signal.aborted) setListingBusy(false); }
  }
  useEffect(() => {
    if (hasAccess) void list();
    return () => listController.current?.abort();
  }, [hasAccess, accessGeneration, mode]);
  async function openPath(value: string, sourceId?: string) {
    clearSelection();
    const serial = ++selectionSerial.current;
    const controller = new AbortController();
    openController.current = controller;
    setOpening(true);
    setError('');
    setOverview(undefined);
    setSelectedRef(undefined);
    setSessionId('');
    setPath(value);
    try {
      const result = await api<{ id: string }>('/api/sessions/open', {
        method: 'POST', body: JSON.stringify(sourceId ? { sourceId } : { path: value }), signal: controller.signal,
      });
      if (serial === selectionSerial.current) setSessionId(result.id);
    } catch (error) { if (serial === selectionSerial.current) setError((error as Error).message); }
    finally { if (serial === selectionSerial.current) setOpening(false); }
  }
  async function openLinked(value: T3Resolution, match: LogMatch, controller: AbortController, serial: number) {
    const result = await api<{ id: string; identity: SourceRef }>('/api/t3/threads/' + value.thread.id + '/open', {
      method: 'POST', body: JSON.stringify({ resolutionId: value.id, matchId: match.id }), signal: controller.signal,
    });
    if (serial !== selectionSerial.current || controller.signal.aborted) return;
    setPath(match.path);
    setSessionId(result.id);
    setLinkIdentity(result.identity);
  }
  async function openThread(id: string) {
    clearSelection();
    const serial = ++selectionSerial.current;
    const controller = new AbortController();
    openController.current = controller;
    setOpening(true);
    try {
      const value = await api<T3Resolution>('/api/t3/threads/' + id + '/resolve', { method: 'POST', body: '{}', signal: controller.signal });
      if (serial !== selectionSerial.current || controller.signal.aborted) return;
      setResolution(value);
      if (value.status === 'verified' && value.matches[0]) await openLinked(value, value.matches[0], controller, serial);
    } catch (error) { if (serial === selectionSerial.current && !controller.signal.aborted) setError((error as Error).message); }
    finally { if (serial === selectionSerial.current) setOpening(false); }
  }
  async function openMatch(match: LogMatch) {
    if (!resolution) return;
    openController.current?.abort();
    const serial = ++selectionSerial.current;
    const controller = new AbortController();
    openController.current = controller;
    setOpening(true);
    setOverview(undefined);
    setSessionId('');
    setSelectedRef(undefined);
    setDatabaseRef(undefined);
    setLinkIdentity(undefined);
    setError('');
    try { await openLinked(resolution, match, controller, serial); }
    catch (error) { if (serial === selectionSerial.current && !controller.signal.aborted) setError((error as Error).message); }
    finally { if (serial === selectionSerial.current) setOpening(false); }
  }
  useEffect(() => () => openController.current?.abort(), []);
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
    <div className={'workspace ' + (selectedRef || databaseRef ? 'with-inspector' : '')}>
      <nav className="session-sidebar" aria-label="Session sources">
        <div className="section-label">Select a session</div>
        <label htmlFor="source-mode">Session source</label>
        <select className="source-picker" id="source-mode" value={mode} onChange={event => changeMode(event.target.value as SourceMode)}><option value="t3">T3 Code</option><option value="claude">Claude</option><option value="codex">Codex</option></select>
        <form onSubmit={event => { event.preventDefault(); void openPath(path); }}>
          <label htmlFor="source-path">Absolute JSONL path</label>
          <textarea id="source-path" value={path} onChange={event => setPath(event.target.value)} placeholder="Paste a local session file path" rows={3} />
          <button className="primary" disabled={!path.trim() || opening} type="submit">{opening ? 'Opening…' : 'Open session →'}</button>
        </form>
        <div className="sidebar-heading"><h2>{mode === 't3' ? 'Recent T3 threads' : 'Recent files'}</h2><button onClick={() => void list()} disabled={listingBusy}>{mode === 't3' ? 'Refresh' : 'Rescan'}</button></div>
        <p className="muted sidebar-note">{mode === 't3' ? 'Current catalog metadata. Provider recording loads when selected.' : 'Listed from file stats. Content loads when selected.'}</p>
        {listingBusy ? <div className="notice">{mode === 't3' ? 'Reading T3 catalog…' : 'Reading file stats…'} <button onClick={() => { listController.current?.abort(); setListingBusy(false); }}>Cancel</button></div> : null}
        {listing?.data.warnings.map((warning, i) => <p className="sidebar-warning" key={i}>{warning}</p>)}
        {listing?.kind === 't3' ? <div className="source-list">{listing.data.threads.map(thread => <button key={thread.id} className={'source-candidate ' + (resolution?.thread.id === thread.id ? 'active' : '')} onClick={() => void openThread(thread.id)}>
          <span className="source-family">{thread.project} · {thread.provider ?? 'unknown'}{thread.archived ? ' · archived' : ''}</span><span className="source-name">{thread.title}</span><time>{new Date(thread.updatedAt).toLocaleString()}</time>
        </button>)}</div> : null}
        <div className="source-list">{listing && listing.kind !== 't3' ? listing.data.candidates.map(candidate => <button key={candidate.id} className={'source-candidate ' + (overview?.source.originalPath === candidate.path ? 'active' : '')} onClick={() => void openPath(candidate.path, candidate.id)}>
          <span className="source-family">{candidate.family} · {formatBytes(candidate.bytes)}</span>
          <span className="source-name">{candidate.path.split(/[\\/]/).at(-1)}</span>
          <time>{new Date(candidate.modifiedAt).toLocaleString()}</time>
        </button>) : null}</div>
        {listing?.data.cursor ? <button className="more-sources" disabled={listingBusy} onClick={() => void list(listing.data.cursor)}>{mode === 't3' ? 'Next threads →' : 'Next files →'}</button> : null}
      </nav>
      <main className="main-content">
        {error ? <div className="error" role="alert">{error}</div> : null}
        {opening ? <div className="notice">{mode === 't3' ? 'Resolving selected source…' : 'Opening recording…'} <button onClick={() => { openController.current?.abort(); selectionSerial.current++; setOpening(false); }}>Cancel</button></div> : null}
        {resolution ? <T3Context resolution={resolution} identity={overview?.state === 'ready' ? linkIdentity : undefined} onDatabase={inspectDatabase} onIdentity={inspect} onOpen={match => void openMatch(match)} /> : null}
        {overview ? <>
          <div className="session-strip"><div><span className="muted">{overview.source.runtime ?? 'Runtime unknown'} · {overview.source.version ?? 'Version unknown'} · {formatBytes(overview.source.size)}</span><div className="path">{overview.source.originalPath}</div></div><button onClick={() => resolution ? void openThread(resolution.thread.id) : void openPath(overview.source.originalPath)}>Reopen</button></div>
          {overview.state === 'indexing' ? <div className="scan-progress"><progress max={overview.coverage.inspectedBytes || 1} value={overview.coverage.scannedBytes} /><span>Indexing recording… <button onClick={() => void api('/api/sessions/' + overview.id + '/cancel', { method: 'POST', body: '{}' })}>Cancel</button></span></div> : null}
          {overview.warnings.length ? <details className="warnings"><summary>{overview.warnings.length} evidence/coverage note{overview.warnings.length === 1 ? '' : 's'}</summary><ul>{overview.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details> : null}
          <div className="segmented session-view" aria-label="Recording view"><button className={sessionView === 'timeline' ? 'selected' : ''} aria-pressed={sessionView === 'timeline'} onClick={() => setSessionView('timeline')}>Visual timeline</button><button className={sessionView === 'beginning' ? 'selected' : ''} aria-pressed={sessionView === 'beginning'} onClick={() => setSessionView('beginning')}>Beginning and instructions</button></div>
          <div hidden={sessionView !== 'beginning'}><Beginning overview={overview} onInspect={inspect} /></div>
          <div hidden={sessionView !== 'timeline'}><Timeline key={'timeline:' + overview.id} overview={overview} onInspect={inspect} /></div>
          <Coverage key={overview.id} overview={overview} onInspect={inspect} />
        </> : !resolution && !opening ? <div className="empty-state"><div className="section-label">A recording, with its receipts</div><h1>Start at the beginning.</h1><p>{mode === 't3' ? 'Select a T3 thread to inspect its current provider binding and a verified linked recording.' : 'Select a recording to inspect the first input, captured instructions, diagnostic snapshots, and provider-reported usage.'}</p><div className="empty-rule" /><p className="muted">Recorded data, request payloads, active-context evidence, and unknowns keep their own meaning.</p></div> : null}
      </main>
      {overview && selectedRef ? <div className="inspector-wrapper"><button className="inspector-close" onClick={() => setSelectedRef(undefined)} aria-label="Close source inspector">×</button><EvidenceInspector key={overview.id + ':' + selectedRef.id + ':' + selectedRef.pointer} sessionId={overview.id} ref={selectedRef} /></div> : null}
      {databaseRef ? <div className="inspector-wrapper"><button className="inspector-close" onClick={() => setDatabaseRef(undefined)} aria-label="Close source inspector">×</button><DatabaseInspector key={databaseRef.id} reference={databaseRef} /></div> : null}
    </div>
  </>;
}
