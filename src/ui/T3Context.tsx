import type { DatabaseRef, LogMatch, SourceRef, T3Resolution } from '../core/types';

const labels = { verified: 'Verified current link', ambiguous: 'Choose a recording', 'log-missing': 'Recording not located', unlinked: 'No supported current binding', unsupported: 'Unsupported provider' };
export function T3Context({ resolution, identity, onDatabase, onIdentity, onOpen }: {
  resolution: T3Resolution; identity?: SourceRef; onDatabase: (ref: DatabaseRef) => void;
  onIdentity: (ref: SourceRef) => void; onOpen: (match: LogMatch) => void;
}) {
  const { thread } = resolution;
  return <section className="t3-context">
    <div className="panel-heading"><h2>{thread.title}</h2><span className={'badge ' + (resolution.status === 'verified' ? '' : 'amber')}>{labels[resolution.status]}</span></div>
    <p className="muted">{thread.project} · {thread.provider ?? 'Provider unknown'}{thread.archived ? ' · Archived' : ''}</p>
    <div className="path">T3 thread: {thread.id}</div>
    {thread.workspace ? <div className="path">Workspace: {thread.workspace}</div> : null}
    {resolution.providerId ? <div className="path">Current provider ID: {resolution.providerId}</div> : null}
    <p className="muted">Local T3 environment · Provider instance: {resolution.providerInstance ?? 'not recorded'}</p>
    <div className="t3-evidence">{resolution.refs.map(ref => <button key={ref.id} onClick={() => onDatabase(ref)}>Inspect {ref.table === 'projection_threads' ? 'thread' : ref.table === 'projection_projects' ? 'project' : 'binding'} row</button>)}
      {identity ? <button onClick={() => onIdentity(identity)}>Inspect log identity</button> : null}</div>
    {resolution.status === 'ambiguous' ? <div className="source-list">{resolution.matches.map(match => <button className="source-candidate" key={match.id} onClick={() => onOpen(match)}><span className="source-family">ID corroborated · line {match.identity.line}</span><span className="path">{match.path}</span><span>Open this recording →</span></button>)}</div> : null}
    <details className="warnings"><summary>Current-binding coverage · {resolution.complete === null ? 'provider-log discovery not run' : resolution.complete ? 'filename discovery finished' : 'incomplete discovery'}</summary><ul>{resolution.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>
  </section>;
}
