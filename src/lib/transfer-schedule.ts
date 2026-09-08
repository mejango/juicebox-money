/**
 * Describe when transfers are paused across a project's whole stage schedule.
 *
 * A revnet's stages are queued once at deployFor and no revnet actor holds
 * QUEUE_RULESETS, so the answer is settled for the project's lifetime. Saying
 * "transfers allowed now" reported the clock rather than the agreement, and went stale
 * the moment a stage rolled over. Kept identical to revnet-money's copy of this.
 */
export function describeTransferSchedule(
  stages: { stage: number; paused: boolean }[] | null,
): string | null {
  if (!stages?.length) return null
  if (stages.every(entry => !entry.paused)) return 'Transfers allowed in every stage'
  if (stages.every(entry => entry.paused)) return 'Transfers paused in every stage'

  const runs: { paused: boolean; from: number; to: number }[] = []
  for (const entry of stages) {
    const last = runs[runs.length - 1]
    if (last && last.paused === entry.paused) last.to = entry.stage
    else runs.push({ paused: entry.paused, from: entry.stage, to: entry.stage })
  }

  // The final stage never ends, so it reads as "from stage N", not a closed range.
  return runs
    .map((run, index) => {
      const verb = run.paused ? 'paused' : 'allowed'
      if (index === runs.length - 1) return `${verb} from stage ${run.from}`
      if (run.from === run.to) return `${verb} in stage ${run.from}`
      return `${verb} in stages ${run.from}–${run.to}`
    })
    .join(', ')
    .replace(/^./u, character => character.toUpperCase())
}
