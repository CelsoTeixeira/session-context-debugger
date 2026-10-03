import { useState } from 'react';
import type { SourceRef, TimelineCategory, TimelineMap, TimelineEvent } from '../core/types';

export const payloadSize = (bytes: number): string => bytes < 1024 ? bytes.toLocaleString() + ' B'
  : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KiB' : (bytes / (1024 * 1024)).toFixed(1) + ' MiB';

export function CategoryRanking({ ranking, labels, omitted, onInspect }: {
  ranking?: TimelineMap['ranking']; labels: Array<[TimelineCategory, string]>; omitted: number; onInspect: (ref: SourceRef) => void;
}) {
  const [representation, setRepresentation] = useState<TimelineEvent['representation']>('primary');
  const [metric, setMetric] = useState<'bytes' | 'events'>('bytes');
  const label = (category: TimelineCategory) => labels.find(([key]) => key === category)![1];
  const rows = (ranking ?? []).filter(row => row.representation === representation)
    .sort((a, b) => b[metric] - a[metric] || label(a.category).localeCompare(label(b.category)));
  const total = rows.reduce((sum, row) => sum + row[metric], 0);
  const max = Math.max(1, ...rows.map(row => row[metric]));
  const unknown = rows.reduce((sum, row) => sum + row.events - row.measuredEvents, 0);
  return <section className="category-ranking" aria-label="Category ranking">
    <div className="panel-heading"><h2>Category ranking</h2><span className="muted">Whole retained index</span></div>
    <div className="ranking-controls"><label>Compare <select value={metric} onChange={event => setMetric(event.target.value as typeof metric)}><option value="bytes">Serialized payload bytes</option><option value="events">Number of events</option></select></label>
      <label>Evidence view <select value={representation} onChange={event => setRepresentation(event.target.value as typeof representation)}><option value="primary">Primary captures</option><option value="metadata">Runtime and configuration</option><option value="diagnostic-snapshot">Diagnostic snapshots</option><option value="unknown">Unclassified captures</option><option value="mirror">Recorded mirrors</option></select></label></div>
    {!ranking ? <p className="notice">Loading category sizes…</p> : !rows.length ? <p className="notice">No retained captures in this evidence view.</p> : rows.map((row, index) => {
      const known = metric === 'events' || row.measuredEvents > 0;
      const percent = total ? row[metric] / total * 100 : 0;
      return <div className="ranking-row" key={row.category} data-category={row.category}>
        <span className="ranking-position">{known ? index + 1 : '?'}</span><div className="ranking-name"><span><i className="timeline-swatch" />{label(row.category)}</span><small>{row.events.toLocaleString()} events{metric === 'bytes' ? ' · ' + row.measuredEvents.toLocaleString() + ' sized' : ''}</small></div>
        <svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect className="ranking-track" width="100" height="8" rx="3" /><rect width={row[metric] / max * 100} height="8" rx="3" /></svg>
        <div className="ranking-value"><strong>{known ? metric === 'bytes' ? payloadSize(row.bytes) : row.events.toLocaleString() : 'Unknown'}</strong><small>{known && total ? (percent > 0 && percent < 0.1 ? '<0.1' : percent.toFixed(1)) + '% of this view' : 'Share unavailable'}</small></div>
        <button onClick={() => onInspect(row.largest?.ref ?? row.firstRef)}>{row.largest ? 'Inspect largest ↗' : 'Inspect example ↗'}</button>
      </div>;
    })}
    <p className="muted ranking-method">Size is UTF-8 bytes after compact JSON encoding of captured fields, including encoded media. Shares cover measured bytes only; unknown sizes are marked separately. Overlapping fields in one record share bytes once. Copies in other records remain separate in their evidence views. This is not a token ranking, raw log storage size, or proof of active context. {unknown ? unknown.toLocaleString() + ' captures in this view have unknown sizes. ' : ''}{omitted ? 'Additional captures exceed the index limit. ' : ''}See source coverage below.</p>
  </section>;
}
