import { useState } from 'react';
import type { Overview, SourceRef, UsageJump } from '../core/types';
import { CategoryRanking } from './CategoryRanking';
import { ContextWindows } from './ContextWindows';
import { CumulativeUsageChart } from './CumulativeUsageChart';
import { SessionUsage } from './SessionUsage';
import { TranscriptBytesChart } from './TranscriptBytesChart';
import { UsageChart } from './UsageChart';
import { RepeatedCaptures } from './RepeatedCaptures';
import { AccessibleTabs } from './AccessibleTabs';
import type { TimelineTarget } from './timelineNavigation';

export function Measurements({ overview, onInspect, onTimelineTarget }: {
  overview: Overview;
  onInspect: (ref: SourceRef) => void;
  onTimelineTarget: (target: TimelineTarget) => void;
}) {
  const [active, setActive] = useState('input');
  const [visited, setVisited] = useState<ReadonlySet<string>>(new Set(['input']));
  function activate(id: string) {
    setActive(id);
    setVisited(old => new Set([...old, id]));
  }
  function showUsage(jump: UsageJump) {
    onTimelineTarget({ id: jump.navigation.target.id, position: jump.navigation.target.position, usage: jump });
  }
  const tabs = [
    { id: 'input', label: 'Input & changes', content: <UsageChart overview={overview} onInspect={onInspect} onShowPoint={showUsage} onShowCompaction={marker => { if (marker.target) onTimelineTarget(marker.target); }} /> },
    { id: 'cumulative', label: 'Cumulative usage', content: <CumulativeUsageChart overview={overview} onInspect={onInspect} onShowPoint={showUsage} onShowCompaction={marker => { if (marker.target) onTimelineTarget(marker.target); }} /> },
    { id: 'responses', label: 'Response ranking', content: <SessionUsage overview={overview} onInspect={onInspect} onNavigate={showUsage} /> },
    { id: 'windows', label: 'Context windows', content: <ContextWindows overview={overview} onInspect={onInspect} onNavigate={target => onTimelineTarget(target)} /> },
    { id: 'transcript', label: 'Transcript bytes', content: <TranscriptBytesChart overview={overview} onInspect={onInspect} onNavigate={target => onTimelineTarget(target)} /> },
    { id: 'captured', label: 'Captured bytes', content: <CategoryRanking overview={overview} onInspect={onInspect} /> },
    { id: 'repeated', label: 'Repeated captures', content: <RepeatedCaptures overview={overview} onInspect={onInspect} onTimelineTarget={onTimelineTarget} /> },
  ];

  return <div className="measurements-workspace">
    <AccessibleTabs id="measurements" label="Measurement views" tabs={tabs} active={active} visited={visited} onActivate={activate} className="measurement-tabs" />
  </div>;
}
