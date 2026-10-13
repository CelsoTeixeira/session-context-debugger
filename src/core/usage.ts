import type { ModelCall, UsageSummary } from './types.js';

export function createUsageAccumulator(): UsageSummary {
  const field = () => ({ tokens: null as number | null, calls: 0, overflow: false });
  return { includedCalls: 0, excludedCalls: 0,
    fields: { input: field(), output: field(), cached: field(), cacheCreation: field(), reasoning: field() } };
}

export function accumulateUsageCall(summary: UsageSummary, call: ModelCall): Partial<Record<keyof UsageSummary['fields'], number>> {
  if (call.status !== 'resolved' || call.variants.length !== 1) { summary.excludedCalls++; return {}; }
  summary.includedCalls++;
  const contributions: Partial<Record<keyof UsageSummary['fields'], number>> = {};
  for (const key of Object.keys(summary.fields) as Array<keyof UsageSummary['fields']>) {
    const value = call.variants[0]!.values[key];
    if (value === null || !Number.isSafeInteger(value) || value < 0) continue;
    contributions[key] = value;
    const subtotal = summary.fields[key];
    subtotal.calls++;
    if (subtotal.overflow) continue;
    const total = (subtotal.tokens ?? 0) + value;
    if (!Number.isSafeInteger(total)) { subtotal.overflow = true; subtotal.tokens = null; }
    else subtotal.tokens = total;
  }
  return contributions;
}

export function summarizeUsage(calls: Iterable<ModelCall>): UsageSummary {
  const summary = createUsageAccumulator();
  for (const call of calls) accumulateUsageCall(summary, call);
  return summary;
}
