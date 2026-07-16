'use client'

import { useEffect, useRef, useState } from 'react'
import { useWallet } from '@/hooks/useWallet'
import { truncateAddress } from '@/lib/format'

export function WalletButton() {
  const { isConnected, address, connectors, connectWith, openSignIn, disconnect } =
    useWallet()
  const [menuOpen, setMenuOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Wallet state only exists client-side; render the signed-out shell on the
  // server so hydration always matches.
  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menuOpen])

  const connected = mounted && isConnected && !!address

  return (
    <div className="relative" ref={menuRef}>
      {connected ? (
        <button
          onClick={() => setMenuOpen(o => !o)}
          aria-expanded={menuOpen}
          className="btn-secondary flex min-h-[44px] items-center gap-2 px-4 text-sm"
        >
          <span className="h-2 w-2 rounded-full bg-melon-500" />
          {truncateAddress(address)}
        </button>
      ) : (
        <button
          onClick={() => setMenuOpen(o => !o)}
          aria-expanded={menuOpen}
          className="btn-primary min-h-[44px] px-5 text-sm"
        >
          Sign in
        </button>
      )}

      {menuOpen ? (
        <div className="card absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden py-1.5 shadow-[0_12px_32px_rgba(32,30,26,0.12)]">
          {connected ? (
            <button
              onClick={() => {
                setMenuOpen(false)
                disconnect()
              }}
              className="block w-full px-4 py-3 text-left text-sm font-medium text-ink hover:bg-smoke-25"
            >
              Sign out
            </button>
          ) : (
            <>
              <button
                onClick={() => {
                  setMenuOpen(false)
                  openSignIn()
                }}
                className="block w-full px-4 py-3 text-left text-sm font-medium text-ink hover:bg-smoke-25"
              >
                Email or social
                <span className="block text-xs font-normal text-smoke-700">
                  No wallet needed — we make one for you
                </span>
              </button>
              <div className="mx-4 my-1 border-t border-smoke-200" />
              {connectors.map(c => (
                <button
                  key={c.id}
                  onClick={() => {
                    setMenuOpen(false)
                    connectWith(c.id).catch(() => {})
                  }}
                  className="block w-full px-4 py-2.5 text-left text-sm font-medium text-ink/90 hover:bg-smoke-25"
                >
                  {c.name}
                </button>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
