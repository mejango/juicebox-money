import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorityCall, AuthorityProgress, AuthorityResult } from '@/lib/authority'

const authority = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('@/lib/authority', () => ({ runAuthorityCalls: authority.run }))
vi.mock('@/lib/relayr', () => ({
  RelayrDiscardError: class RelayrDiscardError extends Error {
    readonly name = 'RelayrDiscardError'
    constructor(readonly scope: string, readonly reason: string) { super('Discard it.') }
  },
  discardRelayrSession: vi.fn(),
}))

import { useAuthorityRun } from '@/hooks/useAuthorityRun'
import { RelayrDiscardError } from '@/lib/relayr'

type Plan = { calls: AuthorityCall[] }
type Run = ReturnType<typeof useAuthorityRun<Plan>>
const plan: Plan = { calls: [{ chainId: 1, authority: '0x01', target: '0x02', data: '0x' }, { chainId: 10, authority: '0x01', target: '0x02', data: '0x' }] as unknown as AuthorityCall[] }
const result: AuthorityResult = { directResults: [], relayrGroups: 0, relayrResults: [], safeResults: [] }

const Harness = forwardRef<Run, { onReviewDropped: () => void }>(function Harness(props, ref) {
  const run = useAuthorityRun<Plan>(props)
  useImperativeHandle(ref, () => run, [run])
  return null
})

async function render() {
  const ref = createRef<Run>()
  const dropped = vi.fn()
  await act(async () => { TestRenderer.create(createElement(Harness, { ref, onReviewDropped: dropped })) })
  return { run: () => ref.current!, dropped }
}

const send = (run: Run) => run.run({ outcome: () => 'Done on 2 chains.', failure: 'Could not run.' })

beforeEach(() => { authority.run.mockReset() })

describe('useAuthorityRun', () => {
  it('runs the review, keeps the failed step for Retry, and a retry completes it', async () => {
    const { run } = await render()
    await act(async () => { run().review(plan) })
    expect(run().state).toEqual({ status: 'review', plan })
    expect(run().progress(() => {})).toMatchObject({ activeIndex: -1, busy: false, next: null })

    authority.run.mockImplementationOnce(async ({ onProgress }: { onProgress: (p: AuthorityProgress) => void }) => {
      onProgress({ kind: 'checking', message: 'Checking…' })
      onProgress({ kind: 'direct', message: 'Confirming 2/2', index: 1 })
      throw new Error('Rejected in wallet.')
    })
    await act(async () => { await send(run()) })
    expect(run().state).toMatchObject({ status: 'failed', step: 1, line: 'Confirming 2/2', error: 'Rejected in wallet.' })
    expect(run().progress(() => {})).toMatchObject({ activeIndex: 1, error: 'Rejected in wallet.', next: { label: 'Retry', disabled: false } })
    expect(run().progress(() => {}, { retryable: false }).next).toMatchObject({ disabled: true })

    authority.run.mockResolvedValueOnce(result)
    await act(async () => { await send(run()) })
    expect(run().state).toMatchObject({ status: 'done', line: 'Done on 2 chains.' })
    expect(run().progress(() => {})).toMatchObject({ complete: true, error: null, next: null })

    let finished = false
    await act(async () => { finished = run().close() })
    expect(finished).toBe(true)
    expect(run().state).toEqual({ status: 'idle' })
  })

  it('sends nothing twice and cannot be closed or dismissed while running', async () => {
    const { run } = await render()
    await act(async () => { run().review(plan) })
    let finish!: (value: AuthorityResult) => void
    authority.run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    let first!: Promise<void>
    await act(async () => { first = send(run()) })
    expect(run().busy).toBe(true)
    await act(async () => { await send(run()); run().dismiss(); expect(run().close()).toBe(false) })
    expect(authority.run).toHaveBeenCalledOnce()
    expect(run().state.status).toBe('running')
    await act(async () => { finish(result); await first })
    expect(run().done).toBe(true)
  })

  it('shows a saved session to discard in place of the error, and Discard drops the review', async () => {
    const { run, dropped } = await render()
    await act(async () => { run().review(plan) })
    authority.run.mockRejectedValueOnce(new RelayrDiscardError('scope', 'expired' as never))
    await act(async () => { await send(run()) })
    expect(run().discard.active).toBe(true)
    expect(run().progress(() => {})).toMatchObject({ error: null, next: { disabled: true } })
    await act(async () => { await (run().discard.element as { props: { onDiscarded: () => Promise<void> } }).props.onDiscarded() })
    expect(run().state).toEqual({ status: 'idle' })
    expect(dropped).toHaveBeenCalledOnce()
  })
})
