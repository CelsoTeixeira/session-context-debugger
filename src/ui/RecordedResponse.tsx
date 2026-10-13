import { useEffect, useState } from 'react';
import type { Overview, ResponseLink, ResponseView, SourceRef } from '../core/types';
import { api } from './api';

export function RecordedResponse({ sessionId, eventId, state, open, onToggle, onInspect, onNavigate }: {
  sessionId: string; eventId: string; state: Overview['state']; open: boolean; onToggle: (open: boolean) => void;
  onInspect: (ref: SourceRef) => void; onNavigate: (link: ResponseLink) => void;
}) {
  const [view, setView] = useState<ResponseView>();
  const [error, setError] = useState('');
  useEffect(() => {
    setView(undefined); setError('');
    if (!open) return;
    const controller = new AbortController();
    void api<ResponseView>('/api/sessions/' + sessionId + '/response?' + new URLSearchParams({ eventId }), { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setView(value); })
      .catch(err => { if (!controller.signal.aborted) setError((err as Error).message); });
    return () => controller.abort();
  }, [sessionId, eventId, state, open]);
  return <details className="recorded-response" open={open} onToggle={event => onToggle(event.currentTarget.open)}>
    <summary>Recorded response</summary>
    {open ? <div className="response-content">
      {error ? <p className="error" role="alert">{error}</p> : !view ? <p className="muted" role="status">Reading response associations…</p> : <>
        <p className="muted">{view.detail}</p>
        {!view.complete ? <p className="notice">Association coverage is incomplete; missing links or usage do not establish absence.</p> : null}
        {view.groupKind !== 'unknown' ? <>
          <div className="panel-heading"><strong>{view.groupKind === 'provider-response' ? 'Provider response' : 'Captured record'} {view.position + 1} of {view.total} retained groups · first recorded order</strong><div className="pager"><button disabled={!view.previous} onClick={() => onNavigate(view.previous!)}>← Previous group</button><button disabled={!view.next} onClick={() => onNavigate(view.next!)}>Next group →</button></div></div>
          {view.groupKind === 'provider-response' ? <>
            <span className="path">Actor/thread: {view.identity.actorId}<br />{view.identity.responseId ? 'Response ID: ' + view.identity.responseId : <>Request ID: {view.identity.requestId}<br />Message ID: {view.identity.messageId}</>}</span>
            <p className="muted">{view.usageStatus === 'resolved' ? 'Provider-reported usage · recorded response; invocation scope unknown.' : view.usageStatus === 'ambiguous' ? 'Conflicting usage variants · excluded from resolved subtotals. No variant is selected as authoritative.' : 'Provider usage unknown within the retained normalization coverage.'}</p>
            {view.variants.map((variant, index) => <section className="response-variant" key={variant.ref.id + ':' + index} aria-label={'Usage variant ' + (index + 1)}>
              <div className="panel-heading"><strong>{view.variants.length > 1 ? 'Usage variant ' + (index + 1) : 'Recorded usage'}</strong><button onClick={() => onInspect(variant.ref)}>Inspect usage · line {variant.ref.line} ↗</button></div>
              <div className="response-metrics">{([['input', 'Input tokens'], ['output', 'Output tokens'], ['cached', 'Cache read'], ['cacheCreation', 'Cache creation']] as const).map(([key, label]) => <div key={key}><span>{label}</span><strong>{variant.values[key] === null ? 'Unknown' : variant.values[key].toLocaleString()}</strong></div>)}</div>
              <p className="muted">{variant.matchingRefs} matching retained usage references. {view.identity.responseId ? 'Cache read is an input subset; cache creation is the provider field.' : 'Cache read and creation are components of input.'} Output includes any reported reasoning subset.</p>
            </section>)}
            {view.omittedVariants ? <p className="muted">{view.omittedVariants} additional usage variants omitted; inspect the recording.</p> : null}
          </> : <>
            <span className="path">Actor/thread: {view.actorId}<br />Selected source instance: {view.source.sourceId}<br />Physical record: line {view.source.line}</span>
            <p className="muted">Capture basis: same physical record only. Provider request association: unknown. Provider usage association: unknown; no usage variants are assigned and session usage totals are unchanged.</p>
          </>}
          <p className="muted">{view.eventCount} {view.groupKind === 'provider-response' ? 'linked captured events' : 'retained events from this physical record'}. Every physical copy remains separate evidence.</p>
          <div className="response-event-links">{view.events.map(link => <div key={link.id}><button disabled={link.id === eventId} onClick={() => onNavigate(link)}>{link.label} · line {link.ref.line}</button><button aria-label={'Inspect ' + link.label + ' source · line ' + link.ref.line} onClick={() => onInspect({ ...link.ref, pointer: undefined })}>{view.groupKind === 'provider-response' ? 'Inspect identity' : 'Inspect source'} ↗</button></div>)}</div>
          {view.omittedEvents ? <p className="muted">{view.omittedEvents} additional event links omitted; at most 20 links are shown, including this selected event.</p> : null}
        </> : null}
      </>}
    </div> : null}
  </details>;
}
