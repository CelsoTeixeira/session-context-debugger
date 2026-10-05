import type { Overview } from '../core/types';

export function CoverageNotes({ overview }: { overview: Overview }) {
  if (!overview.warnings.length) return null;
  const coverage = overview.coverage;
  const attention = overview.state === 'error' || overview.state === 'cancelled'
    || (overview.state === 'ready' && !coverage.complete)
    || coverage.pendingBytes > 0 || coverage.dispositions.malformed > 0
    || coverage.dispositions.limited > 0 || coverage.normalizationLimited > 0;
  return <details className={'coverage-notes' + (attention ? ' attention' : '')} onKeyDown={event => {
    if (event.key === 'Escape') {
      event.currentTarget.open = false;
      event.currentTarget.querySelector('summary')?.focus();
    }
  }}>
    <summary>Coverage notes · {overview.warnings.length}</summary>
    <div className="coverage-notes-body">
      <strong>Recording coverage</strong>
      <ul>{overview.warnings.map((warning, i) => <li key={i}>{warning === 'Unknown shapes are preserved in the source ledger.'
        ? 'Some record types aren’t recognized yet. Their raw data is preserved in the source ledger, but the timeline may omit details.'
        : warning}</li>)}</ul>
    </div>
  </details>;
}
