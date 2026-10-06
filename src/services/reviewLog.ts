/** A review's log, kept short: every failure, then the newest steps up to `max`, in order. */
export function trimReviewLog<T extends { message: string }>(log: T[], max: number): T[] {
  if (log.length <= max) { return log; }
  const failures = new Set(log.filter(entry => /\bfail|\berror/i.test(entry.message)).slice(-max));
  const rest = log.filter(entry => !failures.has(entry)).slice(-Math.max(0, max - failures.size));
  const kept = new Set([...failures, ...rest]);
  return log.filter(entry => kept.has(entry));
}
