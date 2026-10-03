import { useEffect, useRef, useState } from 'react';
import type { Overview, SourceRef, TimelineCategory, TimelineMap, TimelinePage } from '../core/types';
import { timelineCategory } from '../core/timeline-category';
import { api } from './api';
import { CategoryRanking, payloadSize } from './CategoryRanking';

const categories: Array<[TimelineCategory, string]> = [
  ['user', 'User input'], ['instruction', 'Instructions'], ['assistant', 'Assistant'], ['message', 'Other message'],
  ['tool-call', 'Tool call'], ['tool-result', 'Tool result'], ['reasoning', 'Reasoning'], ['usage', 'Usage'],
  ['snapshot', 'Snapshot'], ['attachment', 'Attachment'], ['lifecycle', 'Lifecycle'], ['metadata', 'Metadata'], ['unknown', 'Unknown'],
];
const categoryLabel = (category: TimelineCategory): string => categories.find(([key]) => key === category)![1];

export function Timeline({ overview, onInspect }: { overview: Overview; onInspect: (ref: SourceRef) => void }) {
  const [kind, setKind] = useState('all');
  const [after, setAfter] = useState(0);
  const [page, setPage] = useState<TimelinePage>();
  const [map, setMap] = useState<TimelineMap>();
  const [selectedId, setSelectedId] = useState<string>();
  const [error, setError] = useState('');
  const [mapError, setMapError] = useState('');
  const [busy, setBusy] = useState(false);
  const edge = useRef<'first' | 'last'>('first');
  const focusOnLoad = useRef(false);
  const loadedCursor = useRef(-1);
  const markers = useRef<HTMLDivElement>(null);
  const selected = page?.events.find(event => event.id === selectedId) ?? page?.events[0];
  const selectedIndex = page?.events.findIndex(event => event.id === selected?.id) ?? -1;
  useEffect(() => {
    if (focusOnLoad.current && selected && loadedCursor.current === after) {
      markers.current?.querySelector<HTMLButtonElement>('[data-position="' + selected.position + '"]')?.focus();
      focusOnLoad.current = false;
    }
  }, [selected, page, after]);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(''); setPage(undefined);
    void api<TimelinePage>('/api/sessions/' + overview.id + '/events?' + new URLSearchParams({ after: String(after), kind }), { signal: controller.signal })
      .then(value => {
        if (controller.signal.aborted) return;
        loadedCursor.current = after;
        setPage(value);
        setSelectedId(old => value.events.some(event => event.id === old) ? old : (edge.current === 'last' ? value.events.at(-1) : value.events[0])?.id);
      })
      .catch(error => { if (!controller.signal.aborted) setError((error as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [overview.id, overview.state, after, kind]);
  useEffect(() => {
    const controller = new AbortController();
    setMap(undefined); setMapError('');
    void api<TimelineMap>('/api/sessions/' + overview.id + '/events?' + new URLSearchParams({ view: 'map', kind }), { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setMap(value); })
      .catch(error => { if (!controller.signal.aborted) setMapError((error as Error).message); });
    return () => controller.abort();
  }, [overview.id, overview.state, kind]);
  function navigate(position: number, selection: 'first' | 'last' = 'first') {
    edge.current = selection;
    loadedCursor.current = -1;
    setSelectedId(undefined);
    setAfter(position);
  }
  function move(direction: -1 | 1, focus = false) {
    if (!page || busy) return;
    const target = page.events[selectedIndex + direction];
    if (target) {
      setSelectedId(target.id);
      if (focus) markers.current?.querySelector<HTMLButtonElement>('[data-position="' + target.position + '"]')?.focus();
    } else if (direction === -1 && page.before !== undefined) { focusOnLoad.current = focus; navigate(page.before, 'last'); }
    else if (direction === 1 && page.after !== undefined) { focusOnLoad.current = focus; navigate(page.after); }
  }
  const windowStart = page?.events[0]?.position;
  const windowEnd = page?.events.at(-1)?.position;
  return <section className="visual-timeline resource-panel" aria-label="Conversation timeline">
    <div className="content-heading"><div><div className="section-label">Conversation</div><h1>Explore the recording</h1></div><span className="muted">{map?.total.toLocaleString() ?? '…'} events indexed</span></div>
    <p className="intro">Click a range, then an event. Colors describe captured activity; spacing follows recorded order, not elapsed time or token usage.</p>
    <div className="timeline-legend" aria-label="Activity colors">{categories.map(([category, label]) => <span key={category}><i className="timeline-swatch" data-category={category} />{label}</span>)}</div>
    <div className="timeline-overview-panel">
      <div className="panel-heading"><h2>Session overview</h2><span className="muted">{map?.bins.length ? 'Each column groups nearby events' : 'Loading overview…'}</span></div>
      {mapError ? <p className="error" role="alert">{mapError}</p> : null}
      <div className="timeline-map" aria-label="Session ranges">
        {map?.bins.map(bin => {
          let y = 0;
          const inWindow = windowStart !== undefined && windowEnd !== undefined && bin.start <= windowEnd && bin.end > windowStart;
          const description = 'Events ' + (bin.start + 1) + '–' + bin.end + ', lines ' + bin.firstLine + '–' + bin.lastLine
            + '. ' + Object.entries(bin.counts).map(([category, count]) => categoryLabel(category as TimelineCategory) + ': ' + count).join(', ');
          return <button key={bin.start} className={'timeline-bin ' + (inWindow ? 'in-window' : '')} title={description} aria-label={description} aria-pressed={inWindow}
            disabled={!bin.matching || busy} onClick={() => navigate(bin.firstMatch!)}>
            <svg viewBox={'0 0 10 ' + (bin.end - bin.start)} preserveAspectRatio="none" aria-hidden="true">{categories.map(([category]) => {
              const count = bin.counts[category] ?? 0;
              const start = y; y += count;
              return count ? <rect key={category} x="0" y={start} width="10" height={count} data-category={category} /> : null;
            })}</svg>
          </button>;
        })}
      </div>
      <div className="timeline-scale"><span>Recording start</span><span>{map ? map.matching.toLocaleString() + ' events match the filter' : ''}</span><span>Latest indexed event</span></div>
    </div>
    <CategoryRanking ranking={map?.ranking} labels={categories} omitted={map?.omitted ?? 0} onInspect={onInspect} />
    <div className="timeline-toolbar">
      <div><label htmlFor="timeline-kind">Show activity</label>{' '}<select id="timeline-kind" value={kind} onChange={event => { setKind(event.target.value); navigate(0); }}>
        <option value="all">All records</option><option value="message">Messages</option><option value="tools">Tool calls and results</option><option value="reasoning">Captured reasoning</option><option value="usage">Usage observations</option><option value="attachment">Attachments and snapshots</option><option value="lifecycle">Lifecycle</option><option value="metadata">Metadata</option><option value="unknown">Unknown and limited records</option>
      </select></div>
      <div className="pager"><button disabled={!after || busy} onClick={() => navigate(0)}>Start</button><button disabled={page?.before === undefined || busy} onClick={() => navigate(page!.before!)}>Previous range</button><button disabled={page?.after === undefined || busy} onClick={() => navigate(page!.after!)}>Next range →</button></div>
    </div>
    {busy ? <p className="notice">Loading activity…</p> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
    {page ? <>
      <div className="panel-heading"><h2>{windowStart !== undefined ? 'Events ' + (windowStart + 1) + '–' + (windowEnd! + 1) : 'Current range'}</h2><span className="muted">Select a marker · ← → to move</span></div>
      <div className="timeline-markers" ref={markers} aria-label="Events in current range" onKeyDown={event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1, true); }
      }}>
        {page.events.map(event => <button key={event.id} data-position={event.position} data-category={timelineCategory(event)}
          className={'timeline-marker ' + (selected?.id === event.id ? 'selected' : '')} aria-pressed={selected?.id === event.id} tabIndex={selected?.id === event.id ? 0 : -1}
          title={categoryLabel(timelineCategory(event)) + ' · ' + event.label + ' · line ' + event.ref.line}
          aria-label={'Event ' + (event.position + 1) + ': ' + event.label + ', line ' + event.ref.line} onClick={() => setSelectedId(event.id)}>
          <span aria-hidden="true">{event.kind === 'tool-call' ? '↗' : event.kind === 'tool-result' ? '↙' : event.kind === 'message' ? '●' : '◆'}</span>
        </button>)}
      </div>
      {!page.events.length ? <p className="notice">No matching events within the indexed coverage.</p> : null}
      {selected ? <article className="timeline-detail" data-category={timelineCategory(selected)}>
        <div className="panel-heading"><div><span className="section-label">Event {selected.position + 1} · line {selected.ref.line}</span><h2>{selected.label}</h2></div><div className="pager"><button aria-label="Previous event" disabled={selectedIndex <= 0 && page.before === undefined} onClick={() => move(-1)}>←</button><button aria-label="Next event" disabled={selectedIndex === page.events.length - 1 && page.after === undefined} onClick={() => move(1)}>→</button></div></div>
        <div className="timeline-evidence"><span className="timeline-type">{categoryLabel(timelineCategory(selected))}</span><span>{selected.representation}</span><span>{selected.origin}</span>{selected.pairStatus ? <span className="badge amber">{selected.pairStatus}{!page.complete ? ' · coverage incomplete' : ''}</span> : null}</div>
        {selected.preview ? <p className="timeline-preview">{selected.preview}{selected.previewLimited ? '\n[Preview shortened; inspect source to continue.]' : ''}</p> : <p className="muted">Open the source to read the captured fields.</p>}
        <p className="muted">{selected.detail}</p>
        <p className="muted">Captured field size: {selected.serializedBytes === null ? 'Unknown' : payloadSize(selected.serializedBytes)} after compact JSON encoding.{selected.allocatedBytes !== null && selected.allocatedBytes !== selected.serializedBytes ? ' Ranking allocates ' + payloadSize(selected.allocatedBytes) + ' here; overlapping captured fields share bytes once.' : ''}</p>
        <div className="pager timeline-related"><button onClick={() => onInspect(selected.ref)}>Inspect source ↗</button>{selected.related?.map((ref, i) => <button key={ref.id + ':' + ref.pointer + ':' + i} onClick={() => navigate(selected.relatedPositions![i]!)}>Go to {selected.kind === 'tool-call' ? 'result' : 'call'} · line {ref.line}</button>)}</div>
        <details className="timeline-identities"><summary>Recorded time and identifiers</summary><span className="path">Time: {selected.timestamp ?? 'unknown'}<br />Actor: {selected.actorId}<br />Recorded ID: {selected.recordedId ?? 'unknown'}<br />Tool ID: {selected.toolId ?? 'unknown'}</span></details>
      </article> : null}
      <p className="muted timeline-coverage">{page.complete ? 'Event coverage complete within this snapshot.' : 'Event coverage incomplete; see source coverage below.'} Index limit: {page.maxEvents.toLocaleString()} events.{page.omitted ? ' Additional event/record captures omitted: ' + page.omitted.toLocaleString() + '.' : ''} Snapshots, runtime copies, and unknown records remain separate evidence. Missing reasoning does not mean none occurred.</p>
    </> : null}
  </section>;
}
