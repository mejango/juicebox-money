'use client'

import { PortalContainerProvider } from '@getpara/react-component-library'
import { ParaProvider, useModal } from '@getpara/react-sdk-lite'
import {
  Network,
  OnRampAsset,
  OnRampProvider,
  OnRampPurchaseType,
} from '@getpara/web-sdk'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAccount } from 'wagmi'
import type { ParaRequest } from './ParaAuthContext'
import { getParaClient, PARA_APP, PARA_ONRAMP_PROVIDER } from './para-config'
import ParaAuthSheet from './ParaAuthSheet'
import '@getpara/react-sdk-lite/styles.css'

function Driver({
  host,
  requestId,
  request,
  onOpenChange,
  onSettled,
}: {
  host: HTMLDialogElement
  requestId: number
  request: ParaRequest
  onOpenChange: (open: boolean) => void
  onSettled: () => void
}) {
  const { isOpen, openModal } = useModal()
  const { address, connector } = useAccount()
  const [sheetOpen, setSheetOpen] = useState(false)
  const handledRequest = useRef(0)
  const wasOpen = useRef(false)
  // Set when the on-ramp had to sign the user in first, so it can resume once
  // the sheet closes.
  const resumeAddFunds = useRef<ParaRequest | null>(null)

  const startAddFunds = useCallback(
    async (target: Extract<ParaRequest, { kind: 'addFunds' }>) => {
      const para = getParaClient()
      // Both on-ramp paths are keyed to a Para user, even the one that
      // delivers to someone else's wallet. No session means sign in first.
      if (!(await para.isFullyLoggedIn().catch(() => false))) {
        resumeAddFunds.current = target
        setSheetOpen(true)
        return
      }
      // Para's own modal owns the embedded wallet's add-funds screen and gives
      // the user a provider picker for free. It has no address parameter
      // though, so an external wallet has to go through the headless call.
      if (connector?.id === 'para' || !address) {
        openModal({ step: 'ACCOUNT_ADD_FUNDS_BUY' })
        return
      }
      // Our domain strings and Para's enums share their values, so the enum
      // objects double as the lookup table.
      const asset = OnRampAsset[target.asset]
      const network = Network[target.network]
      await para.initiateOnRampTransaction({
        externalWalletAddress: address,
        shouldOpenPopup: true,
        params: {
          type: OnRampPurchaseType.BUY,
          provider: OnRampProvider[PARA_ONRAMP_PROVIDER],
          asset,
          network,
          defaultAsset: asset,
          defaultNetwork: network,
          externalWalletAddress: address,
          ...(target.assetQuantity
            ? { assetQuantity: target.assetQuantity }
            : {}),
        },
      })
    },
    [address, connector, openModal],
  )

  useEffect(() => {
    if (requestId <= handledRequest.current) return
    handledRequest.current = requestId
    if (request.kind === 'auth') {
      setSheetOpen(true)
      return
    }
    void startAddFunds(request).catch(() => {
      // A declined popup or an on-ramp provider the portal has switched off.
      // Nothing to recover: the affordance is optional either way.
    })
  }, [requestId, request, startAddFunds])

  const closeSheet = useCallback(() => {
    setSheetOpen(false)
    const resume = resumeAddFunds.current
    resumeAddFunds.current = null
    // Sign-in was only a means to the on-ramp — pick the interrupted flow back
    // up now that a session exists.
    if (resume?.kind === 'addFunds') void startAddFunds(resume).catch(() => {})
  }, [startAddFunds])

  // Para owns whether its own modal is showing; the host mirrors that and our
  // sheet into the top layer. `showModal()` throws on an already-open dialog.
  const open = isOpen || sheetOpen
  useEffect(() => {
    if (open && !host.open) host.showModal()
    else if (!open && host.open) host.close()
  }, [host, open])

  useEffect(() => {
    onOpenChange(open)
    if (wasOpen.current && !open) onSettled()
    wasOpen.current = open
  }, [open, onOpenChange, onSettled])

  if (!sheetOpen) return null
  // The host contributes top-layer membership and nothing else — it paints no
  // backdrop and its `.modal-dialog` styling is `<dialog>`-scoped — so the
  // sheet brings its own dimmed surface and panel.
  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto bg-slate-900/55 p-6">
      <div className="card w-full max-w-sm p-6">
        <ParaAuthSheet onClose={closeSheet} />
      </div>
    </div>
  )
}

/** Loaded only after a user requests embedded sign-in or the on-ramp. */
export default function ParaModalHost({
  requestId,
  request,
  onOpenChange,
  onSettled,
}: {
  requestId: number
  request: ParaRequest
  onOpenChange: (open: boolean) => void
  onSettled: () => void
}) {
  const paraClient = getParaClient()

  // Sign-in is reachable from inside an app modal — AddShopItemsModal and
  // RedeemShopItemsModal both offer it — and a dialog opened with
  // `showModal()` inerts everything outside itself, including body-level
  // portals, which is what Para renders. So the Para overlay has to be in the
  // top layer too, which means it has to be a `showModal()` dialog: the host
  // below. `PortalContainerProvider` points Para's portal container at that
  // host instead of the body. The provider tree itself lives in the host as
  // well, because Para's warm-up iframe is a sibling of the overlay and has to
  // stay above the dialog underneath along with it.
  const [host, setHost] = useState<HTMLDialogElement | null>(null)
  useEffect(() => {
    const node = document.createElement('dialog')
    node.className = 'ui-modal-host'
    // Escape belongs to Para's own dismissal path. Closing the host natively
    // would leave Para believing its modal was still open.
    const preventNativeCancel = (event: Event) => event.preventDefault()
    node.addEventListener('cancel', preventNativeCancel)
    document.body.append(node)
    setHost(node)
    return () => {
      node.removeEventListener('cancel', preventNativeCancel)
      node.remove()
    }
  }, [])

  if (!host) return null

  return createPortal(
    <PortalContainerProvider container={host}>
      {/* Authentication is ours (ParaAuthSheet); Para's packaged modal stays
          mounted only to render the add-funds step, which has no headless
          equivalent for the embedded wallet. Its theme is therefore only ever
          seen on that screen. */}
      <ParaProvider
        paraClientConfig={paraClient}
        config={{ appName: PARA_APP.appName }}
        paraModalConfig={{
          authLayout: ['AUTH:FULL'],
          oAuthMethods: ['GOOGLE', 'TWITTER', 'APPLE', 'DISCORD', 'FARCASTER'],
          // Bone and ink with Bluebs as the accent, in Beatrice — the same
          // palette the rest of the site draws from.
          theme: {
            mode: 'light',
            backgroundColor: '#FFF7E8',
            foregroundColor: '#1A1A1A',
            accentColor: '#5777EB',
            font: 'Beatrice',
            borderRadius: 'lg',
          },
        }}
        externalWalletConfig={{ wallets: [] }}
      >
        <Driver
          host={host}
          requestId={requestId}
          request={request}
          onOpenChange={onOpenChange}
          onSettled={onSettled}
        />
      </ParaProvider>
    </PortalContainerProvider>,
    host,
  )
}
