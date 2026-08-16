'use client'

import {
  useAuthenticateWithEmailOrPhone,
  useAuthenticateWithOAuth,
  useResendVerificationCode,
  useVerifyNewAccount,
} from '@getpara/react-sdk-lite'
import type { StateSnapshot, TOAuthMethod } from '@getpara/web-sdk'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useWallet } from '@/hooks/useWallet'
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

function messageOf(error: unknown): string | null {
  if (!error) return null
  return error instanceof Error ? error.message : String(error)
}

/**
 * Our own sign-in UI, driven by Para's headless auth hooks. Para's packaged
 * modal is never opened for authentication — it stays mounted only so the
 * add-funds step (`ADD_FUNDS_BUY`) has something to render.
 *
 * The hooks poll internally, so this component must stay mounted for the whole
 * flow: closing is blocked while `BUSY_PHASES` is active.
 */
export default function ParaAuthSheet({ onClose }: { onClose: () => void }) {
  // The same singleton ParaProvider was handed, so the state stream below is
  // the one the hooks are driving. `useClient()` returns it too, but optional.
  const para = getParaClient()
  const { connectors, connectWith } = useWallet()

  const { authenticateWithEmailOrPhoneAsync, error: authError } =
    useAuthenticateWithEmailOrPhone()
  const { authenticateWithOAuthAsync, error: oauthError } =
    useAuthenticateWithOAuth()
  const { verifyNewAccountAsync, isPending: verifying, error: verifyError } =
    useVerifyNewAccount()
  const { resendVerificationCodeAsync } = useResendVerificationCode()

  const [channel, setChannel] = useState<'email' | 'phone'>('email')
  const [email, setEmail] = useState('')
  const [dialCode, setDialCode] = useState('1')
  const [phone, setPhone] = useState('')
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
          // The link and the copyable code below still work without it.
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
  const awaitingCode = authPhase === 'awaiting_account_verification'

  const submitIdentifier = useCallback(async () => {
    setLocalError(null)
    setPendingMethod('local')
    try {
      await authenticateWithEmailOrPhoneAsync({
        auth:
          channel === 'email'
            ? { email: email.trim() }
            : {
                phone: `+${dialCode.replace(/\D/g, '')}${phone.replace(
                  /\D/g,
                  '',
                )}` as `+${number}`,
              },
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
  }, [authenticateWithEmailOrPhoneAsync, channel, dialCode, email, phone])

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
          Check your {channel === 'email' ? 'email' : 'phone'}
        </h2>
        <p className="mt-1 text-sm text-smoke-700">
          We sent a code to{' '}
          <span className="font-medium text-ink">
            {channel === 'email' ? email : `+${dialCode} ${phone}`}
          </span>
          .
        </p>
        <input
          value={code}
          onChange={event => setCode(event.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          aria-label="Verification code"
          className="input-well mt-4 w-full text-center font-agrandir text-2xl tracking-[0.4em]"
        />
        <button
          type="button"
          onClick={submitCode}
          disabled={verifying || code.trim().length === 0}
          className="btn-primary mt-3 h-11 w-full text-sm disabled:opacity-60"
        >
          {verifying ? 'Verifying…' : 'Verify'}
        </button>
        {error ? <p className="mt-2 text-xs text-error-500">{error}</p> : null}
        <button
          type="button"
          onClick={() => {
            setResent(true)
            void resendVerificationCodeAsync({ type: 'SIGNUP' }).catch(() =>
              setResent(false),
            )
          }}
          className="mt-3 text-xs text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
        >
          {resent ? 'Code resent' : 'Resend code'}
        </button>
      </div>
    )
  }

  return (
    <div className="w-full">
      <h2 className="font-agrandir text-2xl font-medium text-ink">Sign in</h2>
      <p className="mt-1 text-sm text-smoke-700">
        No wallet needed — we make one for you.
      </p>

      <div className="mt-4 flex gap-1">
        {(['email', 'phone'] as const).map(option => (
          <button
            key={option}
            type="button"
            onClick={() => setChannel(option)}
            aria-pressed={channel === option}
            className={`h-8 rounded-lg px-3 text-xs font-medium capitalize ${
              channel === option
                ? 'bg-bluebs-25 text-bluebs-600'
                : 'text-smoke-700 hover:bg-smoke-25'
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <form
        onSubmit={event => {
          event.preventDefault()
          void submitIdentifier()
        }}
        className="mt-2"
      >
        {channel === 'email' ? (
          <input
            type="email"
            value={email}
            onChange={event => setEmail(event.target.value)}
            placeholder="you@example.com"
            aria-label="Email"
            autoComplete="email"
            className="input-well w-full"
          />
        ) : (
          <div className="flex gap-2">
            <div className="input-well flex w-20 items-center gap-0.5 !px-2">
              <span className="text-smoke-700">+</span>
              <input
                value={dialCode}
                onChange={event => setDialCode(event.target.value)}
                inputMode="numeric"
                aria-label="Country code"
                className="w-full min-w-0 bg-transparent outline-none"
              />
            </div>
            <input
              type="tel"
              value={phone}
              onChange={event => setPhone(event.target.value)}
              placeholder="555 000 1234"
              aria-label="Phone number"
              autoComplete="tel-national"
              className="input-well min-w-0 flex-1"
            />
          </div>
        )}
        <button
          type="submit"
          disabled={
            busy || (channel === 'email' ? !email.trim() : !phone.trim())
          }
          className="btn-primary mt-2 h-11 w-full text-sm disabled:opacity-60"
        >
          {pendingMethod === 'local' ? 'Sending…' : 'Continue'}
        </button>
      </form>

      <div className="my-4 flex items-center gap-3">
        <span className="h-px flex-1 bg-smoke-200" />
        <span className="text-xs text-smoke-700">or</span>
        <span className="h-px flex-1 bg-smoke-200" />
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {OAUTH_METHODS.map(({ method, label }) => (
          <button
            key={method}
            type="button"
            onClick={() => void submitOAuth(method)}
            disabled={busy}
            className="btn-secondary h-10 text-sm disabled:opacity-60"
          >
            {pendingMethod === method ? 'Opening…' : label}
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

      {connectors.length > 0 ? (
        <>
          <div className="my-4 flex items-center gap-3">
            <span className="h-px flex-1 bg-smoke-200" />
            <span className="text-xs text-smoke-700">or connect a wallet</span>
            <span className="h-px flex-1 bg-smoke-200" />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {connectors.map(connector => (
              <button
                key={connector.id}
                type="button"
                onClick={() => {
                  connectWith(connector.id)
                    .then(onClose)
                    .catch(error => setLocalError(messageOf(error)))
                }}
                className="btn-secondary h-10 truncate text-sm"
              >
                {connector.name}
              </button>
            ))}
          </div>
        </>
      ) : null}

      {error ? <p className="mt-3 text-xs text-error-500">{error}</p> : null}

      <button
        type="button"
        onClick={onClose}
        disabled={busy}
        className="mt-4 w-full text-xs text-smoke-700 underline underline-offset-2 hover:text-ink disabled:opacity-50"
      >
        Cancel
      </button>
    </div>
  )
}
