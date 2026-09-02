// @vitest-environment jsdom
import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const para = vi.hoisted(() => ({
  verifyNewAccountAsync: vi.fn(),
  waitForWalletCreation: vi.fn(async () => ({ walletIds: {} })),
  authStateInfo: {} as Record<string, string>,
  authPhase: 'awaiting_account_verification' as string,
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
        authPhase: para.authPhase,
        corePhase: 'unauthenticated',
        authStateInfo: para.authStateInfo,
      })
      return () => {}
    },
    waitForWalletCreation: para.waitForWalletCreation,
  }),
  PARA_APP: { appName: 'Juicebox' },
  PARA_PORTAL_THEME: { backgroundColor: '#FFF7E8' },
}))

vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ connectors: [], connectWith: vi.fn() }),
}))
vi.mock('@/hooks/useMobileWallet', () => ({ useMobileWallet: () => null }))

const { default: ParaAuthSheet } = await import('@/providers/ParaAuthSheet')

describe('ParaAuthSheet verification', () => {
  beforeEach(() => {
    para.authStateInfo = {}
    para.authPhase = 'awaiting_account_verification'
    para.openedUrls.length = 0
  })

  it("frames Para's code page in the sheet rather than sending anyone to it", async () => {
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

    // No field of ours: `verifyNewAccount` is not a call this account allows,
    // so one would take a code, accept a wrong one, and hang on it.
    expect(
      renderer.root.findAll(
        node => node.props['aria-label'] === 'Verification code',
      ),
    ).toHaveLength(0)
    // Framed here, not opened elsewhere — the visitor never leaves the page.
    const frame = renderer.root.findByType('iframe')
    expect(frame.props.src).toBe('https://app.getpara.com/v2/login/otp')
    expect(para.openedUrls).not.toContain(
      'https://app.getpara.com/v2/login/otp',
    )
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

  it('keeps a user-initiated passkey button when Para\'s first popup is blocked', async () => {
    para.authPhase = 'waiting_for_session'
    para.authStateInfo = {
      passkeyUrl: 'https://app.getpara.com/v2/login/passkey',
    }
    const open = vi.spyOn(window, 'open').mockReturnValue(null)

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

    const passkeyButton = renderer.root
      .findAllByType('button')
      .find(button => String(button.children.join('')).includes('Open passkey'))!
    expect(passkeyButton).toBeTruthy()

    await act(async () => passkeyButton.props.onClick())
    expect(open).toHaveBeenLastCalledWith(
      'https://app.getpara.com/v2/login/passkey',
      'ParaAuth',
      'popup,width=420,height=560',
    )
    open.mockRestore()
  })
})
