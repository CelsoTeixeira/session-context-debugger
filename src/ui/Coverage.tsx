import { useEffect, useState } from 'react';
import type { Overview, RecordMeta, SourceRef } from '../core/types';
import { api } from './api';

interface Page { records: RecordMeta[]; after?: number }
export function Coverage({ overview, onInspect }: { overview: Overview; onInspect: (ref: SourceRef) => void }) {
  const [page, setPage] = useState<Page>();
  const [after, setAfter] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api<Page>('/api/sessions/' + overview.id + '/ledger?after=' + after, { signal: controller.signal })
      .then(setPage).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [overview.id, overview.state, after]);
  const ledger = overview.coverage;
  return <details className="coverage-panel">
    <summary><span>Source coverage</span><span className="muted">{ledger.completeLines.toLocaleString()} complete lines · {ledger.complete ? 'snapshot scanned' : 'scan incomplete'}</span></summary>
    <div className="coverage-body">
      <div className="coverage-counts">{Object.entries(ledger.dispositions).map(([kind, count]) => <div key={kind}><span>{kind}</span><strong>{count.toLocaleString()}</strong></div>)}</div>
      <p className="muted">{ledger.scannedBytes.toLocaleString()} / {ledger.inspectedBytes.toLocaleString()} bytes scanned. Pending tail: {ledger.pendingBytes.toLocaleString()} bytes. Physical lines and normalized items are different counts.</p>
      <p className="muted">Normalization budget: {(overview.limits.parseBytes / 1024 / 1024).toFixed(0)} MiB per record. Oversized records retain byte references and hashes. {ledger.indexedRecords.toLocaleString()} records retained; {ledger.normalizationLimited.toLocaleString()} evidence items omitted by the item limit.</p>
      <div className="type-counts"><strong>Outer / payload / item types</strong>{[ledger.outerTypes, ledger.payloadTypes, ledger.itemTypes].map((types, index) => <p key={index}>{Object.entries(types).map(([type, count]) => type + ': ' + count).join(' · ') || '(none)'}</p>)}</div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="ledger-table"><table><thead><tr><th>Line</th><th>Captured types</th><th>Disposition</th><th>Bytes</th><th>Source</th></tr></thead><tbody>
        {page?.records.map(record => <tr key={record.ref.id}><td>{record.ref.line}</td><td>{[record.outerType, record.payloadType, record.itemType].filter(Boolean).join(' / ')}</td><td title={record.reason}>{record.disposition}{record.reason ? ' · ' + record.reason : ''}</td><td>{record.ref.byteLength.toLocaleString()}</td><td><button onClick={() => onInspect(record.ref)}>Inspect ↗</button></td></tr>)}
      </tbody></table></div>
      <div className="pager">{after ? <button onClick={() => setAfter(0)}>First page</button> : null}{page?.after ? <button onClick={() => setAfter(page.after!)}>Next records →</button> : null}</div>
    </div>
  </details>;
}
