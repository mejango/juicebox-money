import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { Address, Hex } from 'viem'
import type { Permit2SignatureAuthorization } from '@bananapus/nana-sdk-core/v6/permit2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: undefined as Address | undefined,
  chainId: 8453,
  connectorUid: 'reviewed-wallet',
  getAccount: vi.fn(),
  review: vi.fn(),
  sign: vi.fn(),
  switchChain: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({ getAccount: mocks.getAccount }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('wagmi', () => ({
  useConfig: () => ({}),
  useSignTypedData: () => ({ signTypedDataAsync: mocks.sign }),
  useSwitchChain: () => ({ switchChainAsync: mocks.switchChain }),
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requireTransactionReview: mocks.review,
}))

import { useReviewedPermit2Signature } from '@/hooks/useReviewedPermit2Signature'
import { REVIEWED_ACCOUNT_CHANGED } from '@/lib/contract-write'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const TOKEN = '0x3333333333333333333333333333333333333333' as Address
const SPENDER = '0x4444444444444444444444444444444444444444' as Address
const SIGNATURE = `0x${'ab'.repeat(65)}` as Hex
const authorization: Permit2SignatureAuthorization = {
  chainId: 8453,
  token: TOKEN,
  spender: SPENDER,
  amount: 25_000_000n,
  expiration: 1_799_999_900,
  nonce: 7,
  sigDeadline: 1_799_999_900n,
}

type Signer = ReturnType<typeof useReviewedPermit2Signature>

const Harness = forwardRef<Signer, { reviewedInParent?: boolean }>(function Harness(props, ref) {
  const value = useReviewedPermit2Signature(props)
  useImperativeHandle(ref, () => value, [value])
  return null
})

async function signer(props: { reviewedInParent?: boolean } = {}) {
  const ref = createRef<Signer>()
  await act(async () => {
    TestRenderer.create(createElement(Harness, { ...props, ref }))
  })
  return ref.current!
}

beforeEach(() => {
  mocks.account = ALICE
  mocks.chainId = 8453
  mocks.connectorUid = 'reviewed-wallet'
  mocks.getAccount.mockImplementation(() => ({ address: mocks.account, chainId: mocks.chainId, connector: { uid: mocks.connectorUid } }))
  mocks.review.mockResolvedValue(undefined)
  mocks.switchChain.mockImplementation(async ({ chainId }: { chainId: number }) => { mocks.chainId = chainId })
  mocks.sign.mockResolvedValue(SIGNATURE)
})

afterEach(() => clearViewAs())

describe('reviewed Permit2 signature', () => {
  it('signs the reviewed PermitSingle for the reviewed account on the authorization chain', async () => {
    mocks.chainId = 1
    const { signPermit2Async } = await signer()
    await expect(signPermit2Async({ authorization, expectedAccount: ALICE })).resolves.toBe(SIGNATURE)
    expect(mocks.review).toHaveBeenCalledWith(expect.objectContaining({ kind: 'authorization' }))
    expect(mocks.switchChain).toHaveBeenCalledWith({ chainId: 8453 })
    expect(mocks.sign).toHaveBeenCalledWith(expect.objectContaining({
      account: ALICE,
      primaryType: 'PermitSingle',
      message: expect.objectContaining({ spender: SPENDER }),
    }))
    expect(mocks.review.mock.invocationCallOrder[0]).toBeLessThan(mocks.sign.mock.invocationCallOrder[0])
  })

  it('refuses while the site views as another account, before the review opens', async () => {
    setViewAs(BOB)
    const { signPermit2Async } = await signer()
    await expect(signPermit2Async({ authorization, expectedAccount: ALICE })).rejects.toThrow(VIEW_AS_WRITE_BLOCKED)
    expect(mocks.review).not.toHaveBeenCalled()
    expect(mocks.sign).not.toHaveBeenCalled()
  })

  it('refuses another connected account before the review opens', async () => {
    mocks.account = BOB
    const { signPermit2Async } = await signer()
    await expect(signPermit2Async({ authorization, expectedAccount: ALICE })).rejects.toThrow(REVIEWED_ACCOUNT_CHANGED)
    expect(mocks.review).not.toHaveBeenCalled()
    expect(mocks.sign).not.toHaveBeenCalled()
  })

  it('refuses when view-as starts while the review is open, before switching chains or signing', async () => {
    mocks.chainId = 1
    mocks.review.mockImplementationOnce(async () => setViewAs(BOB))
    const { signPermit2Async } = await signer()
    await expect(signPermit2Async({ authorization, expectedAccount: ALICE })).rejects.toThrow(VIEW_AS_WRITE_BLOCKED)
    expect(mocks.switchChain).not.toHaveBeenCalled()
    expect(mocks.sign).not.toHaveBeenCalled()
  })

  it('refuses when view-as starts while the wallet switches chains, before signing', async () => {
    mocks.chainId = 1
    mocks.switchChain.mockImplementationOnce(async ({ chainId }: { chainId: number }) => {
      mocks.chainId = chainId
      setViewAs(BOB)
    })
    const { signPermit2Async } = await signer({ reviewedInParent: true })
    await expect(signPermit2Async({ authorization, expectedAccount: ALICE })).rejects.toThrow(VIEW_AS_WRITE_BLOCKED)
    expect(mocks.review).not.toHaveBeenCalled()
    expect(mocks.sign).not.toHaveBeenCalled()
  })

  it('discards a signature made while view-as started, so nothing is sent with it', async () => {
    mocks.sign.mockImplementationOnce(async () => {
      setViewAs(BOB)
      return SIGNATURE
    })
    const { signPermit2Async } = await signer()
    await expect(signPermit2Async({ authorization, expectedAccount: ALICE })).rejects.toThrow(VIEW_AS_WRITE_BLOCKED)
    expect(mocks.sign).toHaveBeenCalledTimes(1)
  })

  it('refuses an account switched to during the review', async () => {
    mocks.review.mockImplementationOnce(async () => { mocks.account = BOB })
    const { signPermit2Async } = await signer()
    await expect(signPermit2Async({ authorization, expectedAccount: ALICE })).rejects.toThrow(REVIEWED_ACCOUNT_CHANGED)
    expect(mocks.sign).not.toHaveBeenCalled()
  })

  it.each(['review', 'switch', 'signature'] as const)('refuses a replacement connector after the awaited %s', async stage => {
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    if (stage === 'review') mocks.review.mockImplementationOnce(() => paused)
    if (stage === 'switch') {
      mocks.chainId = 1
      mocks.switchChain.mockImplementationOnce(async () => { await paused; mocks.chainId = 8453 })
    }
    if (stage === 'signature') mocks.sign.mockImplementationOnce(async () => { await paused; return SIGNATURE })
    const { signPermit2Async } = await signer()
    const signing = signPermit2Async({ authorization, expectedAccount: ALICE })
    await vi.waitFor(() => expect(stage === 'review' ? mocks.review : stage === 'switch' ? mocks.switchChain : mocks.sign).toHaveBeenCalled())
    mocks.connectorUid = 'replacement-wallet'
    const refused = expect(signing).rejects.toThrow(/changed/)
    release()
    await refused
    expect(mocks.sign).toHaveBeenCalledTimes(stage === 'signature' ? 1 : 0)
  })

  it('discards a signature when the wallet changes account or chain while signing', async () => {
    mocks.sign.mockImplementationOnce(async () => {
      mocks.chainId = 1
      return SIGNATURE
    })
    const { signPermit2Async } = await signer()
    await expect(signPermit2Async({ authorization, expectedAccount: ALICE })).rejects.toThrow(/changed after signing/)
  })
})
