import { useEffect, useState } from 'react';
import type { CompactionMarker, Overview, SourceRef, UsageChartPage, UsageChartPoint, UsageJump } from '../core/types';
import { api } from './api';
import './styles.css';

const pageSize = 200;
const chart = { left: 82, right: 860, top: 40, bottom: 228, gap: 285, height: 350 };
const shown = (value: number | null): string => value === null ? 'Unknown' : value.toLocaleString();
const markerMetadata = (marker: CompactionMarker): string[] => {
  const metadata = marker.metadata;
  return [
    metadata.preTokens === undefined ? undefined : 'Pre-compaction runtime counter: ' + metadata.preTokens.toLocaleString(),
    metadata.postTokens === undefined ? undefined : 'Post-compaction runtime counter: ' + metadata.postTokens.toLocaleString(),
    metadata.cumulativeDroppedTokens === undefined ? undefined : 'Recorded cumulative dropped-token counter: ' + metadata.cumulativeDroppedTokens.toLocaleString(),
    metadata.durationMs === undefined ? undefined : 'Recorded compaction duration: ' + metadata.durationMs.toLocaleString() + ' ms',
    metadata.replacementHistoryCount === undefined ? undefined : 'Recorded replacement-history entries: ' + metadata.replacementHistoryCount,
    metadata.preservedMessageCount === undefined ? undefined : 'Recorded preserved-message entries: ' + metadata.preservedMessageCount,
    metadata.discoveredToolCount === undefined ? undefined : 'Pre-compaction discovered-tool entries: ' + metadata.discoveredToolCount + ' (runtime listing; request inclusion unknown)',
    metadata.recordedWindowNumber === undefined ? undefined : 'Recorded window number: ' + metadata.recordedWindowNumber,
    metadata.trigger ? 'Recorded trigger: ' + metadata.trigger : undefined,
    metadata.flags ? Object.entries(metadata.flags).map(([key, value]) => key + ': ' + value).join(' · ') : undefined,
  ].filter((value): value is string => Boolean(value));
};

function inputLabel(point: UsageChartPoint): string {
  return 'Response ' + point.ordinal + ', line ' + point.firstLine + ', ' + (point.input === null ? 'input gap' : point.input.toLocaleString() + ' reported input tokens');
}

function activateOnKeyboard(event: React.KeyboardEvent<SVGCircleElement | SVGGElement>, activate: () => void): void {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
}

export function UsageChart({ overview, onInspect, onShowPoint, onShowCompaction }: {
  overview: Overview;
  onInspect: (ref: SourceRef) => void;
  onShowPoint: (jump: UsageJump) => void;
  onShowCompaction: (marker: CompactionMarker) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [after, setAfter] = useState(0);
  const [page, setPage] = useState<UsageChartPage>();
  const [selected, setSelected] = useState<{ kind: 'point' | 'compaction'; id: string }>();
  const [error, setError] = useState('');

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
        if (!value.coverage.scanComplete) refreshTimer = setTimeout(() => { void load(); }, 700);
      } catch (failure) {
        if (!controller.signal.aborted) setError((failure as Error).message);
      }
    };
    void load();
    return () => { controller.abort(); if (refreshTimer) clearTimeout(refreshTimer); };
  }, [expanded, after, overview.id, overview.state]);

  const point = page?.points.find(item => selected?.kind === 'point' && item.id === selected.id);
  const compaction = page?.compactions.find(item => selected?.kind === 'compaction' && item.id === selected.id);
  const gaps = page?.points.filter(item => item.input === null) ?? [];
  const maxInput = Math.max(0, ...(page?.points.map(item => item.input).filter((value): value is number => value !== null) ?? []));
  const x = (line: number): number => page && page.sourceRange.lastLine > page.sourceRange.firstLine
    ? chart.left + (line - page.sourceRange.firstLine) / (page.sourceRange.lastLine - page.sourceRange.firstLine) * (chart.right - chart.left)
    : (chart.left + chart.right) / 2;
  const y = (input: number): number => maxInput === 0 ? chart.bottom : chart.bottom - input / maxInput * (chart.bottom - chart.top);
  const yTicks = maxInput === 0 ? [0] : [0, 1, 2, 3, 4].map(index => Math.round(maxInput * index / 4));
  const pointDescription = (item: UsageChartPoint): string => inputLabel(item) + '. ' + item.reason + '. ' + item.status + ' identity.';

  function showPoint(item: UsageChartPoint): void {
    if (!item.observation.responseNavigation) return;
    onShowPoint({ sessionId: overview.id, navigation: item.observation.responseNavigation,
      values: item.observation.values, ref: item.observation.ref, status: item.status, identityDetail: item.identityDetail });
  }

  return <details className="usage-chart-panel" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>Provider input by source line <span className="usage-chart-summary-note">Reported input · whole retained recording</span></summary>
    <div className="usage-chart-body">
      <p className="muted">Each filled circle is one resolved recorded response group with reported input. Open circles are missing, unassigned, or conflicting observations. The x-axis is physical source line; the y-axis is provider-reported input tokens, not active context. The chart ignores the conversation category filter.</p>
      <p className="muted">{overview.source.family === 'claude' ? 'Claude input total adds recorded input_tokens, cache_read_input_tokens, and cache_creation_input_tokens.' : overview.source.family === 'codex' ? 'Codex input uses recorded input_tokens; cached_input_tokens is already included.' : 'Provider input arithmetic is unavailable for this recording.'}</p>
      {error ? <p className="error" role="alert">{error}</p> : !page ? <p className="notice">Loading provider usage and compaction evidence…</p> : <>
        <div className="usage-chart-scope"><span>Whole retained recording · responses {page.points.length ? page.points[0]!.ordinal.toLocaleString() + '–' + page.points.at(-1)!.ordinal.toLocaleString() : 'none on this page'} of {page.total.toLocaleString()}</span><span>Source lines {page.sourceRange.firstLine.toLocaleString()}–{page.sourceRange.lastLine.toLocaleString()}</span></div>
        <div className="usage-chart-selectors">
          <label>Choose response point
            <select value={selected?.kind === 'point' ? selected.id : ''} onChange={event => setSelected(event.target.value ? { kind: 'point', id: event.target.value } : undefined)}>
              <option value="">Select a response in this page</option>
              {page.points.map(item => <option key={item.id} value={item.id}>{inputLabel(item)}</option>)}
            </select>
          </label>
          <label>Choose compaction evidence
            <select value={selected?.kind === 'compaction' ? selected.id : ''} onChange={event => setSelected(event.target.value ? { kind: 'compaction', id: event.target.value } : undefined)}>
              <option value="">Select a marker in this page</option>
              {page.compactions.map(item => <option key={item.id} value={item.id}>{item.label} · line {item.ref.line}</option>)}
            </select>
          </label>
        </div>
        <div className="usage-chart-scroll" role="region" aria-label="Provider input chart; scroll horizontally on narrow screens" tabIndex={0}>
          <svg className="usage-chart-svg" viewBox={'0 0 900 ' + chart.height} role="group" aria-label="Disconnected provider input points, gaps, and compaction markers by physical source line">
            <text className="usage-chart-axis-title" x="20" y="22">Reported input tokens</text>
            <text className="usage-chart-axis-title" x={(chart.left + chart.right) / 2} y="344" textAnchor="middle">Physical source line</text>
            {yTicks.map((tick, index) => {
              const tickY = maxInput === 0 ? chart.bottom : chart.bottom - tick / maxInput * (chart.bottom - chart.top);
              return <g key={index}><line className="usage-chart-grid" x1={chart.left} x2={chart.right} y1={tickY} y2={tickY} /><text className="usage-chart-tick" x={chart.left - 10} y={tickY + 4} textAnchor="end">{tick.toLocaleString()}</text></g>;
            })}
            <line className="usage-chart-axis" x1={chart.left} x2={chart.left} y1={chart.top} y2={chart.bottom} />
            <line className="usage-chart-axis" x1={chart.left} x2={chart.right} y1={chart.bottom} y2={chart.bottom} />
            <text className="usage-chart-tick" x={chart.left} y="247" textAnchor="middle">{page.sourceRange.firstLine.toLocaleString()}</text>
            <text className="usage-chart-tick" x={chart.right} y="247" textAnchor="middle">{page.sourceRange.lastLine.toLocaleString()}</text>
            <text className="usage-chart-rail-label" x={chart.left - 10} y={chart.gap + 4} textAnchor="end">Gaps</text>
            <line className="usage-chart-gap-rail" x1={chart.left} x2={chart.right} y1={chart.gap} y2={chart.gap} />
            <text className="usage-chart-rail-label" x={chart.right} y="20" textAnchor="end">Compaction evidence</text>
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
              if (item.input === null) return <circle key={item.id} className={'usage-chart-gap ' + (selectedPoint ? 'selected' : '')} cx={x(item.firstLine)} cy={chart.gap} r={selectedPoint ? 7 : 5}
                role="button" tabIndex={0} aria-label={pointDescription(item)} aria-pressed={selectedPoint} onClick={() => setSelected({ kind: 'point', id: item.id })} onKeyDown={event => activateOnKeyboard(event, () => setSelected({ kind: 'point', id: item.id }))}><title>{pointDescription(item)}</title></circle>;
              return <circle key={item.id} className={'usage-chart-point ' + (selectedPoint ? 'selected' : '')} cx={x(item.firstLine)} cy={y(item.input)} r={selectedPoint ? 7 : 5}
                role="button" tabIndex={0} aria-label={pointDescription(item)} aria-pressed={selectedPoint} onClick={() => setSelected({ kind: 'point', id: item.id })} onKeyDown={event => activateOnKeyboard(event, () => setSelected({ kind: 'point', id: item.id }))}><title>{pointDescription(item)}</title></circle>;
            })}
          </svg>
        </div>
        <div className="usage-chart-legend"><span><i className="usage-chart-legend-point" />Resolved reported input</span><span><i className="usage-chart-legend-gap" />Gap on separate rail</span><span><i className="usage-chart-legend-compaction" />Recorded compaction evidence</span></div>
        {gaps.length ? <div className="usage-chart-gaps" aria-label="Selectable unresolved input gaps">{gaps.map(item => <button key={item.id} className={selected?.kind === 'point' && selected.id === item.id ? 'selected' : ''} aria-pressed={selected?.kind === 'point' && selected.id === item.id} onClick={() => setSelected({ kind: 'point', id: item.id })}>Gap · response {item.ordinal} · line {item.firstLine}</button>)}</div> : null}
        {point ? <section className="usage-chart-evidence" aria-live="polite" aria-label="Selected response usage evidence">
          <div><span className="section-label">Response {point.ordinal} · line {point.firstLine}</span><h3>{point.input === null ? 'Input value not plotted' : shown(point.input) + ' reported input tokens'}</h3></div>
          <p>{point.reason}</p>
          <p className="muted">Status: {point.status}. Actor: <span className="path">{point.actorId}</span>{point.model ? ' · Model: ' + point.model : ' · Model unknown'}. {point.identityDetail}</p>
          <p className="muted">First retained observation at line {point.ref.line}; {point.variantCount} retained variant{point.variantCount === 1 ? '' : 's'} and {point.retainedRefs} retained reference{point.retainedRefs === 1 ? '' : 's'} across the group. {point.observation.matchingRefs} reference{point.observation.matchingRefs === 1 ? '' : 's'} match{point.observation.matchingRefs === 1 ? 'es' : ''} that first observation. Timeline navigation uses that observation only.</p>
          <p className="muted">First observation fields: input {shown(point.observation.values.input)} · output {shown(point.observation.values.output)} · cache read {shown(point.observation.values.cached)} · cache creation {shown(point.observation.values.cacheCreation)}.</p>
          <div className="pager usage-chart-actions"><button disabled={!point.observation.responseNavigation} onClick={() => showPoint(point)}>Show in timeline</button><button disabled={!point.sourceAvailable} onClick={() => onInspect(point.ref)}>Inspect source</button></div>
        </section> : null}
        {compaction ? <section className="usage-chart-evidence" aria-live="polite" aria-label="Selected compaction evidence">
          <div><span className="section-label">Line {compaction.ref.line}</span><h3>{compaction.label}</h3></div>
          <p>{compaction.boundary === 'representation' ? 'Recorded compaction representation; it does not by itself prove a boundary.' : 'Recorded compaction evidence. Its runtime counters are separate from provider-reported input.'}</p>
          <p className="muted">Kind: {compaction.kind}. Source line {compaction.ref.line}. {compaction.target ? 'A timeline event from this same physical record is available.' : 'No timeline event from this physical record was retained.'}</p>
          {markerMetadata(compaction).map(value => <p className="muted" key={value}>{value}</p>)}
          <div className="pager usage-chart-actions"><button disabled={!compaction.target} onClick={() => onShowCompaction(compaction)}>Show in timeline</button><button onClick={() => onInspect(compaction.ref)}>Inspect source</button></div>
        </section> : null}
        {!point && !compaction && page.points.length === 0 && page.compactions.length === 0 ? <p className="notice">{page.coverage.retainedCalls === 0 && page.coverage.runtimeCounterRecords > 0
          ? 'No provider-response usage groups are retained; ' + page.coverage.runtimeCounterRecords.toLocaleString() + ' runtime token-counter records remain separate evidence and are not plotted as input.'
          : 'No provider-response usage or supported compaction evidence is retained in this range. Runtime counters are not substituted for input points.'}</p> : null}
        {page.points.length === 0 && page.compactions.length > 0 ? <p className="notice">No provider usage groups are retained. The markers below remain independent runtime or representation evidence.</p> : null}
        {page.compactions.length === 0 && page.coverage.retainedCompactions === 0 && !page.coverage.compactionCaptureComplete ? <p className="notice">Compaction coverage is incomplete; inspect source coverage for unsupported, unknown, pending, or limited records.</p> : null}
        <div className="usage-chart-pager">
          <button disabled={!after} onClick={() => setAfter(Math.max(0, after - pageSize))}>Previous responses</button>
          <span>{page.total ? 'Showing ' + (after + 1).toLocaleString() + '–' + (after + page.points.length).toLocaleString() + ' of ' + page.total.toLocaleString() : 'No retained response groups'}</span>
          <button disabled={page.after === undefined} onClick={() => setAfter(page.after!)}>Next responses</button>
        </div>
        {page.omittedCompactions ? <p className="muted">{page.omittedCompactions.toLocaleString()} additional retained markers in this source range are omitted by the {page.coverage.markerPageLimit}-marker page limit.</p> : null}
        <div className="usage-chart-coverage" aria-label="Input chart coverage">
          <p>{page.coverage.scanComplete ? 'Source scan complete.' : 'Source scan is in progress; this page refreshes automatically.'} {page.coverage.indexComplete ? 'Physical source index covers all scanned records.' : 'Physical source index is incomplete or capped.'}</p>
          <p>{page.coverage.usageComplete ? 'Supported usage index is complete within this snapshot.' : 'Supported usage index has coverage limits.'} Retained groups: {page.coverage.retainedCalls.toLocaleString()}{page.coverage.usageLimited ? '; a usage retention cap was reached' : ''}. Limits: {page.coverage.usageCallLimit.toLocaleString()} groups, {page.coverage.usageReferenceLimit} matching references per variant, {page.coverage.usageVariantLimit} variants per group, {page.coverage.pointPageLimit} points per page. Runtime counter records kept separate: {page.coverage.runtimeCounterRecords.toLocaleString()}.</p>
          <p>{page.coverage.compactionCaptureComplete ? 'Supported compaction capture is complete within indexed coverage.' : 'Compaction capture is incomplete or limited.'} Retained markers: {page.coverage.retainedCompactions.toLocaleString()}; omitted captures: {page.coverage.omittedCompactionCaptures.toLocaleString()} of {page.coverage.compactionCaptureLimit.toLocaleString()} retained maximum; {page.coverage.markerPageLimit} markers per page.</p>
          {(page.coverage.unknownRecords || page.coverage.malformedRecords || page.coverage.limitedRecords || page.coverage.pendingRecords || page.coverage.sourceFamily === 'unknown') ? <p>Coverage qualifications: family {page.coverage.sourceFamily}; unknown {page.coverage.unknownRecords}, malformed {page.coverage.malformedRecords}, over-limit {page.coverage.limitedRecords}, pending {page.coverage.pendingRecords}; indexed {page.coverage.indexedRecords.toLocaleString()} records, scanned {page.coverage.scannedLines.toLocaleString()} complete lines of {page.coverage.sourceEndLine.toLocaleString()}.</p> : null}
        </div>
      </>}
    </div>
  </details>;
}
