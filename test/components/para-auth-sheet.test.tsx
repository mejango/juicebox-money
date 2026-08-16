// @vitest-environment jsdom
import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

const para = vi.hoisted(() => ({
  verifyNewAccountAsync: vi.fn(),
  waitForWalletCreation: vi.fn(async () => ({ walletIds: {} })),
  openedUrls: [] as string[],
}))

vi.mock('@getpara/react-sdk-lite', () => ({
  useAuthenticateWithEmailOrPhone: () => ({
    authenticateWithEmailOrPhoneAsync: vi.fn(),
    error: null,
  }),
  useAuthenticateWithOAuth: () => ({
    authenticateWithOAuthAsync: vi.fn(),
    error: null,
  }),
  useVerifyNewAccount: () => ({
    verifyNewAccountAsync: para.verifyNewAccountAsync,
    isPending: false,
    error: null,
  }),
  useResendVerificationCode: () => ({ resendVerificationCodeAsync: vi.fn() }),
}))

vi.mock('@/providers/para-config', () => ({
  getParaClient: () => ({
    onStatePhaseChange: (listener: (snapshot: unknown) => void) => {
      listener({
        authPhase: 'awaiting_account_verification',
        corePhase: 'unauthenticated',
        authStateInfo: {},
      })
      return () => {}
    },
    waitForWalletCreation: para.waitForWalletCreation,
  }),
  PARA_APP: { appName: 'Juicebox' },
}))

vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ connectors: [], connectWith: vi.fn() }),
}))
vi.mock('@/hooks/useMobileWallet', () => ({ useMobileWallet: () => null }))

const { default: ParaAuthSheet } = await import('@/providers/ParaAuthSheet')

describe('ParaAuthSheet verification', () => {
  it('opens the key-creation window the verify call answers with, then waits for it', async () => {
    // The URL comes back in this promise, NOT in the state stream the popup
    // effect watches. Nothing else advances a signup, so missing it leaves the
    // sheet at "Verifying…" forever.
    para.verifyNewAccountAsync.mockResolvedValue({
      passkeyUrl: 'https://app.getpara.com/v2/signup/passkey',
    })
    const open = vi.spyOn(window, 'open').mockImplementation(url => {
      para.openedUrls.push(String(url))
      return null
    })

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ParaAuthSheet, {
          entry: 'me@example.com',
          onEntryChange: () => {},
          onClose: () => {},
        }),
      )
    })

    const field = renderer.root.findAll(
      node => node.props['aria-label'] === 'Verification code',
    )[0]
    await act(async () => field.props.onChange({ target: { value: '089262' } }))

    const verify = renderer.root
      .findAllByType('button')
      .find(button => String(button.children.join('')).includes('Verify'))!
    await act(async () => verify.props.onClick())

    expect(para.openedUrls).toContain(
      'https://app.getpara.com/v2/signup/passkey',
    )
    expect(para.waitForWalletCreation).toHaveBeenCalled()
    open.mockRestore()
  })
})
