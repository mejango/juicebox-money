export type TxStep = {
  /** Stable list key; falls back to the title when it is a plain string. */
  key?: string
  title: React.ReactNode
  detail?: string
  /** Shown beside the title, for progress that arrives per step. */
  status?: React.ReactNode
  /** Overrides sequential progress when results arrive out of order. */
  state?: 'pending' | 'active' | 'complete' | 'failed'
}

/** The step a stopped run died on shows × and a short status; every other step keeps its sequential state. */
export function withFailedStep(steps: readonly TxStep[], index: number, failed: boolean): readonly TxStep[] {
  if (!failed) return steps
  return steps.map((step, at) => (at === index ? { ...step, state: 'failed', status: 'Failed' } : step))
}

/**
 * A suspended run keeps the step whose receipt is unread marked: the steps before it are done, it stays
 * current with a short status, and the ones after it wait. Explicit states keep a finished dialog from
 * ticking it off.
 */
export function withUnconfirmedStep(steps: readonly TxStep[], index: number, unconfirmed: boolean): readonly TxStep[] {
  if (!unconfirmed) return steps
  return steps.map((step, at) =>
    at < index
      ? { ...step, state: 'complete' }
      : at === index
        ? { ...step, state: 'active', status: 'Not confirmed yet' }
        : { ...step, state: 'pending' },
  )
}

/**
 * The wallet-prompt queue for a multi-transaction flow, shown before the first
 * prompt so a signer knows how many are coming and why. Steps are strictly
 * sequential: everything before `activeIndex` is done, and a flow that has
 * finished passes `steps.length`. Pass -1 while nothing is running yet.
 */
export function TxSteps({
  steps,
  activeIndex,
  intro,
  ariaLabel,
  className = 'mt-3 rounded-xl border border-smoke-200 bg-white p-3',
}: {
  steps: readonly TxStep[]
  activeIndex: number
  intro?: string
  ariaLabel?: string
  className?: string
}) {
  return (
    <div className={className} aria-label={ariaLabel}>
      <p className="text-xs leading-relaxed text-smoke-600">
        {intro ??
          (steps.length === 1
            ? 'Your wallet will ask for one action.'
            : `Your wallet will ask for ${steps.length} actions. This stays open and advances through each one.`)}
      </p>
      <ol className="mt-3 space-y-2">
        {steps.map((step, index) => {
          const state = step.state ?? (activeIndex > index ? 'complete' : activeIndex === index ? 'active' : 'pending')
          const complete = state === 'complete'
          const active = state === 'active'
          const failed = state === 'failed'
          return (
            <li
              key={step.key ?? String(step.title)}
              data-state={state}
              aria-current={active ? 'step' : undefined}
              className="flex items-start gap-2 text-sm"
            >
              <span
                aria-hidden="true"
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${
                  failed
                    ? 'border-red-600 bg-red-50 text-red-700'
                    : complete
                    ? 'border-melon-400 bg-melon-400 text-ink'
                    : active
                      ? 'border-bluebs-500 bg-bluebs-25 text-bluebs-700'
                      : 'border-smoke-300 text-smoke-500'
                }`}
              >
                {failed ? '×' : complete ? '✓' : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={step.status ? 'flex items-baseline justify-between gap-3' : undefined}>
                  <span
                    className={
                      active ? 'font-medium text-ink' : 'block text-smoke-600'
                    }
                  >
                    <span className="sr-only">
                      Step {index + 1} of {steps.length}:{' '}
                    </span>
                    {step.title}
                  </span>
                  {step.status ? (
                    <span className={`shrink-0 text-xs font-medium ${failed ? 'text-red-700' : 'text-ink'}`}>{step.status}</span>
                  ) : null}
                </span>
                {step.detail ? (
                  <span className="mt-0.5 block text-xs text-smoke-500">
                    {step.detail}
                  </span>
                ) : null}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
