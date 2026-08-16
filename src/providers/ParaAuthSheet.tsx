'use client'

import {
  useAuthenticateWithEmailOrPhone,
  useAuthenticateWithOAuth,
  useResendVerificationCode,
  useVerifyNewAccount,
} from '@getpara/react-sdk-lite'
import type { StateSnapshot, TOAuthMethod } from '@getpara/web-sdk'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BrandMark, WalletFallbackMark } from '@/components/BrandMarks'
import { ModalCloseButton } from '@/components/ui/ModalShell'
import { useMobileWallet } from '@/hooks/useMobileWallet'
import { useWallet } from '@/hooks/useWallet'
import { mobileWalletLinks, walletDappUrl } from '@/lib/walletLinks'
import { getParaClient } from './para-config'

/** Not exported by the SDK on its own, but reachable through the snapshot. */
type AuthPhase = StateSnapshot['authPhase']

/** Every method Para can broker. `TWITTER` is the wire value — Para never
 *  renamed the enum after X did, so the label and the value differ. */
const OAUTH_METHODS: { method: TOAuthMethod; label: string }[] = [
  { method: 'GOOGLE', label: 'Google' },
  { method: 'TWITTER', label: 'X' },
  { method: 'APPLE', label: 'Apple' },
  { method: 'DISCORD', label: 'Discord' },
  { method: 'FARCASTER', label: 'Farcaster' },
  { method: 'TELEGRAM', label: 'Telegram' },
  { method: 'FACEBOOK', label: 'Facebook' },
]

/** Phases where Para is mid-flight and unmounting us would strand the poll. */
const BUSY_PHASES: ReadonlySet<AuthPhase> = new Set<AuthPhase>([
  'authenticating_email_phone',
  'authenticating_oauth',
  'processing_authentication',
  'awaiting_session_start',
  'verifying_new_account',
  'waiting_for_session',
])

type Identifier =
  | { kind: 'empty' }
  | { kind: 'email'; email: string }
  | { kind: 'phone'; phone: `+${number}` }
  | { kind: 'invalid'; hint: string }

/**
 * One field for either an email or a phone number, rather than a mode switch
 * the visitor has to set before typing. An `@` is the only reliable signal —
 * no phone number contains one, and no address omits one.
 */
function parseIdentifier(raw: string): Identifier {
  const value = raw.trim()
  if (!value) return { kind: 'empty' }
  if (value.includes('@')) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
      ? { kind: 'email', email: value }
      : { kind: 'invalid', hint: 'That email address looks incomplete.' }
  }
  const compact = value.replace(/[\s().-]/g, '')
  if (/^\+\d{6,15}$/.test(compact)) {
    return { kind: 'phone', phone: compact as `+${number}` }
  }
  // Guessing a country code would silently text the wrong country, so ask.
  if (/^\d{6,15}$/.test(compact)) {
    return { kind: 'invalid', hint: 'Add your country code, like +1.' }
  }
  return { kind: 'invalid', hint: 'Enter an email address or phone number.' }
}

function messageOf(error: unknown): string | null {
  if (!error) return null
  return error instanceof Error ? error.message : String(error)
}

/**
 * Our own sign-in UI, driven by Para's headless auth hooks. Para's packaged
 * modal is never opened for authentication — it stays mounted only so the
 * add-funds step has something to render.
 *
 * The hooks poll internally, so this component must stay mounted for the whole
 * flow: closing is blocked while `BUSY_PHASES` is active.
 */
export default function ParaAuthSheet({ onClose }: { onClose: () => void }) {
  // The same singleton ParaProvider was handed, so the state stream below is
  // the one the hooks are driving. `useClient()` returns it too, but optional.
  const para = getParaClient()
  const { connectors, connectWith } = useWallet()
  const mobileWallet = useMobileWallet()

  const { authenticateWithEmailOrPhoneAsync, error: authError } =
    useAuthenticateWithEmailOrPhone()
  const { authenticateWithOAuthAsync, error: oauthError } =
    useAuthenticateWithOAuth()
  const { verifyNewAccountAsync, isPending: verifying, error: verifyError } =
    useVerifyNewAccount()
  const { resendVerificationCodeAsync } = useResendVerificationCode()

  const [entry, setEntry] = useState('')
  const [code, setCode] = useState('')
  const [authPhase, setAuthPhase] = useState<AuthPhase>('unauthenticated')
  const [pendingMethod, setPendingMethod] = useState<TOAuthMethod | 'local' | null>(
    null,
  )
  const [resent, setResent] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [pairingQr, setPairingQr] = useState<string | null>(null)
  const [pairingUri, setPairingUri] = useState<string | null>(null)

  const popupRef = useRef<Window | null>(null)
  const lastUrlRef = useRef<string | null>(null)
  const settledRef = useRef(false)

  const identifier = parseIdentifier(entry)

  // WalletConnect runs with its own modal suppressed, so the pairing URI
  // arrives as a connector message and this sheet is what shows it. The QR
  // encoder is imported here rather than at module scope so it rides the
  // sign-in chunk instead of the page load.
  useEffect(() => {
    const wc = connectors.find(connector => connector.id === 'walletConnect')
    if (!wc) return
    let live = true
    const onMessage = ({ type, data }: { type: string; data?: unknown }) => {
      if (type !== 'display_uri' || typeof data !== 'string') return
      setPairingUri(data)
      void import('qrcode')
        .then(qr =>
          qr.toDataURL(data, { margin: 1, width: 320, errorCorrectionLevel: 'M' }),
        )
        .then(url => {
          if (live) setPairingQr(url)
        })
        .catch(() => {
          // The link below still works without it.
        })
    }
    wc.emitter.on('message', onMessage)
    return () => {
      live = false
      wc.emitter.off('message', onMessage)
    }
  }, [connectors])

  // Para hands portal URLs back through the state stream rather than the hook
  // promise, so opening them is our job. Passkey URLs *must* be a popup —
  // WebAuthn silently fails inside an iframe — and the rest follow suit for
  // consistency.
  useEffect(() => {
    const unsubscribe = para.onStatePhaseChange((snapshot: StateSnapshot) => {
      setAuthPhase(snapshot.authPhase)
      const info = snapshot.authStateInfo
      const next =
        info.verificationUrl ??
        info.passkeyUrl ??
        info.passwordUrl ??
        info.pinUrl ??
        null
      if (next && next !== lastUrlRef.current) {
        lastUrlRef.current = next
        popupRef.current = window.open(
          next,
          'ParaAuth',
          'popup,width=420,height=560',
        )
      }
      // Closing is what settles the flow: the host reports the transition,
      // which is what tells wagmi to pick the new Para session up.
      if (snapshot.corePhase === 'authenticated' && !settledRef.current) {
        settledRef.current = true
        popupRef.current?.close()
        onClose()
      }
    })
    return () => {
      unsubscribe()
      lastUrlRef.current = null
    }
  }, [para, onClose])

  const busy = BUSY_PHASES.has(authPhase) || verifying

  // The host dialog swallows Escape so Para's own modal stays in sync with it.
  // This sheet has no such contract, and a dialog you can only leave by
  // hunting for the X is one people get stuck in. Mid-flight is the exception:
  // unmounting then would strand Para's poll.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])
  const awaitingCode = authPhase === 'awaiting_account_verification'

  const submitIdentifier = useCallback(async () => {
    if (identifier.kind !== 'email' && identifier.kind !== 'phone') return
    setLocalError(null)
    setPendingMethod('local')
    try {
      await authenticateWithEmailOrPhoneAsync({
        auth:
          identifier.kind === 'email'
            ? { email: identifier.email }
            : { phone: identifier.phone },
        sessionPollingCallbacks: {
          onPoll: () => {
            if (popupRef.current?.closed) popupRef.current = null
          },
        },
      })
    } catch (error) {
      setLocalError(messageOf(error))
    } finally {
      setPendingMethod(null)
    }
  }, [authenticateWithEmailOrPhoneAsync, identifier])

  const submitOAuth = useCallback(
    async (method: TOAuthMethod) => {
      setLocalError(null)
      setPendingMethod(method)
      try {
        await authenticateWithOAuthAsync({
          method,
          // ponytail: Farcaster goes through the popup like every other
          // provider, so Para's portal renders its QR. Swap to `onOAuthUrl`
          // + an inline QR if we ever want that step to stay in-page.
          redirectCallbacks: {
            onOAuthPopup: popup => {
              popupRef.current = popup
            },
          },
          oAuthPollingCallbacks: {
            onPoll: () => {
              if (popupRef.current?.closed) popupRef.current = null
            },
          },
        })
      } catch (error) {
        setLocalError(messageOf(error))
      } finally {
        setPendingMethod(null)
      }
    },
    [authenticateWithOAuthAsync],
  )

  const submitCode = useCallback(async () => {
    setLocalError(null)
    try {
      await verifyNewAccountAsync({ verificationCode: code.trim() })
    } catch (error) {
      setLocalError(messageOf(error))
    }
  }, [verifyNewAccountAsync, code])

  const error =
    localError ??
    messageOf(verifyError) ??
    messageOf(authError) ??
    messageOf(oauthError)

  if (awaitingCode) {
    return (
      <div className="w-full">
        <h2 className="font-agrandir text-2xl font-medium text-ink">
          Enter your code
        </h2>
        <p className="mt-1 text-sm text-smoke-700">
          We sent it to <span className="font-medium text-ink">{entry.trim()}</span>.
        </p>
        <input
          value={code}
          onChange={event => setCode(event.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          aria-label="Verification code"
          className="input-well mt-5 w-full px-4 py-3 text-center font-agrandir text-2xl tracking-[0.4em]"
        />
        {error ? <p className="mt-2 text-xs text-error-500">{error}</p> : null}
        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              setResent(true)
              void resendVerificationCodeAsync({ type: 'SIGNUP' }).catch(() =>
                setResent(false),
              )
            }}
            className="text-xs text-smoke-700 underline underline-offset-2 hover:text-ink"
          >
            {resent ? 'Code resent' : 'Resend code'}
          </button>
          <button
            type="button"
            onClick={submitCode}
            disabled={verifying || code.trim().length === 0}
            className="btn-primary h-10 px-5 text-sm disabled:opacity-60"
          >
            {verifying ? 'Verifying…' : 'Verify'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-agrandir text-2xl font-medium text-ink">Sign in</h2>
          <p className="mt-1 text-sm text-smoke-700">
            You will receive a code.
          </p>
        </div>
        <ModalCloseButton
          onClick={onClose}
          disabled={busy}
          aria-label="Close"
          className="-mr-2 -mt-1"
        />
      </div>

      <form
        onSubmit={event => {
          event.preventDefault()
          void submitIdentifier()
        }}
        className="mt-5"
      >
        <input
          type="text"
          value={entry}
          onChange={event => setEntry(event.target.value)}
          placeholder="you@example.com or +1 555 000 1234"
          aria-label="Email address or phone number"
          autoComplete="email"
          autoFocus
          className="input-well w-full px-4 py-3"
        />
        {identifier.kind === 'invalid' && entry.trim().length > 3 ? (
          <p className="mt-1.5 text-xs text-smoke-700">{identifier.hint}</p>
        ) : null}
        <div className="mt-3 flex justify-end">
          <button
            type="submit"
            disabled={
              busy || (identifier.kind !== 'email' && identifier.kind !== 'phone')
            }
            className="btn-primary h-10 px-5 text-sm disabled:opacity-60"
          >
            {pendingMethod === 'local' ? 'Sending…' : 'Continue'}
          </button>
        </div>
      </form>

      <>
          <p className="mb-2 mt-5 text-xs font-medium text-smoke-700">Socials</p>
          <div className="flex flex-wrap gap-1.5">
            {OAUTH_METHODS.map(({ method, label }) => (
              <button
                key={method}
                type="button"
                onClick={() => void submitOAuth(method)}
                disabled={busy}
                title={label}
                aria-label={label}
                aria-busy={pendingMethod === method}
                className="btn-secondary flex h-10 w-10 items-center justify-center !px-0 disabled:opacity-60"
              >
                <BrandMark
                  method={method}
                  className={`h-5 w-5 shrink-0 ${
                    pendingMethod === method ? 'animate-pulse' : ''
                  }`}
                />
              </button>
            ))}
          </div>

          {pairingUri ? (
            <div className="mt-4 rounded-lg border border-smoke-200 bg-white p-3 text-center">
              <p className="text-xs text-smoke-700">
                Scan with your wallet app, or open it on this device.
              </p>
              {pairingQr ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={pairingQr}
                  alt="WalletConnect pairing QR code"
                  className="mx-auto mt-2 h-40 w-40"
                />
              ) : null}
              <a
                href={pairingUri}
                className="btn-primary mt-2 flex h-10 items-center justify-center text-sm no-underline"
              >
                Open in wallet app
              </a>
            </div>
          ) : null}

          {/* Always rendered, with the row's height reserved. EIP-6963 wallets
              announce themselves over the first few hundred milliseconds, so
              revealing this section once they arrive would resize a panel the
              visitor is already looking at — and it is centred, so it jumps. */}
          <p className="mb-2 mt-4 text-xs font-medium text-smoke-700">Wallets</p>
          <div className="flex min-h-10 flex-wrap gap-1.5">
                {connectors.map(connector => (
                  <button
                    key={connector.id}
                    type="button"
                    title={connector.name}
                    aria-label={connector.name}
                    onClick={() => {
                      connectWith(connector.id)
                        .then(onClose)
                        .catch(cause => setLocalError(messageOf(cause)))
                    }}
                    className="btn-secondary flex h-10 w-10 items-center justify-center !px-0"
                  >
                    {connector.icon ? (
                      // EIP-6963 hands us the wallet's own mark as a data URI.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={connector.icon} alt="" className="h-5 w-5 shrink-0" />
                    ) : (
                      <WalletFallbackMark
                        id={connector.id}
                        className="h-5 w-5 shrink-0"
                      />
                    )}
                  </button>
                ))}
          </div>

          {/* A phone browser with no injected wallet can still get there, but
              only by reopening the page inside the wallet's own browser. */}
          {mobileWallet === 'handoff' && typeof window !== 'undefined' ? (
            <>
              <p className="mb-2 mt-4 text-xs font-medium text-smoke-700">
                Open in a wallet app
              </p>
              <div className="flex flex-wrap gap-1.5">
                {mobileWalletLinks(window.location.href).map(link => (
                  <a
                    key={link.name}
                    href={link.url}
                    className="btn-secondary flex h-10 items-center px-3 text-xs no-underline"
                  >
                    {link.name}
                  </a>
                ))}
                {typeof navigator.share === 'function' ? (
                  <button
                    type="button"
                    onClick={() => {
                      void navigator
                        .share({
                          title: document.title,
                          url: walletDappUrl(window.location.href),
                        })
                        .catch(cause => {
                          if (cause instanceof Error && cause.name === 'AbortError') return
                          console.error('Wallet handoff share failed:', cause)
                        })
                    }}
                    className="btn-secondary flex h-10 items-center px-3 text-xs"
                  >
                    Other…
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
      </>

      {error ? <p className="mt-3 text-xs text-error-500">{error}</p> : null}


    </div>
  )
}
