import { useEffect, useState } from 'react';
import type { Overview, SourceRef, UsageJump, UsagePage, UsageValues } from '../core/types';
import { api } from './api';

const metrics: Array<[keyof UsageValues, string, string]> = [
  ['input', 'Input tokens', 'Cache read is part of input'],
  ['output', 'Output tokens', 'Includes any reported reasoning subset'],
  ['cached', 'Cache read', 'Subset of input'],
  ['cacheCreation', 'Cache creation', 'Provider field'],
];
const shown = (value: number | null): string => value === null ? 'Unknown' : value.toLocaleString();

export function SessionUsageSummary({ overview }: { overview: Overview }) {
  const usage = overview.usage;
  const metricSummaries = metrics.map(([key, label, note]) => {
    const field = usage.fields[key];
    const unknownCalls = Math.max(0, usage.includedCalls - field.calls);
    const description = overview.source.family === 'claude' && key === 'input' ? 'Includes cache read and creation' : overview.source.family === 'claude' && key === 'cacheCreation' ? 'Subset of input' : note;
    return {
      key, label,
      value: field.overflow ? 'Unavailable' : shown(field.tokens),
      qualification: `${field.calls.toLocaleString()} measured / ${usage.includedCalls.toLocaleString()} included · ${unknownCalls.toLocaleString()} unknown${field.overflow ? ' · subtotal overflow' : ''} · ${description}`,
    };
  });
  return <section className="session-usage-summary" aria-label="Cumulative recorded usage, not context size">
    <div className="panel-heading"><div className="session-usage-title"><h2>Cumulative recorded usage · not context size</h2><span className="usage-summary-subtitle">Provider-reported tokens</span></div><span className="badge">{overview.state === 'indexing' ? 'Indexing…' : 'Provider-reported tokens'}</span></div>
    <div className="metrics">{metricSummaries.map(item => <div key={item.key}><span>{item.label}</span><strong>{item.value}</strong><small>{item.qualification}</small></div>)}</div>
    <details className="usage-summary-qualifications"><summary>Scope and coverage</summary><p>{usage.includedCalls.toLocaleString()} resolved responses included; {usage.excludedCalls.toLocaleString()} conflicting or unassigned observations excluded. Matching repeated measurements count once. These are cumulative usage in this recording, not billing or full T3 history. Missing fields stay unknown; source coverage is on the Coverage tab.</p>
      <ul>{metricSummaries.map(item => <li key={item.key}><strong>{item.label}:</strong> {item.qualification}</li>)}</ul>
    </details>
  </section>;
}

export function SessionUsage({ overview, onInspect, onNavigate }: { overview: Overview; onInspect: (ref: SourceRef) => void; onNavigate: (jump: UsageJump) => void }) {
  const [after, setAfter] = useState(0);
  const [order, setOrder] = useState<'source' | 'input'>('input');
  const [page, setPage] = useState<UsagePage>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setPage(undefined); setError('');
    void api<UsagePage>('/api/sessions/' + overview.id + '/usage?after=' + after + '&order=' + order, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setPage(value); })
      .catch(error => { if (!controller.signal.aborted) setError((error as Error).message); });
    return () => controller.abort();
  }, [after, order, overview.id, overview.state]);
  return <section className="session-usage resource-panel" aria-label="Provider usage by response">
    <div className="panel-heading"><h2>Response ranking</h2><span className="muted">Provider responses · retained recording</span></div>
    <div className="session-usage-body">
    {!overview.callCount ? <p className="notice">No supported provider usage found. Runtime counters are not substituted.</p> : null}
    <div id="usage-breakdown">
      <label>Response order <select value={order} onChange={event => { setOrder(event.target.value as typeof order); setAfter(0); }}><option value="source">Source order</option><option value="input">Input tokens: highest first</option></select></label>
      {order === 'input' ? <p className="muted">Ranks resolved responses with reported input totals. Unknown or conflicting measurements follow without a rank. Source order breaks ties. These totals do not attribute tokens to activity categories or prove active context.</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : !page ? <p className="notice">Loading usage…</p> : <>
        <div className="ledger-table"><table><thead><tr>{order === 'input' ? <th>Rank</th> : null}<th>Source / status</th>{metrics.map(([key, label]) => <th key={key}>{label}</th>)}<th>Evidence</th></tr></thead><tbody>{page.calls.flatMap((call, position) => call.variants.map((variant, i) => <tr key={call.id + ':' + i}>
          {order === 'input' ? <td>{call.status === 'resolved' && call.variants.length === 1 && variant.values.input !== null ? after + position + 1 : '—'}</td> : null}
          <td><strong>Line {variant.ref.line}</strong><br />{call.status === 'resolved' ? 'Included' : 'Excluded'}{call.variants.length > 1 ? ' · variant ' + (i + 1) : ''}<details><summary>Identity and scope</summary>{call.identityDetail}<br />Recorded response; invocation scope unknown.<br />Actor: <span className="path">{call.actorId}</span>{call.model ? <><br />Model: {call.model}</> : null}</details></td>
          {metrics.map(([key]) => <td key={key}>{shown(variant.values[key])}</td>)}
          <td><button disabled={!variant.navigation} onClick={() => { if (variant.navigation) onNavigate({ sessionId: overview.id, navigation: variant.navigation, values: variant.values, ref: variant.ref, status: call.status, identityDetail: call.identityDetail }); }}>Show in timeline ↑</button><br /><button onClick={() => onInspect(variant.ref)}>Inspect line {variant.ref.line} ↗</button>{variant.navigation ? <details><summary>Timeline association</summary>{variant.navigation.detail}</details> : <p className="muted">Timeline target unavailable within retained coverage.</p>}{variant.matchingRefs} retained matching reference{variant.matchingRefs === 1 ? '' : 's'}</td>
        </tr>))}</tbody></table></div>
        <div className="pager"><button disabled={!after} onClick={() => setAfter(Math.max(0, after - 20))}>Previous responses</button><button disabled={page.after === undefined} onClick={() => setAfter(page.after!)}>Next responses →</button></div>
      </>}
    </div>
    </div>
  </section>;
}
