/** Merge postRefinement.applied into existing performance_prediction JSON (idempotent marker). */
export function mergePerformancePredictionWithRefinementApplied(
  existing: unknown,
): Record<string, unknown> {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  return {
    ...base,
    postRefinement: {
      applied: true,
      at: new Date().toISOString(),
    },
  };
}
