import { useEffect, useState } from 'react';
import type { Overview, RepeatedCaptureCoverage, RepeatedCaptureGroup, RepeatedCaptureGroupsPage, RepeatedCaptureOccurrencesPage, RepeatedCaptureRepresentationFilter, SourceRef, TimelineCategory } from '../core/types';
import { api } from './api';
import { categories, payloadSize } from './CategoryRanking';
import type { TimelineTarget } from './timelineNavigation';

const representations: Array<[RepeatedCaptureRepresentationFilter, string]> = [
  ['primary', 'Primary captures'], ['diagnostic-snapshot', 'Diagnostic snapshots'], ['metadata', 'Runtime and configuration'],
  ['unknown', 'Unknown captures'], ['mirror', 'Recorded mirrors'], ['all', 'All representations'],
];
const categoryLabel = (category: TimelineCategory): string => categories.find(([key]) => key === category)?.[1] ?? category;
const representationLabel = (representation: RepeatedCaptureGroup['representation']): string =>
  representations.find(([key]) => key === representation)?.[1] ?? representation;
const scopeLabel = (group: RepeatedCaptureGroup): string => group.scope.kind === 'recorded-actor'
  ? 'Recorded actor ' + (group.scope.id ?? 'unknown')
  : group.scope.kind === 'source-actor' ? 'Source actor ' + (group.scope.id ?? 'unknown')
    : 'Selected recording scope';

export function RepeatedCaptures({ overview, onInspect, onTimelineTarget }: {
  overview: Overview;
  onInspect: (ref: SourceRef) => void;
  onTimelineTarget: (target: TimelineTarget) => void;
}) {
  const [representation, setRepresentation] = useState<RepeatedCaptureRepresentationFilter>('primary');
  const [category, setCategory] = useState<'all' | TimelineCategory>('all');
  const [after, setAfter] = useState(0);
  const [page, setPage] = useState<RepeatedCaptureGroupsPage>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const [occurrenceAfter, setOccurrenceAfter] = useState(0);
  const [occurrences, setOccurrences] = useState<RepeatedCaptureOccurrencesPage>();
  const [occurrenceError, setOccurrenceError] = useState('');
  const [occurrenceReload, setOccurrenceReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    setPage(undefined);
    setError('');
    const query = new URLSearchParams({ after: String(after), representation, category });
    const load = () => { void api<RepeatedCaptureGroupsPage>('/api/sessions/' + overview.id + '/repeated-captures?' + query, { signal: controller.signal })
      .then(value => {
        if (controller.signal.aborted) return;
        setPage(value);
        if (value.coverage.state === 'indexing') timer = window.setTimeout(load, 350);
      })
      .catch(failure => { if (!controller.signal.aborted) setError((failure as Error).message); }); };
    load();
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [overview.id, overview.state, representation, category, after, reload]);

  useEffect(() => {
    if (!selectedId) { setOccurrences(undefined); setOccurrenceError(''); return; }
    const controller = new AbortController();
    let timer: number | undefined;
    setOccurrences(undefined);
    setOccurrenceError('');
    const query = new URLSearchParams({ groupId: selectedId, after: String(occurrenceAfter) });
    const load = () => { void api<RepeatedCaptureOccurrencesPage>('/api/sessions/' + overview.id + '/repeated-captures/occurrences?' + query, { signal: controller.signal })
      .then(value => {
        if (controller.signal.aborted) return;
        setOccurrences(value);
        if (value.coverage.state === 'indexing') timer = window.setTimeout(load, 350);
      })
      .catch(failure => { if (!controller.signal.aborted) setOccurrenceError((failure as Error).message); }); };
    load();
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [overview.id, overview.state, selectedId, occurrenceAfter, occurrenceReload]);

  function changeRepresentation(value: RepeatedCaptureRepresentationFilter) {
    setRepresentation(value); setAfter(0); setSelectedId(''); setOccurrenceAfter(0); setOccurrences(undefined);
  }
  function changeCategory(value: 'all' | TimelineCategory) {
    setCategory(value); setAfter(0); setSelectedId(''); setOccurrenceAfter(0); setOccurrences(undefined);
  }
  function selectGroup(group: RepeatedCaptureGroup) {
    setSelectedId(group.id); setOccurrenceAfter(0); setOccurrences(undefined);
  }
  const coverage = page?.coverage ?? occurrences?.coverage;
  const currentGroup = occurrences?.group;
  const groups = page?.groups ?? [];
  const incompleteNotes = coverage ? coverageNotes(coverage) : [];

  return <section className="repeated-captures resource-panel" aria-label="Repeated captures">
    <div className="panel-heading"><div><h2>Repeated captures</h2><span className="muted">Exact compact-field matches within this selected recording</span></div></div>
    <p className="repeated-capture-method">Full selected-field JSON encoding · UTF-8 byte length + SHA-256 · standalone pointers only.</p>
    <div className="repeated-capture-controls">
      <label>Representation <select value={representation} onChange={event => changeRepresentation(event.target.value as RepeatedCaptureRepresentationFilter)}>
        {representations.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>Category <select value={category} onChange={event => changeCategory(event.target.value as 'all' | TimelineCategory)}>
        <option value="all">All categories</option>{categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
    </div>
    {error ? <p className="error" role="alert">{error} <button onClick={() => setReload(value => value + 1)}>Retry</button></p> : null}
    {!page && !error ? <p className="notice" role="status">Loading repeated-capture index…</p> : null}
    {coverage ? <>
      <div className="repeated-capture-counts" aria-label="Repeated capture coverage counts">
        <span>{coverage.examinedUniqueFields.toLocaleString()} unique fields examined</span>
        <span>{coverage.eligibleFields.toLocaleString()} eligible standalone fields</span>
        <span>{coverage.aliasesExcluded.toLocaleString()} pointer aliases excluded</span>
        <span>{coverage.overlapFieldsExcluded.toLocaleString()} overlapping fields excluded</span>
        <span>{coverage.indexedRecords.toLocaleString()} of {coverage.scannedRecords.toLocaleString()} records retained</span>
        <span>{coverage.candidateMetadata.toLocaleString()} / {coverage.candidateMetadataLimit.toLocaleString()} diagnostic metadata entries</span>
      </div>
      {incompleteNotes.length ? <div className="notice repeated-capture-coverage" role="status">
        <strong>{coverage.state === 'indexing' ? 'Indexing is in progress.' : coverage.state === 'cancelled' ? 'Indexing was cancelled.' : coverage.state === 'error' ? 'Indexing ended early.' : 'Comparison coverage is incomplete.'}</strong>
        <span>{incompleteNotes.join(' ')}</span>
      </div> : <p className="muted repeated-capture-scope">Compared retained physical records in this selected recording. Actor/source labels define grouping scope; they do not prove ownership.</p>}
    </> : null}
    {page && !error ? <>
      {groups.length ? <>
        <div className="repeated-capture-table-wrap">
          <table className="repeated-capture-table">
            <thead><tr><th scope="col">Evidence group</th><th scope="col">Scope</th><th scope="col">Copies</th><th scope="col">Encoded size</th></tr></thead>
            <tbody>{groups.map(group => <tr key={group.id} className={selectedId === group.id ? 'selected' : ''}>
              <td><button className="repeated-capture-select" aria-pressed={selectedId === group.id} onClick={() => selectGroup(group)}>
                <strong>{categoryLabel(group.category)}</strong><small>{representationLabel(group.representation)} · {group.role ?? 'role unknown'} · {group.kind}</small>
              </button></td>
              <td>{scopeLabel(group)}</td>
              <td>{group.occurrenceCount.toLocaleString()}{group.omittedOccurrences ? <small>{group.retainedOccurrences.toLocaleString()} source refs retained</small> : null}</td>
              <td><strong>{group.bytesPerCopy.toLocaleString()} B / copy</strong><small>{group.retainedEncodedBytes.toLocaleString()} B across retained copies · {payloadSize(group.retainedEncodedBytes)}</small></td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="repeated-capture-pager"><span>{after + 1}–{Math.min(after + groups.length, page.total)} of {page.total.toLocaleString()} groups</span>
          <div><button disabled={after === 0} onClick={() => setAfter(Math.max(0, after - 50))}>← Previous</button>
            <button disabled={page.after === undefined} onClick={() => setAfter(page.after!)}>Next →</button></div>
        </div>
      </> : <p className="notice">{coverage?.comparisonComplete
        ? 'No exact repeats in this filtered view among compared retained standalone fields.'
        : 'No exact repeat group is available in this partial index; this does not establish absence.'}</p>}
    </> : null}
    {selectedId ? <section className="repeated-capture-detail" aria-label="Repeated-capture occurrences">
      <div className="panel-heading"><div><h3>{currentGroup ? categoryLabel(currentGroup.category) + ' · ' + representationLabel(currentGroup.representation) : 'Selected capture group'}</h3>
        {currentGroup ? <span className="muted">{scopeLabel(currentGroup)} · {currentGroup.role ?? 'role unknown'} · {currentGroup.kind}</span> : null}</div></div>
      {occurrenceError ? <p className="error" role="alert">{occurrenceError} <button onClick={() => setOccurrenceReload(value => value + 1)}>Retry</button></p> : !occurrences ? <p className="notice" role="status">Loading source occurrences…</p> : <>
        <p className="repeated-capture-evidence">{currentGroup?.occurrenceCount.toLocaleString()} exact compact-field copies · {currentGroup ? currentGroup.bytesPerCopy.toLocaleString() + ' encoded bytes per copy' : ''}.
          {currentGroup?.omittedOccurrences ? ' ' + currentGroup.omittedOccurrences.toLocaleString() + ' occurrence references could not be retained because the diagnostic metadata limit was reached.' : ''}</p>
        <div className="repeated-capture-occurrences">{occurrences.occurrences.map(occurrence => <div className="repeated-capture-occurrence" key={occurrence.ref.id + ':' + occurrence.ref.pointer}>
          <span><strong>Line {occurrence.ref.line}</strong><code>{occurrence.ref.pointer || '(root record)'}</code></span>
          <div><button onClick={() => onInspect(occurrence.ref)}>Inspect source ↗</button>
            {occurrence.target ? <button onClick={() => onTimelineTarget(occurrence.target!)}>Show in timeline ↗</button> : null}</div>
        </div>)}</div>
        <div className="repeated-capture-pager"><span>{occurrenceAfter + 1}–{Math.min(occurrenceAfter + occurrences.occurrences.length, occurrences.total)} of {occurrences.total.toLocaleString()} retained source references</span>
          <div><button disabled={occurrenceAfter === 0} onClick={() => setOccurrenceAfter(Math.max(0, occurrenceAfter - 50))}>← Previous</button>
            <button disabled={occurrences.after === undefined} onClick={() => setOccurrenceAfter(occurrences.after!)}>Next →</button></div>
        </div>
      </>}
    </section> : null}
    <details className="measurement-methodology repeated-capture-about">
      <summary>About this measurement</summary>
      <p>Each unit is an exact JSON pointer already selected by Timeline, encoded as compact JSON and compared by SHA-256 plus UTF-8 byte length. “Exact” means the compact encodings match under the SHA-256 fingerprint assumption. Same-record aliases count once. A field is excluded when any other selected field in that physical record is its ancestor or descendant, including the root pointer. Excluded overlaps are policy exclusions, not evidence that their contents do not repeat.</p>
      <p>Groups also require the same actor/source scope, representation, timeline category, kind, and role. Recorded actor IDs are shown only when present; source actors and recording-local fallback scope are labelled separately. Each listed copy is a physical source occurrence, not proof of a unique execution or raw JSONL equality. Bytes describe compact selected-field encodings, not stored transcript bytes, tokens, active context, savings, or waste. No group body or raw source text is exported here.</p>
      <p>Only retained, parsed records and standalone measured fields are compared. Pending, malformed, oversized, unknown, unretained, event-limited, metadata-limited, or normalization-limited data can make the result incomplete. An empty complete result means only that no exact repeats were found among compared retained standalone fields.</p>
    </details>
  </section>;
}

function coverageNotes(coverage: RepeatedCaptureCoverage): string[] {
  const notes: string[] = [];
  if (coverage.state === 'indexing') notes.push('Current results can grow while the retained recording is scanned.');
  if (!coverage.scanComplete && coverage.state !== 'indexing') notes.push('The source scan did not finish.');
  if (coverage.pendingRecords) notes.push(coverage.pendingRecords.toLocaleString() + ' unterminated records are pending.');
  if (coverage.malformedRecords) notes.push(coverage.malformedRecords.toLocaleString() + ' malformed records were not compared.');
  if (coverage.oversizedRecords) notes.push(coverage.oversizedRecords.toLocaleString() + ' oversized records could not be parsed.');
  if (coverage.unknownRecords) notes.push(coverage.unknownRecords.toLocaleString() + ' unknown records remain outside normalized captures.');
  if (coverage.unretainedRecords) notes.push(coverage.unretainedRecords.toLocaleString() + ' source records exceeded the retained record limit.');
  if (coverage.timelineCaptureOmissions) notes.push(coverage.timelineCaptureOmissions.toLocaleString() + ' Timeline capture omission markers were recorded at the event cap; this is not an exact count of uncaptured events.');
  if (coverage.normalizationLimited) notes.push('Normalization stopped at its item limit (' + coverage.normalizationLimited.toLocaleString() + ' limited items).');
  if (coverage.sourceFamilyUnknown) notes.push('The source format is unknown.');
  if (coverage.unresolvedFields) notes.push(coverage.unresolvedFields.toLocaleString() + ' selected fields had no serializable value.');
  if (coverage.omittedByMetadataLimit) notes.push(coverage.omittedByMetadataLimit.toLocaleString() + ' eligible fields or occurrence references exceeded the diagnostic metadata limit.');
  if (coverage.state === 'cancelled') notes.push('No-match results cover only the retained records scanned before cancellation.');
  if (coverage.state === 'error') notes.push('No-match results do not establish absence from the full source.');
  return notes;
}
