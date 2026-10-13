import { useEffect, useState } from 'react';
import type {
  ContextEvidenceEntry, ContextEvidenceFields, ContextField, ContextList, ContextMetadataEntry, ContextOwnerAxis,
  ContextRepresentationEntry, ContextReplacementEntry, ContextRetainedEntry, ContextWindowEntry,
  ContextWindowPage, Overview, SourceRef,
} from '../core/types';
import { api } from './api';
import './styles.css';

const pageSize = 50;
const valueText = (field: ContextField): string => {
  if (field.state === 'recorded') return field.value === undefined ? 'Recorded' : String(field.value);
  if (field.state === 'over-limit') return (field.value === undefined ? 'Value exceeds 512 bytes' : String(field.value) + ' · value shortened to 512 bytes');
  return field.state === 'missing' ? 'Missing' : field.state === 'null' ? 'Null' : 'Malformed type';
};

function InspectButton({ refValue, onInspect, label }: { refValue?: SourceRef; onInspect: (ref: SourceRef) => void; label: string }) {
  return <button disabled={!refValue} onClick={() => { if (refValue) onInspect(refValue); }}>{label}</button>;
}

function FieldRow({ name, field, onInspect }: { name: string; field: ContextField; onInspect: (ref: SourceRef) => void }) {
  return <div className="timeline-relationship-heading"><span className="path">{name}: {valueText(field)}</span>
    {field.truncated ? <span>Original value shortened; inspect the raw field.</span> : null}
    <InspectButton refValue={field.ref} onInspect={onInspect} label="Inspect field" />
  </div>;
}

function OwnerAxis({ label, axis, onInspect }: { label: string; axis: ContextOwnerAxis; onInspect: (ref: SourceRef) => void }) {
  const value = axis.state === 'recorded' || axis.state === 'selected-source' || axis.state === 'over-limit'
    ? axis.value ?? 'Unknown' : valueText({ state: axis.state });
  return <FieldRow name={label + ' · ' + axis.basis} field={{ state: axis.state === 'selected-source' ? 'recorded' : axis.state,
    value, ref: axis.ref, truncated: axis.truncated }} onInspect={onInspect} />;
}

function ListSummary<T>({ list, onInspect, children }: { list: ContextList<T>; onInspect: (ref: SourceRef) => void; children?: React.ReactNode }) {
  return <section className="timeline-relationship">
    <div className="timeline-relationship-heading"><strong>{list.name ?? 'Recorded list'} · {list.state === 'recorded' ? (list.count ?? 0).toLocaleString() + ' entries' : valueText({ state: list.state })}</strong>
      {list.omitted ? <span>{list.omitted.toLocaleString()} entries omitted by the {20}-entry preview limit.</span> : null}
      <InspectButton refValue={list.ref} onInspect={onInspect} label="Inspect full field" />
    </div>
    {children}
  </section>;
}

function ReplacementEntry({ entry, onInspect }: { entry: ContextReplacementEntry; onInspect: (ref: SourceRef) => void }) {
  return <div className="timeline-relationship">
    <div className="timeline-relationship-heading"><strong>Replacement entry · {entry.state}</strong>
      <InspectButton refValue={entry.ref} onInspect={onInspect} label="Inspect entry" />
    </div>
    <FieldRow name="type" field={entry.type} onInspect={onInspect} />
    <FieldRow name="role" field={entry.role} onInspect={onInspect} />
    <FieldRow name="id" field={entry.id} onInspect={onInspect} />
  </div>;
}

function MetadataEntry({ entry, onInspect }: { entry: ContextMetadataEntry; onInspect: (ref: SourceRef) => void }) {
  return <div className="timeline-relationship-heading"><strong>Metadata entry · {entry.state}</strong>
    {entry.keys.length ? <span>Keys: {entry.keys.join(', ')}{entry.omittedKeys ? ' · ' + entry.omittedKeys + ' additional keys omitted' : ''}</span> : null}
    <InspectButton refValue={entry.ref} onInspect={onInspect} label="Inspect entry" />
  </div>;
}

function RetainedEntry({ entry, onInspect }: { entry: ContextRetainedEntry; onInspect: (ref: SourceRef) => void }) {
  return <div className="timeline-relationship">
    <div className="timeline-relationship-heading"><strong>Retained entry · {entry.state}</strong>
      <InspectButton refValue={entry.ref} onInspect={onInspect} label="Inspect entry" />
    </div>
    {entry.fields.map(item => <FieldRow key={item.name} name={item.name} field={item.field} onInspect={onInspect} />)}
  </div>;
}

function EvidenceFields({ evidence, onInspect }: { evidence: ContextEvidenceFields; onInspect: (ref: SourceRef) => void }) {
  return <>
    <section className="usage-chart-evidence">
      <h3>Recorded boundary metadata</h3>
      {evidence.metadataOmitted ? <p className="muted">Some metadata previews were omitted by the total metadata byte limit. Inspect the source record for the original fields.</p> : null}
      {evidence.containers.map(item => <FieldRow key={item.name} name={item.name + ' container'} field={item.field} onInspect={onInspect} />)}
      <FieldRow name="Boundary UUID" field={evidence.boundaryUuid} onInspect={onInspect} />
      <h3>Runtime observations</h3>
      {evidence.counters.map((item, index) => <FieldRow key={item.name + index} name={item.name} field={item.field} onInspect={onInspect} />)}
      {evidence.triggerAndFlags.map((item, index) => <FieldRow key={item.name + index} name={item.name} field={item.field} onInspect={onInspect} />)}
      <h3>Recorded window identifiers</h3>
      {evidence.windowIds.map((item, index) => <FieldRow key={item.name + index} name={item.name} field={item.field} onInspect={onInspect} />)}
    </section>
    <ListSummary list={evidence.replacementHistory} onInspect={onInspect}>
      {evidence.replacementHistory.items.map((item, index) => <ReplacementEntry key={index} entry={item as ContextReplacementEntry} onInspect={onInspect} />)}
    </ListSummary>
    <ListSummary list={evidence.replacementHistoryMetadata} onInspect={onInspect}>
      {evidence.replacementHistoryMetadata.items.map((item, index) => <MetadataEntry key={index} entry={item as ContextMetadataEntry} onInspect={onInspect} />)}
    </ListSummary>
    <section className="usage-chart-evidence">
      <h3>Retained-context evidence</h3>
      <FieldRow name="retained_context" field={evidence.retainedContext.ref} onInspect={onInspect} />
      <FieldRow name="retained_context.incomplete" field={evidence.retainedContext.incomplete} onInspect={onInspect} />
      {evidence.retainedContext.lists.map(list => <section className="timeline-relationship" key={list.name}>
        <FieldRow name={list.name + '_incomplete'} field={list.incomplete} onInspect={onInspect} />
        <ListSummary list={list.values} onInspect={onInspect}>
          {list.values.items.map((entry, index) => <RetainedEntry key={index} entry={entry} onInspect={onInspect} />)}
        </ListSummary>
      </section>)}
      {evidence.retainedContext.omittedLists ? <p className="muted">{evidence.retainedContext.omittedLists} retained-context list fields omitted by the metadata preview limit.</p> : null}
    </section>
    <section className="usage-chart-evidence">
      <h3>Preserved-message fields</h3>
      {evidence.preserved.map(item => <section className="timeline-relationship" key={item.name}>
        <FieldRow name={item.name} field={item.field} onInspect={onInspect} />
        {item.anchorUuid ? <FieldRow name={item.name + '.anchorUuid'} field={item.anchorUuid} onInspect={onInspect} /> : null}
        {item.uuids ? <ListSummary list={item.uuids} onInspect={onInspect}>{item.uuids.items.map((field, index) => <FieldRow key={index} name={'uuids[' + index + ']'} field={field} onInspect={onInspect} />)}</ListSummary> : null}
        {item.allUuids ? <ListSummary list={item.allUuids} onInspect={onInspect}>{item.allUuids.items.map((field, index) => <FieldRow key={index} name={'allUuids[' + index + ']'} field={field} onInspect={onInspect} />)}</ListSummary> : null}
        {item.values ? <ListSummary list={item.values} onInspect={onInspect}>{item.values.items.map((field, index) => <FieldRow key={index} name={'value[' + index + ']'} field={field} onInspect={onInspect} />)}</ListSummary> : null}
      </section>)}
    </section>
  </>;
}

function Owner({ entry, onInspect }: { entry: ContextEvidenceEntry; onInspect: (ref: SourceRef) => void }) {
  const { owner } = entry;
  return <section className="usage-chart-evidence">
    <h3>Recorded ownership axes</h3>
    <OwnerAxis label="Recorded agent" axis={owner.recordedAgent} onInspect={onInspect} />
    <OwnerAxis label="Explicitly selected SourceFile.actorId" axis={owner.selectedSourceActor} onInspect={onInspect} />
    <OwnerAxis label="Recorded provider thread/session" axis={owner.providerSession} onInspect={onInspect} />
    <OwnerAxis label="Root session grouping" axis={owner.rootSession} onInspect={onInspect} />
    <p className="muted">Scope: {owner.scopeBasis}. Unknown fallback uses this source instance ({owner.sourceInstanceId}); root session IDs do not merge scopes or identify an actor.</p>
  </section>;
}

function WindowRow({ entry, selected, onToggle, onInspect, onNavigate }: {
  entry: ContextWindowEntry; selected: boolean; onToggle: (open: boolean) => void; onInspect: (ref: SourceRef) => void;
  onNavigate: (target: { id: string; position: number }) => void;
}) {
  const target = entry.anchorTarget ?? entry.boundary?.target;
  const title = entry.anchorKind === 'recording-start' ? 'Recording-start window' : entry.boundary?.label ?? 'Recorded compaction window';
  const endText = entry.endRef
    ? entry.endBasis === 'next-same-scope-boundary' ? 'before line ' + entry.endRef.line + ' (next same-scope boundary)'
      : 'through line ' + entry.endRef.line + ' (last retained complete source record)'
    : 'end pending while indexing';
  return <details className="usage-chart-evidence context-window-entry" onToggle={event => {
    onToggle(event.currentTarget.open);
  }}>
    <summary><strong>{title}</strong> · source line {entry.startRef.line} · {entry.incomplete ? 'coverage incomplete or ownership unknown' : 'recorded interval'}</summary>
    <p className="muted">Physical source interval starts at line {entry.startRef.line} ({entry.startBasis}) and ends {endText}. The interval describes source order only; it does not list active model-context members.</p>
    <div className="pager usage-chart-actions">
      <button disabled={!target} onClick={() => { if (target) onNavigate(target); }}>Show exact retained event in timeline</button>
      <InspectButton refValue={entry.startRef} onInspect={onInspect} label="Inspect start record" />
      {entry.endRef ? <InspectButton refValue={entry.endRef} onInspect={onInspect} label="Inspect end boundary" /> : null}
      {entry.boundary ? <InspectButton refValue={entry.boundary.ref} onInspect={onInspect} label="Inspect compaction record" /> : null}
    </div>
    {!target ? <p className="muted">No timeline event from this retained physical record is available; source inspection remains available.</p> : null}
    <Owner entry={entry} onInspect={onInspect} />
    {entry.boundary ? <>
      <p className="muted">{entry.boundary.kind === 'codex-context-compacted' ? 'Recorded runtime compaction marker used as a source boundary.' : 'Recorded compaction event used as a source boundary.'} Window-number meaning before or after the event is unknown. Runtime counters and retained/replacement fields do not prove active-context membership.</p>
      <EvidenceFields evidence={entry.boundary.evidence} onInspect={onInspect} />
      {entry.boundary.summaryAssociation.state === 'linked' ? <section className="timeline-relationship">
        <strong>Explicit Claude summary link · line {entry.boundary.summaryAssociation.refs[0]?.line}</strong>
        <p className="muted">Recorded summary UUID matches preservedMessages.anchorUuid and parentUuid matches this boundary UUID in the same recorded scope.</p>
        <div className="pager timeline-related"><InspectButton refValue={entry.boundary.summaryAssociation.refs[0]} onInspect={onInspect} label="Inspect linked summary" />
          <button disabled={!entry.boundary.summaryAssociation.target} onClick={() => { if (entry.boundary?.summaryAssociation.target) onNavigate(entry.boundary.summaryAssociation.target); }}>Show linked summary in timeline</button></div>
      </section> : entry.boundary.summaryAssociation.state !== 'none' ? <p className="muted">Claude summary association: {entry.boundary.summaryAssociation.state}; no summary target was substituted.{entry.boundary.summaryAssociation.omitted ? ' ' + entry.boundary.summaryAssociation.omitted + ' matching records omitted.' : ''}</p> : null}
    </> : null}
  </details>;
}

function RepresentationRow({ entry, onInspect, onNavigate }: { entry: ContextRepresentationEntry; onInspect: (ref: SourceRef) => void; onNavigate: (target: { id: string; position: number }) => void }) {
  return <section className="usage-chart-evidence">
    <div className="panel-heading"><div><strong>{entry.label} · line {entry.ref.line}</strong><p className="muted">Representation evidence; it does not create a context-window boundary.</p></div>
      <span className="badge">{entry.summaryAssociation}</span></div>
    {entry.metadataOmitted ? <p className="muted">Summary metadata was omitted by the total metadata byte limit; inspect the original source record.</p> : null}
    {entry.summaryFlags.map(item => <FieldRow key={item.name} name={item.name} field={item.field} onInspect={onInspect} />)}
    {entry.uuid ? <FieldRow name="uuid" field={entry.uuid} onInspect={onInspect} /> : null}
    {entry.parentUuid ? <FieldRow name="parentUuid" field={entry.parentUuid} onInspect={onInspect} /> : null}
    {entry.linkedBoundaryRef ? <InspectButton refValue={entry.linkedBoundaryRef} onInspect={onInspect} label="Inspect linked boundary" /> : null}
    <div className="pager usage-chart-actions"><button disabled={!entry.target} onClick={() => { if (entry.target) onNavigate(entry.target); }}>Show exact retained event in timeline</button>
      <InspectButton refValue={entry.ref} onInspect={onInspect} label="Inspect representation record" /></div>
    {!entry.target ? <p className="muted">No timeline event from this retained physical record is available; source inspection remains available.</p> : null}
    <Owner entry={entry} onInspect={onInspect} />
  </section>;
}

export function ContextWindows({ overview, onInspect, onNavigate }: {
  overview: Overview;
  onInspect: (ref: SourceRef) => void;
  onNavigate: (target: { id: string; position: number }) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [after, setAfter] = useState(0);
  const [page, setPage] = useState<ContextWindowPage>();
  const [selectedId, setSelectedId] = useState<string>();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setPage(undefined);
    setError('');
    const load = async () => {
      try {
        const value = await api<ContextWindowPage>('/api/sessions/' + overview.id + '/context-windows?' + new URLSearchParams({ after: String(after) }), { signal: controller.signal });
        if (controller.signal.aborted) return;
        setPage(value);
        if (!value.coverage.scanComplete && overview.state === 'indexing') refreshTimer = setTimeout(() => { void load(); }, 700);
      } catch (failure) {
        if (!controller.signal.aborted) setError((failure as Error).message);
      }
    };
    void load();
    return () => { controller.abort(); if (refreshTimer) clearTimeout(refreshTimer); };
  }, [expanded, after, overview.id, overview.state]);

  const active = page?.entries.find(entry => entry.id === selectedId);
  return <details className="usage-chart-panel" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>Recorded context windows <span className="usage-chart-summary-note">Source intervals · compaction evidence · not active-context membership</span></summary>
    <div className="usage-chart-body">
      <p className="muted">A window is a source-derived physical interval: its start anchor through the next boundary in the same recorded actor/thread scope, or through the last retained complete physical source record. Recording start is the first retained complete physical record, not conversation start. Intervals are evidence of recorded order, not a reconstructed request or a list of active model-context members.</p>
      {error ? <p className="error" role="alert">{error}</p> : !page ? <p className="notice">Loading recorded context-window evidence…</p> : <>
        <div className="usage-chart-scope"><span>{page.coverage.retainedWindows.toLocaleString()} windows · {page.coverage.retainedRepresentations.toLocaleString()} separate representation records</span>
          <span>{page.total ? 'Evidence rows ' + (after + 1).toLocaleString() + '–' + (after + page.entries.length).toLocaleString() + ' of ' + page.total.toLocaleString() : 'No retained context evidence'}</span></div>
        {page.entries.map(entry => entry.kind === 'window'
          ? <WindowRow key={entry.id} entry={entry} selected={active?.id === entry.id}
            onToggle={open => setSelectedId(old => open ? entry.id : old === entry.id ? undefined : old)} onInspect={onInspect} onNavigate={onNavigate} />
          : <RepresentationRow key={entry.id} entry={entry} onInspect={onInspect} onNavigate={onNavigate} />)}
        {!page.entries.length ? <p className="notice">No context-window anchors or supported representation evidence are retained.</p> : null}
        <div className="usage-chart-pager">
          <button disabled={!after} onClick={() => setAfter(Math.max(0, after - pageSize))}>Previous evidence page</button>
          <span>{page.coverage.scanComplete ? 'Source scan complete.' : 'Source scan is in progress; this page refreshes automatically.'}</span>
          <button disabled={page.after === undefined} onClick={() => setAfter(page.after!)}>Next evidence page</button>
        </div>
        <div className="usage-chart-coverage" aria-label="Context-window evidence coverage">
          <p>{page.coverage.complete ? 'Supported context-window capture is complete within the retained index.' : 'Context-window evidence has indexing, scope, metadata, or retention limits.'} Indexed records: {page.coverage.indexedRecords.toLocaleString()}. Retained windows {page.coverage.retainedWindows.toLocaleString()} of {page.coverage.windowLimit.toLocaleString()}, omitted windows {page.coverage.omittedWindows.toLocaleString()}; retained representations {page.coverage.retainedRepresentations.toLocaleString()} of {page.coverage.representationLimit.toLocaleString()}, omitted representations {page.coverage.omittedRepresentations.toLocaleString()}.</p>
          <p>Metadata retained: {page.coverage.retainedMetadataBytes.toLocaleString()} of {page.coverage.metadataByteLimit.toLocaleString()} bytes; {page.coverage.omittedMetadataRecords.toLocaleString()} records had detail previews omitted. List previews show at most 20 entries, and displayed IDs/values are limited to 512 bytes. Pagination returns at most {page.coverage.pageLimit} evidence rows.</p>
          <p>Native window numbers retain their source names and have unknown before/after meaning. Runtime counters, transcript-only summaries, retained/replacement records, and compaction representations do not establish active model-context membership.</p>
        </div>
      </>}
    </div>
  </details>;
}
