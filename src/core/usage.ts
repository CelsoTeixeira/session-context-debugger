import type { ModelCall, UsageSummary } from './types.js';

export function summarizeUsage(calls: Iterable<ModelCall>): UsageSummary {
  const field = () => ({ tokens: null as number | null, calls: 0, overflow: false });
  const summary: UsageSummary = { includedCalls: 0, excludedCalls: 0,
    fields: { input: field(), output: field(), cached: field(), cacheCreation: field(), reasoning: field() } };
  for (const call of calls) {
    if (call.status !== 'resolved' || call.variants.length !== 1) { summary.excludedCalls++; continue; }
    summary.includedCalls++;
    for (const key of Object.keys(summary.fields) as Array<keyof UsageSummary['fields']>) {
      const value = call.variants[0]!.values[key];
      if (value === null || !Number.isSafeInteger(value) || value < 0) continue;
      const subtotal = summary.fields[key];
      subtotal.calls++;
      if (subtotal.overflow) continue;
      const total = (subtotal.tokens ?? 0) + value;
      if (!Number.isSafeInteger(total)) { subtotal.overflow = true; subtotal.tokens = null; }
      else subtotal.tokens = total;
    }
  }
  return summary;
}
