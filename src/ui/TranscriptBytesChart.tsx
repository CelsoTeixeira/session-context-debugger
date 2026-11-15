import { useEffect, useState } from 'react';
import type { Overview, SourceRef, TranscriptBytesPage, TranscriptBytesPoint } from '../core/types';
import { api } from './api';
import './styles.css';

type Metric = 'physical' | 'cumulative';
const chart = { left: 82, right: 860, top: 40, bottom: 228, height: 290 };
const number = (value: number): string => value.toLocaleString() + ' B';

function activateOnKeyboard(event: React.KeyboardEvent<SVGCircleElement>, activate: () => void): void {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
}

export function TranscriptBytesChart({ overview, onInspect, onNavigate }: {
  overview: Overview;
  onInspect: (ref: SourceRef) => void;
  onNavigate: (target: { id: string; position: number }) => void;
}) {
  const [after, setAfter] = useState(0);
  const [metric, setMetric] = useState<Metric>('physical');
  const [selectedId, setSelectedId] = useState('');
  const [page, setPage] = useState<TranscriptBytesPage>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setPage(undefined);
    setError('');
    const load = async () => {
      try {
        const value = await api<TranscriptBytesPage>('/api/sessions/' + overview.id + '/transcript-bytes?'
          + new URLSearchParams({ after: String(after) }), { signal: controller.signal });
        if (controller.signal.aborted) return;
        setPage(value);
        if (value.coverage.scanState === 'indexing') refreshTimer = setTimeout(() => { void load(); }, 700);
      } catch (failure) {
        if (!controller.signal.aborted) setError((failure as Error).message);
      }
    };
    void load();
    return () => { controller.abort(); if (refreshTimer) clearTimeout(refreshTimer); };
  }, [after, overview.id, overview.state, reload]);

  const points = page?.points ?? [];
  const selected = points.find(point => point.id === selectedId) ?? points[0];
  const valueOf = (point: TranscriptBytesPoint): number => metric === 'physical' ? point.physicalBytes : point.cumulativePhysicalBytes;
  const maxValue = Math.max(0, ...points.map(valueOf));
  const x = (point: TranscriptBytesPoint): number => points.length > 1
    ? chart.left + (point.ordinal - points[0]!.ordinal) / (points.at(-1)!.ordinal - points[0]!.ordinal) * (chart.right - chart.left)
    : (chart.left + chart.right) / 2;
  const y = (value: number): number => maxValue === 0 ? chart.bottom : chart.bottom - value / maxValue * (chart.bottom - chart.top);
  const ticks = maxValue === 0 ? [0] : [0, 1, 2, 3, 4].map(index => Math.round(maxValue * index / 4));
  const metricLabel = metric === 'physical' ? 'Physical record bytes' : 'Cumulative physical bytes';

  function select(point: TranscriptBytesPoint): void { setSelectedId(point.id); }

  return <section className="usage-chart-panel" aria-label="Transcript bytes">
    <div className="panel-heading"><div><h2>Transcript bytes</h2><span className="usage-chart-summary-note">Recorded file bytes · separate from captured payload bytes and active context</span></div></div>
    <div className="usage-chart-body">
      <details className="measurement-methodology"><summary>About this measurement</summary>
        <p>Each physical JSONL record appears once, including metadata, unknown, malformed, oversized, and pending records. Physical size includes content plus LF/CRLF delimiter bytes; cumulative size follows the original file offsets across pages. This describes recorded file bytes, not decoded text, category payload sizes, token usage, or active-context size.</p>
      </details>
      {error ? <p className="error" role="alert">{error} <button onClick={() => setReload(value => value + 1)}>Retry</button></p> : !page ? <p className="notice" role="status">Loading recorded transcript bytes…</p> : <>
        {page.coverage.scanState === 'indexing' ? <p className="notice" role="status">Indexing continues; this page refreshes while the recording is being indexed.</p> : null}
        {page.coverage.scanState === 'cancelled' ? <p className="notice">Indexing was cancelled. Retained points cover only the records indexed before cancellation.</p> : null}
        {page.coverage.scanState === 'error' ? <p className="notice">Indexing ended with an error. Retained points cover only the records indexed before the error.</p> : null}
        <div className="usage-chart-scope"><span>{page.total.toLocaleString()} retained physical records · records {points.length ? points[0]!.ordinal.toLocaleString() + '–' + points.at(-1)!.ordinal.toLocaleString() : 'none on this page'}</span>
          <span>{page.coverage.sourceSnapshotBytes.toLocaleString()} source snapshot bytes · {page.coverage.scannedBytes.toLocaleString()} scanned</span></div>
        <div className="usage-chart-selectors">
          <label>Choose byte measure<select value={metric} onChange={event => setMetric(event.target.value as Metric)}>
            <option value="physical">Per-record physical bytes</option><option value="cumulative">Cumulative physical bytes</option>
          </select></label>
        </div>
        {points.length ? <div className="usage-chart-scroll" role="region" aria-label="Recorded file bytes by physical source record" tabIndex={0}>
          <svg className="usage-chart-svg transcript-bytes-svg" viewBox={'0 0 900 ' + chart.height} role="group" aria-label={metricLabel + ' by physical source record'}>
            <text className="usage-chart-axis-title" x="20" y="22">{metricLabel} · bytes</text>
            <text className="usage-chart-axis-title" x={(chart.left + chart.right) / 2} y="278" textAnchor="middle">Retained physical record order</text>
            {ticks.map((tick, index) => {
              const tickY = maxValue === 0 ? chart.bottom : chart.bottom - tick / maxValue * (chart.bottom - chart.top);
              return <g key={index}><line className="usage-chart-grid" x1={chart.left} x2={chart.right} y1={tickY} y2={tickY} />
                <text className="usage-chart-tick" x={chart.left - 10} y={tickY + 4} textAnchor="end">{tick.toLocaleString()}</text></g>;
            })}
            <line className="usage-chart-axis" x1={chart.left} x2={chart.left} y1={chart.top} y2={chart.bottom} />
            <line className="usage-chart-axis" x1={chart.left} x2={chart.right} y1={chart.bottom} y2={chart.bottom} />
            {metric === 'cumulative' && points.length > 1 ? <path className="cumulative-usage-segment" d={points.map((point, index) =>
              (index ? 'L' : 'M') + x(point) + ' ' + y(valueOf(point)).toFixed(2)).join(' ')} /> : null}
            {points.map(point => {
              const isSelected = selected?.id === point.id;
              const description = 'Record ' + point.ordinal + ', line ' + point.ref.line + ', ' + point.disposition
                + ', ' + number(point.physicalBytes) + ' physical bytes, ' + number(point.cumulativePhysicalBytes) + ' cumulative physical bytes';
              return <circle key={point.id} className={'usage-chart-point ' + (isSelected ? 'selected' : '')}
                cx={x(point)} cy={y(valueOf(point))} r={isSelected ? 7 : 5} role="button" tabIndex={0}
                aria-label={description} aria-pressed={isSelected} onClick={() => select(point)}
                onKeyDown={event => activateOnKeyboard(event, () => select(point))}><title>{description}</title></circle>;
            })}
          </svg>
        </div> : <p className="notice">No physical records have been retained yet for this source snapshot.</p>}
        <div className="usage-chart-selectors">
          <label>Choose physical record<select value={selected?.id ?? ''} disabled={!points.length} onChange={event => {
            const point = points.find(item => item.id === event.target.value); if (point) select(point);
          }}>
            <option value="">Select a record</option>{points.map(point => <option key={point.id} value={point.id}>
              {'Record ' + point.ordinal + ' · line ' + point.ref.line + ' · ' + point.disposition + ' · ' + number(point.physicalBytes)}
            </option>)}
          </select></label>
        </div>
        {selected ? <section className="usage-chart-evidence" aria-live="polite" aria-label="Selected transcript record byte evidence">
          <div><span className="section-label">Record {selected.ordinal} · line {selected.ref.line} · {selected.disposition}</span><h3>Recorded file bytes</h3></div>
          <div className="metrics"><div><span>Content bytes</span><strong>{number(selected.contentBytes)}</strong></div><div><span>Delimiter bytes</span><strong>{number(selected.delimiterBytes)}</strong></div>
            <div><span>Physical record bytes</span><strong>{number(selected.physicalBytes)}</strong></div><div><span>Cumulative physical bytes through record</span><strong>{number(selected.cumulativePhysicalBytes)}</strong></div></div>
          <div className="pager usage-chart-actions"><button onClick={() => onInspect(selected.ref)}>Inspect raw source ↗</button>
            <button disabled={!selected.firstEventTarget} title={!selected.firstEventTarget ? 'No timeline event was retained for this physical record.' : 'Shows the first retained event on this physical record; this is surrounding activity, not payload ownership.'}
              onClick={() => { if (selected.firstEventTarget) onNavigate(selected.firstEventTarget); }}>Show first event on timeline</button></div>
          {!selected.firstEventTarget ? <p className="muted">No timeline event target is retained for this record; raw source inspection remains available.</p>
            : <p className="muted">Timeline navigation selects the first retained event on this same physical record. It shows surrounding activity and does not assert payload ownership.</p>}
        </section> : null}
        {!points.length && page.total === 0 && page.coverage.scanState === 'ready' ? <p className="notice">This source snapshot contains no physical JSONL records.</p> : null}
        <div className="usage-chart-pager">
          <button disabled={page.before === undefined} onClick={() => setAfter(page.before!)}>Previous records</button>
          <span>{page.total ? points.length ? 'Showing records ' + points[0]!.ordinal.toLocaleString() + '–' + points.at(-1)!.ordinal.toLocaleString() + ' of ' + page.total.toLocaleString() : 'No retained records on this page of ' + page.total.toLocaleString() : 'No retained physical records'}</span>
          <button disabled={page.after === undefined} onClick={() => setAfter(page.after!)}>Next records</button>
        </div>
        <div className="usage-chart-coverage" aria-label="Transcript physical-byte coverage">
          <p>{page.coverage.physicalCoverageComplete ? 'Physical byte coverage is complete for the selected source snapshot.' : 'Physical byte coverage is incomplete for the selected source snapshot.'}
            {' '}Retained: {page.coverage.retainedPhysicalBytes.toLocaleString()} of {page.coverage.sourceSnapshotBytes.toLocaleString()} source bytes; scanned: {page.coverage.scannedBytes.toLocaleString()} bytes; unretained physical records: {page.coverage.unretainedRecords.toLocaleString()}.</p>
          <p>Pending tail: {page.coverage.pendingBytes.toLocaleString()} physical bytes across {page.coverage.pendingRecords.toLocaleString()} record(s). Unknown: {page.coverage.unknownRecords.toLocaleString()}, malformed: {page.coverage.malformedRecords.toLocaleString()}, oversized/limited normalization: {page.coverage.limitedRecords.toLocaleString()}. These dispositions qualify normalization, not the measurability of their physical bytes. At most {page.pageLimit} records are returned per page.</p>
        </div>
      </>}
    </div>
  </section>;
}
