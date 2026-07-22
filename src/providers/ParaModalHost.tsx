'use client'

import { ParaProvider, useModal } from '@getpara/react-sdk-lite'
import { useEffect, useRef } from 'react'
import { getParaClient, PARA_APP } from './para-config'
import '@getpara/react-sdk-lite/styles.css'

function ModalDriver({
  requestId,
  onOpenChange,
  onSettled,
}: {
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
  return (
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
        requestId={requestId}
        onOpenChange={onOpenChange}
        onSettled={onSettled}
      />
    </ParaProvider>
  )
}
