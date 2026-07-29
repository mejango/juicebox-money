'use client'

import { PortalContainerProvider } from '@getpara/react-component-library'
import { ParaProvider, useModal } from '@getpara/react-sdk-lite'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getParaClient, PARA_APP } from './para-config'
import '@getpara/react-sdk-lite/styles.css'

function ModalDriver({
  host,
  requestId,
  onOpenChange,
  onSettled,
}: {
  host: HTMLDialogElement
  requestId: number
  onOpenChange: (open: boolean) => void
  onSettled: () => void
}) {
  const { isOpen, openModal } = useModal()
  const handledRequest = useRef(0)
  const wasOpen = useRef(false)

  useEffect(() => {
    if (requestId <= handledRequest.current) return
    handledRequest.current = requestId
    openModal()
  }, [requestId, openModal])

  // Para owns whether its modal is showing; the host only mirrors that into
  // the top layer. `showModal()` throws on a dialog that is already open.
  useEffect(() => {
    if (isOpen && !host.open) host.showModal()
    else if (!isOpen && host.open) host.close()
  }, [host, isOpen])

  useEffect(() => {
    onOpenChange(isOpen)
    if (wasOpen.current && !isOpen) onSettled()
    wasOpen.current = isOpen
  }, [isOpen, onOpenChange, onSettled])

  return null
}

/** Loaded only after a user requests embedded email/social authentication. */
export default function ParaModalHost({
  requestId,
  onOpenChange,
  onSettled,
}: {
  requestId: number
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
      <ParaProvider
        paraClientConfig={paraClient}
        config={{ appName: PARA_APP.appName }}
        paraModalConfig={{
          authLayout: ['AUTH:FULL'],
          oAuthMethods: ['GOOGLE', 'TWITTER', 'APPLE', 'DISCORD', 'FARCASTER'],
          theme: {
            mode: 'light',
            backgroundColor: '#FFF7E8',
            foregroundColor: '#5777EB',
            borderRadius: 'md',
          },
        }}
        externalWalletConfig={{ wallets: [] }}
      >
        <ModalDriver
          host={host}
          requestId={requestId}
          onOpenChange={onOpenChange}
          onSettled={onSettled}
        />
      </ParaProvider>
    </PortalContainerProvider>,
    host,
  )
}
