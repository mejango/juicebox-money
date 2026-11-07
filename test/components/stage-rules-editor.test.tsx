// @vitest-environment jsdom
import { act } from 'react'
import TestRenderer, { type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { StageRulesEditor } from '@/components/create/StageRulesEditor'
import { newDraftStage, type DraftStage } from '@/components/create/stage-draft'
import { newDraftSplit } from '@/components/create/SplitsEditor'

vi.mock('@/components/create/AddressField', () => ({ AddressField: () => null }))
vi.mock('@/components/ChainSelect', () => ({ ChainSelect: () => null }))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function textOf(node: ReactTestInstance): string {
  return node.children.map(child => (typeof child === 'string' ? child : textOf(child))).join('')
}

async function mount(initial: DraftStage) {
  let stage = initial
  let renderer: TestRenderer.ReactTestRenderer
  const element = () => (
    <StageRulesEditor
      stage={stage}
      onChange={next => {
        stage = next
        renderer.update(element())
      }}
      isFirst
      isLast
      index={0}
      unitLabel="ETH"
      disabled={false}
      chainIds={[1]}
      flavor="project"
      tokenLabel="tokens"
      multiToken={false}
    />
  )
  await act(async () => {
    renderer = TestRenderer.create(element())
  })
  const click = async (label: string) => {
    const button = renderer.root.findAllByType('button').find(node => textOf(node).startsWith(label))!
    await act(async () => button.props.onClick())
  }
  return { click, stage: () => stage, root: () => renderer.root }
}

describe('payout unit switch', () => {
  const routed = (value: string) => ({
    ...newDraftStage(true),
    payouts: 'routed' as const,
    open: { payouts: true },
    payoutSplits: [{ ...newDraftSplit(), value, recipient: '0x1111111111111111111111111111111111111111', perChainAmount: { 1: '3' } }],
  })

  it('clears the number when the unit changes, in both directions, and keeps the recipient', async () => {
    const editor = await mount(routed('20'))
    await editor.click('Fixed ETH amounts')
    expect(editor.stage().routedMode).toBe('amounts')
    expect(editor.stage().payoutSplits[0]).toMatchObject({ value: '', perChainAmount: {}, recipient: '0x1111111111111111111111111111111111111111' })
    await act(async () => {
      editor.root().findByProps({ 'aria-label': 'Amount (ETH)' }).props.onChange({ target: { value: '20' } })
    })
    await editor.click('Split all funds by %')
    expect(editor.stage().payoutSplits[0].value).toBe('')
  })

  it('keeps the number when the active unit is clicked again', async () => {
    const editor = await mount(routed('20'))
    await editor.click('Split all funds by %')
    expect(editor.stage().payoutSplits[0].value).toBe('20')
  })
})
