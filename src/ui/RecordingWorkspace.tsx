import { useState } from 'react';
import type { Overview, SourceRef } from '../core/types';
import { api } from './api';
import { AccessibleTabs } from './AccessibleTabs';
import { Beginning } from './Beginning';
import { Coverage } from './Coverage';
import { CoverageNotes } from './CoverageNotes';
import { Measurements } from './Measurements';
import { RelatedSessions } from './RelatedSessions';
import { SessionUsageSummary } from './SessionUsage';
import { Timeline } from './Timeline';
import { SourceSearch } from './SourceSearch';
import type { TimelineTarget, TimelineTargetRequest } from './timelineNavigation';

const formatBytes = (bytes: number): string => bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : (bytes / 1024).toFixed(1) + ' KB';

export function RecordingWorkspace({ overview, navigated, relationRequest, targetRequest, onInspect, onReopen, onOpenRelated, onRelationRequest, onTimelineTarget }: {
  overview: Overview;
  navigated: boolean;
  relationRequest?: { id: string; serial: number };
  targetRequest?: TimelineTargetRequest;
  onInspect: (ref: SourceRef, offset?: number) => void;
  onReopen: () => void;
  onOpenRelated: (resolutionId: string, matchId: string, path: string) => Promise<void>;
  onRelationRequest: (id: string) => void;
  onTimelineTarget: (target: TimelineTarget) => void;
}) {
  const [active, setActive] = useState('timeline');
  const [visited, setVisited] = useState<ReadonlySet<string>>(new Set(['timeline']));
  function activate(id: string) {
    setActive(id);
    setVisited(old => new Set([...old, id]));
  }
  function navigateToTimeline(target: TimelineTarget) {
    activate('timeline');
    onTimelineTarget(target);
  }
  const tabs = [
    { id: 'timeline', label: 'Timeline', content: <Timeline overview={overview} onInspect={onInspect} onRelation={onRelationRequest} targetRequest={targetRequest} /> },
    { id: 'measurements', label: 'Measurements', content: <Measurements overview={overview} onInspect={onInspect} onTimelineTarget={navigateToTimeline} /> },
    { id: 'search', label: 'Search', content: <SourceSearch overview={overview} onInspect={onInspect} onNavigate={match => { if (match.target) navigateToTimeline(match.target); }} /> },
    { id: 'beginning', label: 'Beginning', content: <Beginning overview={overview} onInspect={onInspect} /> },
    { id: 'coverage', label: 'Coverage', content: <Coverage overview={overview} onInspect={onInspect} /> },
  ];

  return <div className="recording-workspace">
    <section className="recording-header" aria-label="Recording details">
      <div className="recording-header-top">
        <div className="recording-header-identity">
          <span className="muted">{overview.source.runtime ?? 'Runtime unknown'} · {overview.source.version ?? 'Version unknown'} · {formatBytes(overview.source.size)}</span>
          <div className="path">{overview.source.originalPath}</div>
        </div>
        <div className="session-actions"><CoverageNotes key={overview.id} overview={overview} /><button onClick={onReopen}>Reopen</button></div>
      </div>
      {overview.relationships.links.length || navigated ? <p className="recording-identity muted">Actor/thread: {overview.source.actorId ?? 'unknown'} · Root session: {overview.source.rootSessionId ?? 'unknown'}<br />Usage belongs to this recording. Linked recordings keep separate measurements.</p> : null}
    </section>
    {overview.state === 'indexing' ? <div className="scan-progress"><progress max={overview.coverage.inspectedBytes || 1} value={overview.coverage.scannedBytes} /><span>Indexing recording… <button onClick={() => void api('/api/sessions/' + overview.id + '/cancel', { method: 'POST', body: '{}' })}>Cancel</button></span></div> : null}
    <SessionUsageSummary overview={overview} />
    <RelatedSessions key={'relations:' + overview.id} overview={overview} request={relationRequest} onInspect={onInspect} onOpen={onOpenRelated} />
    <AccessibleTabs id="recording" label="Recording views" tabs={tabs} active={active} visited={visited} onActivate={activate} className="recording-tabs" />
  </div>;
}
