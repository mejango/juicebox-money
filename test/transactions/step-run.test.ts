import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewedResult } from '@bananapus/nana-sdk-core/review'
import type { ReviewedActionState, ReviewedRun } from '@/hooks/useReviewedAction'
import { useStepRun, type StepRunAction } from '@/hooks/useStepRun'

const saved = vi.hoisted(() => ({ calls: null as unknown[] | null, held: undefined as number | undefined }))
vi.mock('@/lib/reviewed-send', () => ({
  SAVED_SEQUENCE_LINE: 'Saved as reviewed.',
  sequenceCalls: async (scope: string, _account: string, calls: unknown[]) => ({ calls: saved.calls ?? calls, saved: !!saved.calls, scope, ...(saved.held !== undefined ? { held: saved.held } : {}) }),
}))

type Tx = ReviewedActionState
type Run = ReturnType<typeof useStepRun<string>>
type Props = { tx: Tx; send: Tx['run']; action: (steps: readonly string[]) => StepRunAction | null; onFinish: (hash: Hex) => void }

const ACCOUNT = '0x00000000000000000000000000000000000000a1'
const H1 = `0x${'01'.repeat(32)}` as Hex
const H2 = `0x${'02'.repeat(32)}` as Hex
const H3 = `0x${'03'.repeat(32)}` as Hex
const call = (step: string) => ({ chainId: 1, to: ACCOUNT, data: '0x', value: 0n, label: step }) as unknown as StepRunAction['calls'][number]

const Harness = forwardRef<Run, Props>(function Harness(props, ref) {
  const run = useStepRun<string>(props)
  useImperativeHandle(ref, () => run, [run])
  return null
})

beforeEach(() => {
  saved.calls = null
  saved.held = undefined
})

/** The engine's state as useReviewedAction reports it, and runs whose ends each test gives. */
async function renderRun() {
  const ref = createRef<Run>()
  const reset = vi.fn()
  const runs: { action: ReviewedRun; end: (result: ReviewedResult | null) => Promise<void> }[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  const onFinish = vi.fn()
  const action = vi.fn((steps: readonly string[]): StepRunAction => ({ account: ACCOUNT, scope: 'jbm:liquidity:pool', calls: steps.map(call) }))
  const run = vi.fn((sent: ReviewedRun) => new Promise<ReviewedResult | null>(resolve => {
    runs.push({ action: sent, end: async result => { await act(async () => resolve(result)) } })
  }))
  let tx = { phase: 'idle', busy: false, step: 0, hash: null, failure: null, receipt: null, reset, run } as unknown as Tx
  const render = () => createElement(Harness, { ref, tx, send: run, action, onFinish })
  await act(async () => {
    renderer = TestRenderer.create(render())
  })
  const engine = async (next: Partial<Tx>) => {
    tx = { ...tx, ...next } as Tx
    await act(async () => renderer.update(render()))
  }
  /** The wallet took step `step` of the latest run. */
  const submitted = async (step: number, hash: Hex) => {
    const latest = runs.at(-1)!.action
    await act(async () => { await latest.onSubmitted?.(latest.calls[step], step, hash, { safe: false, adopted: false }) })
  }
  return { ref, run, runs, action, reset, onFinish, engine, submitted }
}

describe('useStepRun', () => {
  it('sends every step as one reviewed run, each after the one before it', async () => {
    const t = await renderRun()
    await act(async () => { void t.ref.current!.start(['approve', 'permit', 'mint']) })
    expect(t.run).toHaveBeenCalledOnce()
    const sent = t.runs[0].action
    expect(sent.calls.map(c => [c.label, !!c.dependsOnPrior])).toEqual([['approve', false], ['permit', true], ['mint', true]])
    expect(sent).toMatchObject({ account: ACCOUNT, scope: 'jbm:liquidity:pool' })
    expect(t.ref.current).toMatchObject({ running: true, index: 0 })

    await t.submitted(1, H2)
    expect(t.ref.current!.index).toBe(1)
    await t.runs[0].end({ status: 'done', hashes: [H1, H2, H3], receipts: [] })
    expect(t.onFinish).toHaveBeenCalledWith(H3)
    expect(t.ref.current).toMatchObject({ running: false, index: 3 })
  })

  it('stops after the last step the wallet took, and resumes with the same frozen calls', async () => {
    const t = await renderRun()
    const plan = ['approve', 'permit', 'mint']
    await act(async () => { void t.ref.current!.start(plan) })
    await t.submitted(0, H1)
    await t.engine({ phase: 'error' })
    await t.runs[0].end(null)
    expect(t.ref.current).toMatchObject({ running: false, index: 1 })
    expect(t.ref.current!.stoppedOn(plan)).toBe(true)

    await act(async () => { expect(t.ref.current!.resume(plan)).toBe(true) })
    expect(t.run).toHaveBeenCalledTimes(2)
    expect(t.runs[1].action.calls).toBe(t.runs[0].action.calls)
    expect(t.action).toHaveBeenCalledOnce()
  })

  it('stops on the step that reverted', async () => {
    const t = await renderRun()
    await act(async () => { void t.ref.current!.start(['approve', 'mint']) })
    await t.submitted(1, H2)
    const failure = Object.assign(new Error('reverted'), { name: 'ReviewedCallRevertedError', receipt: { status: 'reverted' } })
    await t.engine({ phase: 'error', failure })
    await t.runs[0].end(null)
    expect(t.ref.current!.index).toBe(1)
  })

  it('belongs to the steps it started with: another plan is never stopped and never resumed', async () => {
    const t = await renderRun()
    const plan = ['approve', 'mint']
    await act(async () => { void t.ref.current!.start(plan) })
    await t.engine({ phase: 'error' })
    await t.runs[0].end(null)
    const other = ['approve', 'mint']
    expect(t.ref.current!.stoppedOn(other)).toBe(false)
    expect(t.ref.current!.resume(other)).toBe(false)
    expect(t.run).toHaveBeenCalledOnce()
  })

  it('ends on a step proposed to a Safe, and stops at the next step once the Safe executes it', async () => {
    const t = await renderRun()
    const plan = ['approve', 'mint']
    await act(async () => { void t.ref.current!.start(plan) })
    await t.engine({ phase: 'submitted' })
    await t.runs[0].end({ status: 'proposed', step: 0, safeTxHash: H1 })
    expect(t.ref.current).toMatchObject({ running: false, proposed: true, index: 0 })

    await t.engine({ phase: 'success', hash: H1 })
    expect(t.ref.current).toMatchObject({ proposed: false, index: 1 })
    expect(t.onFinish).not.toHaveBeenCalled()
    expect(t.ref.current!.stoppedOn(plan)).toBe(true)
    expect(t.run).toHaveBeenCalledOnce()
  })

  it('finishes a run whose last step was proposed once the Safe executes it', async () => {
    const t = await renderRun()
    await act(async () => { void t.ref.current!.start(['mint']) })
    await t.runs[0].end({ status: 'proposed', step: 0, safeTxHash: H1 })
    await t.engine({ phase: 'success', hash: H2 })
    expect(t.onFinish).toHaveBeenCalledWith(H2)
  })

  it('stops on a proposed step that ends without running', async () => {
    const t = await renderRun()
    const plan = ['approve', 'mint']
    await act(async () => { void t.ref.current!.start(plan) })
    await t.runs[0].end({ status: 'proposed', step: 0, safeTxHash: H1 })
    await t.engine({ phase: 'error' })
    expect(t.ref.current).toMatchObject({ proposed: false, index: 0 })
    expect(t.ref.current!.stoppedOn(plan)).toBe(true)
  })

  it('suspends on an unconfirmed step, and finishes when its receipt shows up', async () => {
    const t = await renderRun()
    await act(async () => { void t.ref.current!.start(['approve', 'mint']) })
    await t.submitted(1, H2)
    await t.engine({ phase: 'unconfirmed' })
    await t.runs[0].end(null)
    expect(t.ref.current).toMatchObject({ unconfirmed: true, index: 1 })
    await t.engine({ phase: 'success', hash: H2 })
    expect(t.onFinish).toHaveBeenCalledWith(H2)
    expect(t.run).toHaveBeenCalledOnce()
  })

  it('stops at the next step once an earlier step confirms after its run ended', async () => {
    const t = await renderRun()
    const plan = ['approve', 'mint']
    await act(async () => { void t.ref.current!.start(plan) })
    await t.submitted(0, H1)
    await t.engine({ phase: 'unconfirmed' })
    await t.runs[0].end(null)
    // Core ends an earlier step's late settle as idle, with the step it settled.
    await t.engine({ phase: 'idle', settledStep: 0, hash: H1 })
    expect(t.ref.current).toMatchObject({ unconfirmed: false, index: 1 })
    expect(t.ref.current!.stoppedOn(plan)).toBe(true)
    expect(t.onFinish).not.toHaveBeenCalled()
  })

  it('continues a saved sequence as it was reviewed, never under the new plan\'s summary or checks', async () => {
    saved.calls = [call('mint')]
    const t = await renderRun()
    t.action.mockImplementation(steps => ({ account: ACCOUNT, scope: 'jbm:liquidity:pool', calls: steps.map(call), context: [{ label: 'Adds', value: '10 JBT' }], reverify: async () => {} }))
    await act(async () => { void t.ref.current!.start(['approve', 'mint']) })
    expect(t.runs[0].action.calls).toEqual([call('mint')])
    expect(t.runs[0].action).not.toHaveProperty('context')
    expect(t.runs[0].action).not.toHaveProperty('reverify')
    expect(t.runs[0].action.description).toBe('Saved as reviewed.')
    await t.submitted(0, H2)
    expect(t.ref.current!.index).toBe(1)
  })

  it('finishes a restored run whose last step is still held once that step settles', async () => {
    saved.calls = [call('approve'), call('mint')]
    saved.held = 1
    const t = await renderRun()
    const plan = ['approve', 'mint']
    await act(async () => { void t.ref.current!.start(plan) })
    // Core refuses to resend the held step: the run ends on its hold, with no step taken this time.
    await t.engine({ phase: 'unconfirmed' })
    await t.runs[0].end(null)
    expect(t.ref.current).toMatchObject({ unconfirmed: true, index: 1 })
    await t.engine({ phase: 'success', hash: H2 })
    expect(t.onFinish).toHaveBeenCalledWith(H2)
    expect(t.run).toHaveBeenCalledOnce()
  })

  it('shows the step core is on while it is simulated and signed, before the wallet takes it', async () => {
    const t = await renderRun()
    await act(async () => { void t.ref.current!.start(['approve', 'mint']) })
    await t.submitted(0, H1)
    await t.engine({ phase: 'signing', busy: true, step: 1 })
    expect(t.ref.current!.index).toBe(1)
  })

  it('forgets a stopped run and resets the engine when the plan is dropped, ignoring its late end', async () => {
    const t = await renderRun()
    const plan = ['approve', 'mint']
    await act(async () => { void t.ref.current!.start(plan) })
    act(() => t.ref.current!.clear())
    expect(t.reset).toHaveBeenCalled()
    await t.runs[0].end({ status: 'done', hashes: [H1, H2], receipts: [] })
    expect(t.onFinish).not.toHaveBeenCalled()
    expect(t.ref.current).toMatchObject({ running: false, index: 0 })
    expect(t.ref.current!.stoppedOn(plan)).toBe(false)
  })

  it('holds the run busy for other work until it ends', async () => {
    const t = await renderRun()
    let finish!: () => void
    const work = new Promise<void>(resolve => (finish = resolve))
    let held!: Promise<void>
    act(() => { held = t.ref.current!.hold(() => work) })
    expect(t.ref.current!.running).toBe(true)
    await act(async () => { finish(); await held })
    expect(t.ref.current!.running).toBe(false)
    expect(t.run).not.toHaveBeenCalled()
  })
})
