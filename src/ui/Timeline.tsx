import { useEffect, useState } from 'react';
import type { Overview, SourceRef, TimelinePage } from '../core/types';
import { api } from './api';

export function Timeline({ overview, onInspect }: { overview: Overview; onInspect: (ref: SourceRef) => void }) {
  const [kind, setKind] = useState('all');
  const [after, setAfter] = useState(0);
  const [history, setHistory] = useState<number[]>([]);
  const [page, setPage] = useState<TimelinePage>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(''); setPage(undefined);
    void api<TimelinePage>('/api/sessions/' + overview.id + '/events?' + new URLSearchParams({ after: String(after), kind }), { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setPage(value); })
      .catch(error => { if (!controller.signal.aborted) setError((error as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [overview.id, overview.state, after, kind]);
  function first() { setAfter(0); setHistory([]); }
  return <section className="resource-panel" aria-label="Conversation timeline">
    <div className="content-heading"><div><div className="section-label">Conversation</div><h1>Conversation and tool activity</h1></div></div>
    <p className="intro">Recorded order in this source. Runtime representations and diagnostic snapshots stay separate; missing reasoning does not mean no reasoning occurred.</p>
    <label htmlFor="timeline-kind">Show activity</label>{' '}
    <select id="timeline-kind" value={kind} onChange={event => { setKind(event.target.value); first(); }}>
      <option value="all">All records</option><option value="message">Messages</option><option value="tools">Tool calls and results</option><option value="reasoning">Captured reasoning</option><option value="usage">Usage observations</option><option value="attachment">Attachments and snapshots</option><option value="lifecycle">Lifecycle</option><option value="metadata">Metadata</option><option value="unknown">Unknown and limited records</option>
    </select>
    {busy ? <p className="notice">Loading activity…</p> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
    {page ? <>
      <p className="muted">{page.total.toLocaleString()} indexed events · {page.complete ? 'snapshot event index complete' : 'event coverage incomplete'} · {page.maxEvents.toLocaleString()} event limit. {page.omitted ? page.omitted.toLocaleString() + ' additional event/record captures omitted.' : ''} Physical-record coverage is listed below. These are recorded events, not reconstructed requests.</p>
      {!page.events.length ? <p className="notice">No matching events within the indexed coverage.</p> : null}
      {page.events.map(event => <article className="timeline-event" key={event.id}>
        <div className="panel-heading"><h2>{event.label}</h2><span className="badge">{event.kind}</span></div>
        <p className="muted">Line {event.ref.line} · {event.representation} · {event.origin}{event.timestamp ? ' · ' + event.timestamp : ''}</p>
        <span className="path">Actor: {event.actorId}{event.recordedId ? ' · Recorded ID: ' + event.recordedId : ''}{event.toolId ? ' · Tool ID: ' + event.toolId : ''}</span>
        {event.preview ? <p className="timeline-preview">{event.preview}{event.previewLimited ? '\n[Preview shortened; inspect source to continue.]' : ''}</p> : null}
        <p className="muted">{event.detail}</p>
        <div className="pager"><button onClick={() => onInspect(event.ref)}>Inspect line {event.ref.line} ↗</button>
          {event.pairStatus ? <span className={'badge ' + (event.pairStatus === 'paired' ? '' : 'amber')}>{event.pairStatus}{!page.complete ? ' · coverage incomplete' : ''}</span> : null}
          {event.related?.map((ref, i) => <button key={ref.id + ':' + ref.pointer + ':' + i} onClick={() => onInspect(ref)}>Related line {ref.line} ↗</button>)}
        </div>
      </article>)}
      <div className="pager">
        <button disabled={!after || busy} onClick={first}>First page</button>
        <button disabled={!history.length || busy} onClick={() => { setAfter(history.at(-1)!); setHistory(value => value.slice(0, -1)); }}>Previous activity</button>
        <button disabled={page.after === undefined || busy} onClick={() => { setHistory(value => [...value, after]); setAfter(page.after!); }}>Next activity →</button>
      </div>
    </> : null}
  </section>;
}
