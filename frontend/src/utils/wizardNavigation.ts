export function canNavigateToWizardStep<T>({
  activeIndex,
  completedFlows,
  stepFlows,
  targetIndex,
}: {
  activeIndex: number;
  completedFlows: ReadonlySet<T>;
  stepFlows: readonly T[];
  targetIndex: number;
}) {
  if (targetIndex < 0 || targetIndex >= stepFlows.length) return false;
  if (targetIndex <= activeIndex) return true;
  return stepFlows.slice(0, targetIndex).every((flow) => completedFlows.has(flow));
}
