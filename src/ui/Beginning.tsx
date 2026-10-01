import type { EvidenceItem, Overview, SourceRef } from '../core/types';

export function EvidenceRow({ item, onInspect }: { item: EvidenceItem; onInspect: (ref: SourceRef) => void }) {
  return <button className="evidence-row" onClick={() => onInspect(item.ref)}>
    <span className="evidence-main">
      <span className="row-title">{item.label}</span>
      {item.capturedPath ? <span className="path">{item.capturedPath}</span> : null}
      <span className="muted">{item.detail}</span>
    </span>
    <span className="evidence-end"><span className={'badge ' + (item.representation === 'diagnostic-snapshot' ? 'amber' : '')}>{item.representation === 'diagnostic-snapshot' ? 'diagnostic' : item.kind}</span><span>Line {item.ref.line} ↗</span></span>
  </button>;
}

export function Beginning({ overview, onInspect }: { overview: Overview; onInspect: (ref: SourceRef) => void }) {
  const call = overview.firstCall;
  const variant = call?.variants[0];
  const prompt = overview.firstPrompt;
  const shown = (value: number | null | undefined): string => value === null || value === undefined ? 'Unknown' : value.toLocaleString();
  return <div className="beginning">
    <div className="content-heading"><div><div className="section-label">Beginning</div><h1>What was there at the start?</h1></div><span className="badge">{overview.source.family}</span></div>
    <p className="intro">Explore the submitted input and captured setup. Each claim opens the record that supports it.</p>
    <section className="prompt-panel">
      <div className="panel-heading"><h2>First input</h2>{prompt ? <span className="badge">{prompt.origin}</span> : null}</div>
      {prompt ? <>
        <p className="prompt-text">{prompt.preview || '(captured content is empty)'}</p>
        {prompt.previewLimited ? <p className="muted">Preview shortened. Open the source to continue reading.</p> : null}
        <div className="prompt-footer"><span>{prompt.detail}</span><button onClick={() => onInspect(prompt.ref)}>Inspect line {prompt.ref.line} ↗</button></div>
      </> : <p className="muted">{overview.state === 'indexing' ? 'Reading the recording…' : 'No supported first input found within normalization coverage.'}</p>}
    </section>
    <section className="usage-panel">
      <div className="panel-heading"><h2>First recorded response usage</h2>{call ? <span className={'badge ' + (call.status === 'ambiguous' ? 'amber' : '')}>{call.status}</span> : null}</div>
      {call && variant ? <>
        <div className="metrics">
          <div><span>Input footprint</span><strong>{call.status === 'resolved' ? shown(variant.values.input) : 'Ambiguous'}</strong><small>provider-reported tokens</small></div>
          <div><span>Cache read</span><strong>{shown(variant.values.cached)}</strong><small>included in input</small></div>
          <div><span>Cache creation</span><strong>{shown(variant.values.cacheCreation)}</strong><small>{overview.source.family === 'claude' ? 'included in input' : 'provider field'}</small></div>
          <div><span>Output</span><strong>{shown(variant.values.output)}</strong><small>reasoning subset: {shown(variant.values.reasoning)}</small></div>
        </div>
        <div className="usage-footnote"><p>Recorded response; invocation scope unknown. {variant.refs.length} matching source reference{variant.refs.length === 1 ? '' : 's'}. {call.status === 'ambiguous' ? 'Conflicting or unassigned measurements are excluded from resolved totals.' : 'Repeated identical measurements count once.'}</p><button onClick={() => onInspect(variant.refs[0]!)}>Inspect usage ↗</button></div>
        {call.variants.length > 1 ? <div className="variants">{call.variants.map((value, i) => <button key={i} onClick={() => onInspect(value.refs[0]!)}>Variant {i + 1}: input {shown(value.values.input)} · output {shown(value.values.output)}</button>)}</div> : null}
      </> : <p className="muted">Provider usage is unavailable. Runtime counters are kept separate.</p>}
    </section>
    <section className="resource-panel"><div className="panel-heading"><h2>Captured startup resources</h2><span className="muted">Observed before first usage</span></div>
      {overview.startup.map(item => <EvidenceRow key={item.id + ':' + item.kind} item={item} onInspect={onInspect} />)}
      {!overview.startup.length ? <p className="muted">No supported startup resource capture in the inspected recording.</p> : null}
    </section>
    <section className="resource-panel"><div className="panel-heading"><h2>Diagnostic snapshots</h2><span className="badge amber">Separate representation</span></div>
      <p className="muted">Snapshots preserve diagnostic evidence. Their presence does not establish another injection, eager tool loading, or exact active context. Associations remain unassigned here.</p>
      {overview.snapshots.map(item => <EvidenceRow key={item.id} item={item} onInspect={onInspect} />)}
      {!overview.snapshots.length ? <p className="muted">No supported prompt_snapshot recorded within normalization coverage.</p> : null}
    </section>
  </div>;
}
