import { useEffect, useRef, useState } from 'react';
import type { Overview, RelationEvidence, RelationResolution, SourceRef } from '../core/types';
import { api } from './api';

export function RelatedSessions({ overview, request, onInspect, onOpen }: {
  overview: Overview; request?: { id: string; serial: number }; onInspect: (ref: SourceRef) => void;
  onOpen: (resolutionId: string, matchId: string, path: string) => Promise<void>;
}) {
  const panel = useRef<HTMLDetailsElement>(null);
  const targets = useRef<HTMLElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [resolution, setResolution] = useState<RelationResolution>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [evidence, setEvidence] = useState<{ source: RelationEvidence; text: string; limited: boolean }>();
  const listing = overview.relationships;
  async function resolve(id: string) {
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setBusy(true); setError(''); setEvidence(undefined); setResolution(undefined);
    try {
      const result = await api<RelationResolution>('/api/sessions/' + overview.id + '/relationships/resolve', { method: 'POST', body: JSON.stringify({ linkId: id }), signal: current.signal });
      if (!current.signal.aborted) setResolution(result);
    } catch (err) { if (!current.signal.aborted) setError((err as Error).message); }
    finally { if (!current.signal.aborted) setBusy(false); }
  }
  useEffect(() => {
    if (!request) return;
    panel.current!.open = true;
    panel.current!.scrollIntoView({ block: 'start' });
    void resolve(request.id);
  }, [request?.serial]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (resolution && panel.current?.open) {
      targets.current?.focus({ preventScroll: true });
      targets.current?.scrollIntoView({ block: 'start' });
    }
  }, [resolution?.id]);
  async function inspect(source: RelationEvidence) {
    if (!resolution) return;
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setBusy(true); setError(''); setEvidence(undefined);
    try {
      const result = await api<{ text: string; limited: boolean }>('/api/sessions/' + overview.id + '/relationships/evidence?' + new URLSearchParams({ resolutionId: resolution.id, evidenceId: source.id }), { signal: current.signal });
      if (!current.signal.aborted) setEvidence({ source, ...result });
    } catch (err) { if (!current.signal.aborted) setError((err as Error).message); }
    finally { if (!current.signal.aborted) setBusy(false); }
  }
  if (!listing.links.length) return null;
  return <details className="related-sessions collapsible-panel" ref={panel}>
    <summary>Related sessions · {listing.links.length}<span className="muted">Recorded links · separate usage</span></summary>
    <div className="panel-content">
      <p className="muted">{listing.detail}{!listing.complete ? ' Relationship capture is incomplete.' : ''}{listing.omitted ? ' Omitted references/links: ' + listing.omitted + '.' : ''}</p>
      <div className="relationship-list">{listing.links.map(link => <div className="relationship-row" key={link.id}>
        <div><strong>{link.direction === 'parent' ? 'Parent' : 'Child'} · {link.label}</strong><span className="path">{link.targetId ?? link.toolId}</span></div>
        <div className="pager"><button disabled={busy || overview.state !== 'ready'} onClick={() => void resolve(link.id)}>Find {link.direction} recording</button><button onClick={() => onInspect(link.refs[0]!)}>Inspect link · line {link.refs[0]!.line}</button></div>
      </div>)}</div>
      {busy ? <p className="notice" role="status">Reading relationship evidence…</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {resolution ? <section ref={targets} tabIndex={-1} aria-label="Relationship targets">
        <div className="panel-heading"><strong>{resolution.relation.label}</strong><button onClick={() => onInspect(resolution.relation.refs[0]!)}>Inspect recorded link · line {resolution.relation.refs[0]!.line}</button></div>
        <p className="muted">{resolution.status === 'missing' ? 'Recording not located within this discovery coverage.' : resolution.status === 'ambiguous' ? 'Multiple targets corroborated; choose a recording explicitly.' : resolution.status === 'unavailable' ? 'Relationship is unresolved or conflicting; navigation is unavailable.' : 'One target corroborated.'} {resolution.complete ? 'Scoped discovery finished.' : 'Discovery coverage incomplete.'}</p>
        {resolution.matches.map(match => <div className="relationship-target" key={match.id}>
          <div className="panel-heading"><strong>{match.status === 'verified' ? 'Corroborated recording' : match.status === 'conflicting' ? 'Conflicting identity' : 'Unverified identity'}</strong><button disabled={busy || match.status !== 'verified'} onClick={() => { setBusy(true); void onOpen(resolution.id, match.id, match.path).catch(err => setError((err as Error).message)).finally(() => setBusy(false)); }}>Open {resolution.relation.direction} recording →</button></div>
          <span className="path">{match.path}</span><p className="muted">Actor/thread: {match.actorId}<br />Root session: {match.rootId}</p><p className="muted">{match.detail}</p>
          <div className="pager">{match.evidence.map(source => <button key={source.id} disabled={busy} onClick={() => void inspect(source)}>Inspect {source.label}</button>)}</div>
        </div>)}
        <ul className="muted">{resolution.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>
      </section> : null}
      {evidence ? <section className="relationship-evidence" aria-label="Relationship source evidence"><div className="panel-heading"><strong>{evidence.source.label}</strong><button onClick={() => setEvidence(undefined)}>Close evidence</button></div><span className="path">{evidence.source.path}</span><p className="muted">Hash validated · {evidence.source.bytes.toLocaleString()} bytes · SHA-256 {evidence.source.sha256}</p><pre>{evidence.text}{evidence.limited ? '\n[Preview limited; open the recording for source ranges.]' : ''}</pre></section> : null}
    </div>
  </details>;
}
