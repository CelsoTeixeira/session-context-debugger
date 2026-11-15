import type { UsageJump } from '../core/types';

export interface TimelineTarget {
  id: string;
  position: number;
  usage?: UsageJump;
}

export interface TimelineTargetRequest extends TimelineTarget {
  sessionId: string;
  serial: number;
}
