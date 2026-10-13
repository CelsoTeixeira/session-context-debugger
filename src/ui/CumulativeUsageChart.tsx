import { useEffect, useState } from 'react';
import type { CompactionMarker, Overview, SourceRef, UsageChartPage, UsageChartPoint, UsageJump, UsageValues } from '../core/types';
import { api } from './api';
import './styles.css';

const pageSize = 200;
const chart = { left: 82, right: 860, top: 40, bottom: 228, gap: 285, height: 350 };
const metrics: Array<{ key: keyof UsageValues; label: string }> = [
  { key: 'input', label: 'Input' }, { key: 'output', label: 'Output' },
  { key: 'cached', label: 'Cache read' }, { key: 'cacheCreation', label: 'Cache creation' },
];
const shown = (value: number | null): string => value === null ? 'Unknown' : value.toLocaleString();

type Selection = { kind: 'point' | 'compaction'; id: string };

function plottedValue(point: UsageChartPoint, metric: keyof UsageValues): number | undefined {
  const field = point.cumulative.fields[metric];
  return field.measured && !field.overflow && field.tokens !== null ? field.tokens : undefined;
}

function cumulativeSegments(points: UsageChartPoint[], metric: keyof UsageValues): UsageChartPoint[][] {
  const segments: UsageChartPoint[][] = [];
  let current: UsageChartPoint[] = [];
  for (const point of points) {
    if (plottedValue(point, metric) === undefined) {
      if (current.length) segments.push(current);
      current = [];
    } else current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}

function activateOnKeyboard(event: React.KeyboardEvent<SVGCircleElement | SVGGElement>, activate: () => void): void {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
}

export function CumulativeUsageChart({ overview, onInspect, onShowPoint, onShowCompaction }: {
  overview: Overview;
  onInspect: (ref: SourceRef) => void;
  onShowPoint: (jump: UsageJump) => void;
  onShowCompaction: (marker: CompactionMarker) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [after, setAfter] = useState(0);
  const [metric, setMetric] = useState<keyof UsageValues>('input');
  const [page, setPage] = useState<UsageChartPage>();
  const [selected, setSelected] = useState<Selection>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setPage(undefined);
    setError('');
    const load = async () => {
      try {
        const value = await api<UsageChartPage>('/api/sessions/' + overview.id + '/usage-chart?' + new URLSearchParams({ after: String(after) }), { signal: controller.signal });
        if (controller.signal.aborted) return;
        setPage(value);
        if (overview.state === 'indexing') refreshTimer = setTimeout(() => { void load(); }, 700);
      } catch (failure) {
        if (!controller.signal.aborted) setError((failure as Error).message);
      }
    };
    void load();
    return () => { controller.abort(); if (refreshTimer) clearTimeout(refreshTimer); };
  }, [expanded, after, overview.id, overview.state, reload]);

  const point = page?.points.find(item => selected?.kind === 'point' && item.id === selected.id);
  const compaction = page?.compactions.find(item => selected?.kind === 'compaction' && item.id === selected.id);
  const segments = cumulativeSegments(page?.points ?? [], metric);
  const plottedPoints = page?.points.filter(item => plottedValue(item, metric) !== undefined) ?? [];
  const gaps = page?.points.filter(item => plottedValue(item, metric) === undefined) ?? [];
  const maxSubtotal = Math.max(0, ...plottedPoints.map(item => plottedValue(item, metric)!));
  const x = (line: number): number => page && page.sourceRange.lastLine > page.sourceRange.firstLine
    ? chart.left + (line - page.sourceRange.firstLine) / (page.sourceRange.lastLine - page.sourceRange.firstLine) * (chart.right - chart.left)
    : (chart.left + chart.right) / 2;
  const y = (value: number): number => maxSubtotal === 0 ? chart.bottom : chart.bottom - value / maxSubtotal * (chart.bottom - chart.top);
  const yTicks = maxSubtotal === 0 ? [0] : [0, 1, 2, 3, 4].map(index => Math.round(maxSubtotal * index / 4));
  const metricLabel = metrics.find(item => item.key === metric)!.label;
  const pointDescription = (item: UsageChartPoint): string => {
    const field = item.cumulative.fields[metric];
    const value = plottedValue(item, metric);
    const detail = value !== undefined ? shown(value) + ' cumulative known ' + metricLabel.toLowerCase() + ' tokens'
      : field.overflow ? 'running subtotal overflow; no plotted value'
        : item.status !== 'resolved' || item.variantCount !== 1 ? 'excluded or conflicting measurement gap'
          : 'no supported measurement for this field';
    return 'Response ' + item.ordinal + ', line ' + item.firstLine + ', ' + detail + '. ' + item.status + ' identity.';
  };

  function showPoint(item: UsageChartPoint): void {
    if (!item.observation.responseNavigation) return;
    onShowPoint({ sessionId: overview.id, navigation: item.observation.responseNavigation,
      values: item.observation.values, ref: item.observation.ref, status: item.status, identityDetail: item.identityDetail });
  }

  return <details className="usage-chart-panel" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>Cumulative recorded usage <span className="usage-chart-summary-note">Known subtotals · retained source order</span></summary>
    <div className="usage-chart-body">
      <p className="muted">Choose one provider-reported field at a time. Subtotals carry across pages and recorded compaction markers; compaction evidence does not reset them. Missing, conflicting, unsupported, and overflow rows remain selectable gaps and break the plotted segment. A later measured row resumes with the partial known subtotal and coverage shown.</p>
      <p className="muted">Cache read is a separate field and is not added again to input. Reasoning remains an output subcomponent in the evidence and is not a separate chart. These source-order prefixes do not describe wall-clock activity, billing, or active-context size. Runtime counters stay separate.</p>
      {overview.source.family === 'unknown' ? <p className="notice">Provider family is unknown; only supported recorded provider measurements can contribute.</p> : null}
      {error ? <p className="error" role="alert">{error} <button onClick={() => setReload(value => value + 1)}>Retry</button></p> : !page ? <p className="notice">Loading cumulative provider usage…</p> : <>
        {overview.state === 'indexing' ? <p className="notice" role="status">Indexing continues; this page refreshes while the recording is being indexed.</p> : null}
        <div className="usage-chart-scope"><span>Whole retained recording · responses {page.points.length ? page.points[0]!.ordinal.toLocaleString() + '–' + page.points.at(-1)!.ordinal.toLocaleString() : 'none on this page'} of {page.total.toLocaleString()}</span><span>Source lines {page.sourceRange.firstLine.toLocaleString()}–{page.sourceRange.lastLine.toLocaleString()}</span></div>
        <div className="usage-chart-selectors">
          <label>Choose cumulative field
            <select value={metric} disabled={!page.points.length} onChange={event => setMetric(event.target.value as keyof UsageValues)}>
              {metrics.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </label>
          <label>Choose response point
            <select value={selected?.kind === 'point' ? selected.id : ''} disabled={!page.points.length} onChange={event => setSelected(event.target.value ? { kind: 'point', id: event.target.value } : undefined)}>
              <option value="">Select a response in this page</option>
              {page.points.map(item => <option key={item.id} value={item.id}>{pointDescription(item)}</option>)}
            </select>
          </label>
          <label>Choose compaction evidence
            <select value={selected?.kind === 'compaction' ? selected.id : ''} disabled={!page.compactions.length} onChange={event => setSelected(event.target.value ? { kind: 'compaction', id: event.target.value } : undefined)}>
              <option value="">Select a marker in this page</option>
              {page.compactions.map(item => <option key={item.id} value={item.id}>{item.label} · line {item.ref.line}</option>)}
            </select>
          </label>
        </div>
        <div className="usage-chart-scroll" role="region" aria-label="Cumulative recorded usage chart; scroll horizontally on narrow screens" tabIndex={0}>
          <svg className="usage-chart-svg" viewBox={'0 0 900 ' + chart.height} role="group" aria-label={'Disconnected cumulative known ' + metricLabel.toLowerCase() + ' subtotals, gaps, and compaction markers by physical source line'}>
            <text className="usage-chart-axis-title" x="20" y="22">Cumulative known {metricLabel.toLowerCase()} tokens</text>
            <text className="usage-chart-axis-title" x={(chart.left + chart.right) / 2} y="344" textAnchor="middle">Physical source line</text>
            {yTicks.map((tick, index) => {
              const tickY = maxSubtotal === 0 ? chart.bottom : chart.bottom - tick / maxSubtotal * (chart.bottom - chart.top);
              return <g key={index}><line className="usage-chart-grid" x1={chart.left} x2={chart.right} y1={tickY} y2={tickY} /><text className="usage-chart-tick" x={chart.left - 10} y={tickY + 4} textAnchor="end">{tick.toLocaleString()}</text></g>;
            })}
            <line className="usage-chart-axis" x1={chart.left} x2={chart.left} y1={chart.top} y2={chart.bottom} />
            <line className="usage-chart-axis" x1={chart.left} x2={chart.right} y1={chart.bottom} y2={chart.bottom} />
            <text className="usage-chart-tick" x={chart.left} y="247" textAnchor="middle">{page.sourceRange.firstLine.toLocaleString()}</text>
            <text className="usage-chart-tick" x={chart.right} y="247" textAnchor="middle">{page.sourceRange.lastLine.toLocaleString()}</text>
            <text className="usage-chart-rail-label" x={chart.left - 10} y={chart.gap + 4} textAnchor="end">Gaps</text>
            <line className="usage-chart-gap-rail" x1={chart.left} x2={chart.right} y1={chart.gap} y2={chart.gap} />
            <text className="usage-chart-rail-label" x={chart.right} y="20" textAnchor="end">Compaction evidence</text>
            {segments.filter(segment => segment.length > 1).map((segment, index) => <path key={index} className="cumulative-usage-segment"
              d={segment.map((item, pointIndex) => (pointIndex ? 'L' : 'M') + x(item.firstLine) + ' ' + y(plottedValue(item, metric)!).toFixed(2)).join(' ')} />)}
            {page.compactions.map(marker => {
              const selectedMarker = selected?.kind === 'compaction' && selected.id === marker.id;
              const center = x(marker.ref.line);
              const description = marker.label + ', line ' + marker.ref.line + (marker.boundary === 'representation' ? ', representation only' : ', recorded compaction boundary');
              return <g key={marker.id} className={'usage-chart-compaction ' + (selectedMarker ? 'selected' : '')} role="button" tabIndex={0} aria-label={description} aria-pressed={selectedMarker} onClick={() => setSelected({ kind: 'compaction', id: marker.id })} onKeyDown={event => activateOnKeyboard(event, () => setSelected({ kind: 'compaction', id: marker.id }))}>
                <rect x={center - 8} y="25" width="16" height={chart.bottom - 25} fill="transparent" pointerEvents="all" aria-hidden="true" />
                <line x1={center} x2={center} y1="25" y2={chart.bottom} strokeDasharray="4 4" />
                <polygon points={`${center},${chart.top - 10} ${center + 7},${chart.top - 3} ${center},${chart.top + 4} ${center - 7},${chart.top - 3}`} />
                <title>{description}</title>
              </g>;
            })}
            {page.points.map(item => {
              const selectedPoint = selected?.kind === 'point' && selected.id === item.id;
              const value = plottedValue(item, metric);
              const description = pointDescription(item);
              if (value === undefined) return <circle key={item.id} className={'usage-chart-gap ' + (selectedPoint ? 'selected' : '')} cx={x(item.firstLine)} cy={chart.gap} r={selectedPoint ? 7 : 5}
                role="button" tabIndex={0} aria-label={description} aria-pressed={selectedPoint} onClick={() => setSelected({ kind: 'point', id: item.id })} onKeyDown={event => activateOnKeyboard(event, () => setSelected({ kind: 'point', id: item.id }))}><title>{description}</title></circle>;
              return <circle key={item.id} className={'usage-chart-point ' + (selectedPoint ? 'selected' : '')} cx={x(item.firstLine)} cy={y(value)} r={selectedPoint ? 7 : 5}
                role="button" tabIndex={0} aria-label={description} aria-pressed={selectedPoint} onClick={() => setSelected({ kind: 'point', id: item.id })} onKeyDown={event => activateOnKeyboard(event, () => setSelected({ kind: 'point', id: item.id }))}><title>{description}</title></circle>;
            })}
          </svg>
        </div>
        <div className="usage-chart-legend"><span><i className="usage-chart-legend-point" />Measured cumulative subtotal</span><span><i className="cumulative-usage-legend-line" />Connected source-order segment</span><span><i className="usage-chart-legend-gap" />Missing or unplottable gap</span><span><i className="usage-chart-legend-compaction" />Separate compaction evidence</span></div>
        {gaps.length ? <div className="usage-chart-gaps" aria-label="Selectable cumulative usage gaps">{gaps.map(item => <button key={item.id} className={selected?.kind === 'point' && selected.id === item.id ? 'selected' : ''} aria-pressed={selected?.kind === 'point' && selected.id === item.id} onClick={() => setSelected({ kind: 'point', id: item.id })}>Gap · response {item.ordinal} · line {item.firstLine}</button>)}</div> : null}
        {point ? (() => {
          const field = point.cumulative.fields[metric];
          const currentValue = point.observation.values[metric];
          const resolved = point.status === 'resolved' && point.variantCount === 1;
          const plotted = plottedValue(point, metric);
          const last = field.lastEligible;
          return <section className="usage-chart-evidence" aria-live="polite" aria-label="Selected cumulative usage evidence">
            <div><span className="section-label">Response {point.ordinal} · line {point.firstLine}</span><h3>{plotted === undefined ? 'Selected cumulative point is a gap' : shown(plotted) + ' cumulative known ' + metricLabel.toLowerCase() + ' tokens'}</h3></div>
            <p>{resolved ? field.measured ? 'Original measured contribution for this field: ' + shown(currentValue) + ' tokens.' : 'This resolved group has no supported measurement for this field; it contributes no plotted point.'
              : 'This group is excluded from resolved subtotals. Its retained variant values remain evidence and are not selected as a contribution.'}</p>
            <p>Derived subtotal through this source group: {field.overflow ? 'Unknown; safe-integer overflow is sticky.' : shown(field.tokens) + ' tokens'}{!field.overflow ? ' Known subtotal may be partial because some groups have no supported field measurement or were excluded.' : ''} It is not a source-native accumulated measurement.</p>
            <p>Coverage through this group for {metricLabel.toLowerCase()}: {field.calls.toLocaleString()} eligible field measurements among {point.cumulative.includedCalls.toLocaleString()} included groups; {Math.max(0, point.cumulative.includedCalls - field.calls).toLocaleString()} included groups have no supported value for this field; {point.cumulative.excludedCalls.toLocaleString()} groups are excluded as ambiguous or unassigned.</p>
            <p className="muted">Status: {point.status}. Actor: <span className="path">{point.actorId}</span>{point.model ? ' · Model: ' + point.model : ' · Model unknown'}. {point.identityDetail}</p>
            <p className="muted">First retained observation at line {point.ref.line}; {point.variantCount} retained variant{point.variantCount === 1 ? '' : 's'} and {point.retainedRefs} retained reference{point.retainedRefs === 1 ? '' : 's'} across the group. {point.observation.matchingRefs} reference{point.observation.matchingRefs === 1 ? '' : 's'} match{point.observation.matchingRefs === 1 ? 'es' : ''} the first observation. Timeline navigation uses that observation only.</p>
            <p className="muted">{resolved ? 'Original observation fields:' : 'First retained variant fields, excluded from totals:'} input {shown(point.observation.values.input)} · output {shown(point.observation.values.output)} · cache read {shown(point.observation.values.cached)} · cache creation {shown(point.observation.values.cacheCreation)} · reasoning {shown(point.observation.values.reasoning)}. Reasoning remains an output subcomponent.</p>
            {last ? <p className="muted">Last eligible {metricLabel.toLowerCase()} evidence: line {last.ref.line}; source record {last.sourceAvailable ? 'retained for inspection' : 'unavailable within retained source coverage'}.</p> : <p className="muted">No eligible {metricLabel.toLowerCase()} observation has been recorded through this group.</p>}
            <div className="pager usage-chart-actions"><button disabled={!point.observation.responseNavigation} onClick={() => showPoint(point)}>Show in timeline</button><button disabled={!point.sourceAvailable} onClick={() => onInspect(point.ref)}>Inspect first observation</button>{last ? <button disabled={!last.sourceAvailable} onClick={() => onInspect(last.ref)}>Inspect last eligible evidence</button> : null}</div>
          </section>;
        })() : null}
        {compaction ? <section className="usage-chart-evidence" aria-live="polite" aria-label="Selected compaction evidence">
          <div><span className="section-label">Line {compaction.ref.line}</span><h3>{compaction.label}</h3></div>
          <p>{compaction.boundary === 'representation' ? 'Recorded compaction representation; it does not by itself prove a boundary.' : 'Recorded compaction evidence. Runtime counters remain separate from provider usage and do not reset this subtotal.'}</p>
          <p className="muted">Kind: {compaction.kind}. Source line {compaction.ref.line}. {compaction.target ? 'A timeline event from this same physical record is available.' : 'No timeline event from this physical record was retained.'}</p>
          <div className="pager usage-chart-actions"><button disabled={!compaction.target} onClick={() => onShowCompaction(compaction)}>Show in timeline</button><button onClick={() => onInspect(compaction.ref)}>Inspect source</button></div>
        </section> : null}
        {page.points.length === 0 && page.compactions.length === 0 ? <p className="notice">{page.total === 0 && page.coverage.runtimeCounterRecords > 0
          ? 'No provider-response usage groups are retained; ' + page.coverage.runtimeCounterRecords.toLocaleString() + ' runtime counter records remain separate evidence and are not substituted.'
          : page.total === 0 ? 'No provider-response usage groups are retained in this recording.' : 'No retained usage observations with source references are available on this page.'}</p> : null}
        {page.points.length === 0 && page.compactions.length > 0 ? <p className="notice">No provider usage groups are retained on this page. Compaction evidence remains separate and does not reset cumulative subtotals.</p> : null}
        {page.coverage.compactionCaptureComplete === false && page.coverage.retainedCompactions === 0 ? <p className="notice">Compaction coverage is incomplete; inspect source coverage for unsupported, unknown, pending, or limited records.</p> : null}
        <div className="usage-chart-pager">
          <button disabled={!after} onClick={() => setAfter(Math.max(0, after - pageSize))}>Previous responses</button>
          <span>{page.total ? page.points.length ? 'Showing ' + page.points[0]!.ordinal.toLocaleString() + '–' + page.points.at(-1)!.ordinal.toLocaleString() + ' of ' + page.total.toLocaleString() : 'No source-linked groups on this page of ' + page.total.toLocaleString() : 'No retained response groups'}</span>
          <button disabled={page.after === undefined} onClick={() => setAfter(page.after!)}>Next responses</button>
        </div>
        {page.omittedCompactions ? <p className="muted">{page.omittedCompactions.toLocaleString()} additional retained markers in this source range are omitted by the {page.coverage.markerPageLimit}-marker page limit.</p> : null}
        <div className="usage-chart-coverage" aria-label="Cumulative usage coverage">
          <p>{page.coverage.scanComplete ? 'Source scan complete.' : 'Source scan is incomplete.'} {page.coverage.indexComplete ? 'Physical source index covers all scanned records.' : 'Physical source index is incomplete or capped.'} Prefix values use the full retained source-ordered group list, not only this page.</p>
          <p>{page.coverage.usageComplete ? 'Supported usage index is complete within this snapshot.' : 'Supported usage index has coverage limits.'} Retained groups: {page.coverage.retainedCalls.toLocaleString()} of {page.coverage.usageCallLimit.toLocaleString()}; {page.coverage.usageLimited ? 'the usage retention cap was reached. ' : ''}This page shows at most {page.coverage.pointPageLimit} groups. Runtime counter records kept separate: {page.coverage.runtimeCounterRecords.toLocaleString()}.</p>
          <p>Retained compaction markers: {page.coverage.retainedCompactions.toLocaleString()}; omitted captures: {page.coverage.omittedCompactionCaptures.toLocaleString()} of {page.coverage.compactionCaptureLimit.toLocaleString()} maximum; at most {page.coverage.markerPageLimit} markers per page.</p>
          {(page.coverage.unknownRecords || page.coverage.malformedRecords || page.coverage.limitedRecords || page.coverage.pendingRecords || page.coverage.sourceFamily === 'unknown') ? <p>Coverage qualifications: family {page.coverage.sourceFamily}; unknown {page.coverage.unknownRecords}, malformed {page.coverage.malformedRecords}, over-limit {page.coverage.limitedRecords}, pending {page.coverage.pendingRecords}; indexed {page.coverage.indexedRecords.toLocaleString()} records, scanned {page.coverage.scannedLines.toLocaleString()} complete lines of {page.coverage.sourceEndLine.toLocaleString()}.</p> : null}
        </div>
      </>}
    </div>
  </details>;
}
