import { useEffect, useRef, useState } from 'react';
import type { Overview, SearchMatch, SearchView, SourceRef } from '../core/types';
import { api } from './api';

export function SourceSearch({ overview, onInspect, onNavigate }: {
  overview: Overview; onInspect: (ref: SourceRef, offset?: number) => void; onNavigate: (match: SearchMatch) => void;
}) {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<SearchView>();
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [shown, setShown] = useState(5);
  const controller = useRef<AbortController | undefined>(undefined);
  const searchId = useRef<string | undefined>(undefined);
  const endpoint = '/api/sessions/' + overview.id + '/search';
  function cancelOnServer(id: string): void {
    void api(endpoint + '/cancel', { method: 'POST', body: JSON.stringify({ id }) }).catch(() => { /* A recording change can evict this search. */ });
  }
  useEffect(() => () => {
    controller.current?.abort();
    if (searchId.current) cancelOnServer(searchId.current);
  }, [overview.id]);
  useEffect(() => {
    if (view?.state !== 'searching') return;
    const request = new AbortController();
    const timer = window.setTimeout(() => {
      void api<SearchView>(endpoint + '?' + new URLSearchParams({ id: view.id }), { signal: request.signal })
        .then(value => { if (!request.signal.aborted) setView(value); })
        .catch(error => { if (!request.signal.aborted) { setError((error as Error).message); setView(old => old ? { ...old, state: 'error', matches: [], detail: 'Search status unavailable. Coverage is incomplete.' } : old); } });
    }, 200);
    return () => { clearTimeout(timer); request.abort(); };
  }, [view, endpoint]);
  async function start(): Promise<void> {
    controller.current?.abort();
    if (searchId.current) cancelOnServer(searchId.current);
    const request = new AbortController();
    controller.current = request;
    searchId.current = undefined;
    setStarting(true); setError(''); setView(undefined); setShown(5);
    try {
      const result = await api<SearchView>(endpoint, { method: 'POST', body: JSON.stringify({ query }), signal: request.signal });
      if (!request.signal.aborted) { searchId.current = result.id; setView(result); }
    } catch (error) { if (!request.signal.aborted) setError((error as Error).message); }
    finally { if (!request.signal.aborted) setStarting(false); }
  }
  async function cancel(): Promise<void> {
    if (!view) return;
    try { await api(endpoint + '/cancel', { method: 'POST', body: JSON.stringify({ id: view.id }) }); }
    catch (error) { setError((error as Error).message); }
  }
  return <section className="source-search" aria-label="Search selected recording">
    <form onSubmit={event => { event.preventDefault(); void start(); }}>
      <label htmlFor="source-search-query">Search this recording</label>
      <div className="source-search-controls"><input id="source-search-query" type="search" value={query} maxLength={256} placeholder="AGENTS.md, a tool name, or literal text" onChange={event => setQuery(event.target.value)} />
        <button type="submit" disabled={!query.length || starting || overview.state !== 'ready'}>{starting ? 'Starting…' : 'Search raw source'}</button>
        {view?.state === 'searching' ? <button type="button" onClick={() => void cancel()}>Cancel search</button> : null}
        {view ? <button type="button" onClick={() => { cancelOnServer(view.id); controller.current?.abort(); searchId.current = undefined; setView(undefined); setError(''); }}>Clear search</button> : null}
      </div>
    </form>
    <p className="muted search-method">Case-sensitive literal search of raw UTF-8 JSONL, including unknown and oversized records. JSON escapes stay escaped (for example, <code>\n</code>). Independent of the activity filter; one short preview per matching line. Inspect the source for full content.</p>
    {overview.state !== 'ready' ? <p className="muted">Search is available after indexing finishes.</p> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
    {view ? <div className="search-results">
      <p className="search-query">Results for <code>{view.query}</code>{view.query !== query ? ' · Query edited; search again to update results.' : ''}</p>
      <div className="search-progress" role="status"><strong>{view.state === 'searching' ? 'Searching…' : view.state === 'complete' ? 'Search complete' : view.state === 'cancelled' ? 'Search cancelled' : view.state === 'limited' ? 'Search limited' : 'Search failed'}</strong><span>{view.scannedBytes.toLocaleString()} / {view.snapshotBytes.toLocaleString()} bytes · {view.scannedRecords.toLocaleString()} records inspected · {view.matches.length} matching lines retained</span></div>
      <progress aria-label="Source search progress" value={view.scannedBytes} max={view.snapshotBytes || 1} />
      <p className="muted">{view.detail}</p>
      {!view.matches.length ? <p>{view.state === 'complete' ? 'No literal match in this raw-source snapshot.' : 'No matches retained so far. This does not establish absence.'}</p> : null}
      {view.matches.slice(0, shown).map(match => <article className="search-result" key={match.ref.id}>
        <div className="panel-heading"><strong>Line {match.ref.line.toLocaleString()}{match.pending ? ' · pending trailing bytes' : ''}</strong><span className="muted">Match at record byte {match.matchOffset.toLocaleString()}</span></div>
        <pre>{match.preview}</pre>
        <div className="pager"><button onClick={() => onInspect(match.ref, match.matchOffset)}>Inspect match ↗</button><button disabled={!match.target} onClick={() => onNavigate(match)}>Show line in timeline ↑</button></div>
        <p className="muted">{match.target ? 'Opens the first indexed event on this line; the match may be in another field.' : 'No timeline event retained for this line. Raw-source inspection remains available.'}</p>
      </article>)}
      {shown < view.matches.length ? <button onClick={() => setShown(value => value + 10)}>Show more matches ({view.matches.length - shown})</button> : null}
    </div> : null}
  </section>;
}
