import type { TimelineCategory, TimelineEvent } from './types.js';

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
