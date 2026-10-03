import { useEffect, useState } from 'react';
import type { Overview, SourceRef, UsagePage, UsageValues } from '../core/types';
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
  return <section className="usage-panel session-usage-summary" aria-label="Recorded session usage totals">
    <div className="panel-heading"><h2>Recorded usage subtotals</h2><span className="badge">{overview.state === 'indexing' ? 'Indexing…' : 'Provider-reported tokens'}</span></div>
    <div className="metrics">{metrics.map(([key, label, note]) => {
      const field = usage.fields[key];
      const description = overview.source.family === 'claude' && key === 'input' ? 'Includes cache read and creation' : overview.source.family === 'claude' && key === 'cacheCreation' ? 'Subset of input' : note;
      return <div key={key}><span>{label}</span><strong>{field.overflow ? 'Unavailable' : shown(field.tokens)}</strong><small>{field.calls.toLocaleString()} / {usage.includedCalls.toLocaleString()} included responses · {description}</small></div>;
    })}</div>
    <div className="usage-footnote"><p>{usage.includedCalls.toLocaleString()} resolved responses included; {usage.excludedCalls.toLocaleString()} conflicting or unassigned observations excluded. Matching repeated measurements count once. These are cumulative usage in this recording, not current context size, billing, or full T3 history. Missing fields stay unknown; see source coverage below.</p></div>
  </section>;
}

export function SessionUsage({ overview, onInspect }: { overview: Overview; onInspect: (ref: SourceRef) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [after, setAfter] = useState(0);
  const [order, setOrder] = useState<'source' | 'input'>('input');
  const [page, setPage] = useState<UsagePage>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setPage(undefined); setError('');
    void api<UsagePage>('/api/sessions/' + overview.id + '/usage?after=' + after + '&order=' + order, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setPage(value); })
      .catch(error => { if (!controller.signal.aborted) setError((error as Error).message); });
    return () => controller.abort();
  }, [expanded, after, order, overview.id, overview.state]);
  return <details className="session-usage" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>Usage and input-token ranking</summary>
    {expanded ? <div className="session-usage-body">
    {!overview.callCount ? <p className="notice">No supported provider usage found. Runtime counters are not substituted.</p> : null}
    <div id="usage-breakdown">
      <label>Response order <select value={order} onChange={event => { setOrder(event.target.value as typeof order); setAfter(0); }}><option value="source">Source order</option><option value="input">Input tokens: highest first</option></select></label>
      {order === 'input' ? <p className="muted">Ranks resolved responses with reported input totals. Unknown or conflicting measurements follow without a rank. Source order breaks ties. These totals do not attribute tokens to activity categories or prove active context.</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : !page ? <p className="notice">Loading usage…</p> : <>
        <div className="ledger-table"><table><thead><tr>{order === 'input' ? <th>Rank</th> : null}<th>Source / status</th>{metrics.map(([key, label]) => <th key={key}>{label}</th>)}<th>Evidence</th></tr></thead><tbody>{page.calls.flatMap((call, position) => call.variants.map((variant, i) => <tr key={call.id + ':' + i}>
          {order === 'input' ? <td>{call.status === 'resolved' && call.variants.length === 1 && variant.values.input !== null ? after + position + 1 : '—'}</td> : null}
          <td><strong>Line {variant.ref.line}</strong><br />{call.status === 'resolved' ? 'Included' : 'Excluded'}{call.variants.length > 1 ? ' · variant ' + (i + 1) : ''}<details><summary>Identity and scope</summary>{call.identityDetail}<br />Recorded response; invocation scope unknown.<br />Actor: <span className="path">{call.actorId}</span>{call.model ? <><br />Model: {call.model}</> : null}</details></td>
          {metrics.map(([key]) => <td key={key}>{shown(variant.values[key])}</td>)}
          <td><button onClick={() => onInspect(variant.ref)}>Inspect line {variant.ref.line} ↗</button><br />{variant.matchingRefs} retained matching reference{variant.matchingRefs === 1 ? '' : 's'}</td>
        </tr>))}</tbody></table></div>
        <div className="pager"><button disabled={!after} onClick={() => setAfter(Math.max(0, after - 20))}>Previous responses</button><button disabled={page.after === undefined} onClick={() => setAfter(page.after!)}>Next responses →</button></div>
      </>}
    </div>
    </div> : null}
  </details>;
}
