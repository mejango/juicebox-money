// @vitest-environment jsdom
import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

// A wallet announces its own icon, so the page cannot trust it. Only an inline
// image may be drawn: any other URL would tell its host that this page was opened.
const RABBY_ICON = 'data:image/svg+xml;base64,PHN2Zy8+'
const HOSTILE = {
  Sneaky: 'https://tracker.example/icon.png',
  Script: 'data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=',
  Js: 'javascript:alert(1)',
  Plain: undefined,
}

const mocks = vi.hoisted(() => ({
  connectors: [] as { id: string; name: string; icon?: string }[],
}))

vi.mock('wagmi', () => ({ useConnectors: () => mocks.connectors }))
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
    verifyNewAccountAsync: vi.fn(),
    isPending: false,
    error: null,
  }),
  useResendVerificationCode: () => ({ resendVerificationCodeAsync: vi.fn() }),
}))
vi.mock('@/providers/para-config', () => ({
  getParaClient: () => ({
    onStatePhaseChange: (listener: (snapshot: unknown) => void) => {
      listener({
        authPhase: 'idle',
        corePhase: 'unauthenticated',
        authStateInfo: {},
      })
      return () => {}
    },
    waitForWalletCreation: vi.fn(),
  }),
  PARA_APP: { appName: 'Juicebox' },
  PARA_PORTAL_THEME: { backgroundColor: '#FFF7E8' },
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({
    connectors: mocks.connectors,
    connectWith: vi.fn(),
  }),
}))
vi.mock('@/hooks/useMobileWallet', () => ({ useMobileWallet: () => null }))

const { default: ParaAuthSheet } = await import('@/providers/ParaAuthSheet')
const { SignInShell } = await import('@/providers/SignInShell')

const sheets = {
  SignInShell: () =>
    createElement(SignInShell, { entry: '', onEntryChange: () => {} }),
  ParaAuthSheet: () =>
    createElement(ParaAuthSheet, {
      entry: '',
      onEntryChange: () => {},
      onClose: () => {},
    }),
}

describe.each(Object.keys(sheets) as (keyof typeof sheets)[])(
  'the wallet tiles of %s',
  name => {
    it('draw an inline image icon, and nothing a wallet could point at a remote host', async () => {
      mocks.connectors = [
        { id: 'io.rabby', name: 'Rabby', icon: RABBY_ICON },
        ...Object.entries(HOSTILE).map(([label, icon]) => ({
          id: label.toLowerCase(),
          name: label,
          icon,
        })),
      ]
      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => {
        renderer = TestRenderer.create(sheets[name]())
      })
      const tile = (label: string) =>
        renderer.root.findAll(
          node => node.type === 'button' && node.props['aria-label'] === label,
        )[0]

      expect(
        tile('Rabby')
          .findAllByType('img')
          .map(img => img.props.src),
      ).toEqual([RABBY_ICON])
      for (const label of Object.keys(HOSTILE)) {
        expect(tile(label).findAllByType('img'), label).toHaveLength(0)
        expect(tile(label).findAllByType('svg'), label).toHaveLength(1)
      }
      const markup = JSON.stringify(renderer.toJSON())
      expect(markup).not.toContain('tracker.example')
      expect(markup).not.toContain('javascript:')
      expect(markup).not.toContain('text/html')
    })
  },
)
