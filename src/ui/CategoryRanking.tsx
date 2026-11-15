import { useEffect, useState } from 'react';
import type { Overview, SourceRef, TimelineCategory, TimelineMap, TimelineEvent } from '../core/types';
import { api } from './api';

export const payloadSize = (bytes: number): string => bytes < 1024 ? bytes.toLocaleString() + ' B'
  : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KiB' : (bytes / (1024 * 1024)).toFixed(1) + ' MiB';

export const categories: Array<[TimelineCategory, string]> = [
  ['user', 'User input'], ['instruction', 'Instructions'], ['assistant', 'Assistant'], ['message', 'Other message'],
  ['tool-call', 'Tool call'], ['tool-result', 'Tool result'], ['reasoning', 'Reasoning'], ['usage', 'Usage'],
  ['snapshot', 'Snapshot'], ['attachment', 'Attachment'], ['lifecycle', 'Lifecycle'], ['metadata', 'Metadata'], ['unknown', 'Unknown'],
];

export function CategoryRanking({ overview, onInspect }: {
  overview: Overview; onInspect: (ref: SourceRef) => void;
}) {
  const [map, setMap] = useState<TimelineMap>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [representation, setRepresentation] = useState<TimelineEvent['representation']>('primary');
  const [metric, setMetric] = useState<'bytes' | 'events'>('bytes');
  useEffect(() => {
    const controller = new AbortController();
    setMap(undefined);
    setError('');
    void api<TimelineMap>('/api/sessions/' + overview.id + '/events?' + new URLSearchParams({ view: 'map', kind: 'all' }), { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setMap(value); })
      .catch(failure => { if (!controller.signal.aborted) setError((failure as Error).message); });
    return () => controller.abort();
  }, [overview.id, overview.state, reload]);
  const label = (category: TimelineCategory) => categories.find(([key]) => key === category)![1];
  const ranking = map?.ranking;
  const rows = (ranking ?? []).filter(row => row.representation === representation)
    .sort((a, b) => b[metric] - a[metric] || label(a.category).localeCompare(label(b.category)));
  const total = rows.reduce((sum, row) => sum + row[metric], 0);
  const max = Math.max(1, ...rows.map(row => row[metric]));
  const unknown = rows.reduce((sum, row) => sum + row.events - row.measuredEvents, 0);
  return <section className="category-ranking resource-panel" aria-label="Captured bytes by category">
    <div className="panel-heading"><div><h2>Captured bytes by category</h2><span className="muted">Whole retained recording scope · independent of Timeline filters</span></div></div>
    <div className="ranking-controls"><label>Compare <select value={metric} onChange={event => setMetric(event.target.value as typeof metric)}><option value="bytes">Serialized payload bytes</option><option value="events">Number of events</option></select></label>
      <label>Evidence view <select value={representation} onChange={event => setRepresentation(event.target.value as typeof representation)}><option value="primary">Primary captures</option><option value="metadata">Runtime and configuration</option><option value="diagnostic-snapshot">Diagnostic snapshots</option><option value="unknown">Unclassified captures</option><option value="mirror">Recorded mirrors</option></select></label></div>
    {error ? <p className="error" role="alert">{error} <button onClick={() => setReload(value => value + 1)}>Retry</button></p> : !ranking ? <p className="notice">Loading captured payload sizes…</p> : !rows.length ? <p className="notice">No retained captures in this evidence view.</p> : rows.map((row, index) => {
      const known = metric === 'events' || row.measuredEvents > 0;
      const percent = total ? row[metric] / total * 100 : 0;
      return <div className="ranking-row" key={row.category} data-category={row.category}>
        <span className="ranking-position">{known ? index + 1 : '?'}</span><div className="ranking-name"><span><i className="timeline-swatch" />{label(row.category)}</span><small>{row.events.toLocaleString()} events{metric === 'bytes' ? ' · ' + row.measuredEvents.toLocaleString() + ' sized' : ''}</small></div>
        <svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect className="ranking-track" width="100" height="8" rx="3" /><rect width={row[metric] / max * 100} height="8" rx="3" /></svg>
        <div className="ranking-value"><strong>{known ? metric === 'bytes' ? payloadSize(row.bytes) : row.events.toLocaleString() : 'Unknown'}</strong><small>{known && total ? (percent > 0 && percent < 0.1 ? '<0.1' : percent.toFixed(1)) + '% of this view' : 'Share unavailable'}</small></div>
        <button onClick={() => onInspect(row.largest?.ref ?? row.firstRef)}>{row.largest ? 'Inspect largest ↗' : 'Inspect example ↗'}</button>
      </div>;
    })}
    <p className="muted ranking-method">Captured payload size is UTF-8 bytes after compact JSON encoding of captured fields, including encoded media. It is separate from physical transcript bytes. Shares cover measured bytes only; unknown sizes are marked separately. Overlapping fields in one record share bytes once. Copies in other records remain separate in their evidence views. This is not a token ranking, raw log storage size, or proof of active context. {unknown ? unknown.toLocaleString() + ' captures in this view have unknown sizes. ' : ''}{map?.omitted ? 'Additional captures exceed the index limit. ' : ''}Source coverage is on the Coverage tab.</p>
  </section>;
}
