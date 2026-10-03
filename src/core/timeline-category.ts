import type { TimelineCategory, TimelineEvent, TimelineFilter } from './types.js';

export function timelineCategoryMatches(category: TimelineCategory, filter: TimelineFilter): boolean {
  return filter === 'all' || (filter === 'tools' ? category === 'tool-call' || category === 'tool-result' : category === filter);
}

// Display groups describe recorded content, not delivery or active context.
export function timelineCategory(event: TimelineEvent): TimelineCategory {
  if (event.representation === 'diagnostic-snapshot') return 'snapshot';
  if (event.kind === 'message') {
    if (event.origin === 'harness-injected') return 'instruction';
    if (event.role === 'user') return 'user';
    if (event.role === 'assistant') return 'assistant';
  }
  return event.kind;
}
