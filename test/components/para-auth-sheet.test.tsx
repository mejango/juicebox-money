// @vitest-environment jsdom
import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const para = vi.hoisted(() => ({
  verifyNewAccountAsync: vi.fn(),
  waitForWalletCreation: vi.fn(async () => ({ walletIds: {} })),
  authStateInfo: {} as Record<string, string>,
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
        authStateInfo: para.authStateInfo,
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
  beforeEach(() => {
    para.authStateInfo = {}
    para.openedUrls.length = 0
  })

  it('sends basic-login accounts to the portal instead of a code field that cannot work', async () => {
    // A `verificationUrl` means Para owns this account's OTP: `verifyNewAccount`
    // is not a call the app may make, and it never settles — so a code field
    // here would accept a wrong code and hang on it forever.
    para.authStateInfo = {
      verificationUrl: 'https://app.getpara.com/v2/login/otp',
    }
    const open = vi.spyOn(window, 'open').mockImplementation(url => {
      para.openedUrls.push(String(url))
      // A claimed window with no URL yet; navigating it is what the sheet does next.
      return {
        closed: false,
        focus: () => {},
        location: { replace: (next: string) => para.openedUrls.push(next) },
      } as unknown as Window
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

    expect(
      renderer.root.findAll(
        node => node.props['aria-label'] === 'Verification code',
      ),
    ).toHaveLength(0)
    // The window Para's URL goes into is claimed inside the click that starts
    // sign-in, so the sheet needs no second button and no popup blocker can eat
    // it.
    expect(para.openedUrls).toContain('https://app.getpara.com/v2/login/otp')
    open.mockRestore()
  })

  it('opens the key-creation window the verify call answers with, then waits for it', async () => {
    // The URL comes back in this promise, NOT in the state stream the popup
    // effect watches. Nothing else advances a signup, so missing it leaves the
    // sheet at "Verifying…" forever.
    para.verifyNewAccountAsync.mockResolvedValue({
      passkeyUrl: 'https://app.getpara.com/v2/signup/passkey',
    })
    const open = vi.spyOn(window, 'open').mockImplementation(url => {
      para.openedUrls.push(String(url))
      // A claimed window with no URL yet; navigating it is what the sheet does next.
      return {
        closed: false,
        focus: () => {},
        location: { replace: (next: string) => para.openedUrls.push(next) },
      } as unknown as Window
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
      .find(button => String(button.children.join('')).includes('Confirm'))!
    await act(async () => verify.props.onClick())

    expect(para.openedUrls).toContain(
      'https://app.getpara.com/v2/signup/passkey',
    )
    expect(para.waitForWalletCreation).toHaveBeenCalled()
    open.mockRestore()
  })
})
