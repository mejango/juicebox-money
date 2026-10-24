'use client'

/**
 * Deterministic-browser-only surface for `test/browser/tall-confirm.spec.ts`.
 *
 * It mounts the real review dialog with content taller than any viewport the
 * spec uses, so the browser can prove the dialog scrolls from its top instead
 * of clipping it. Like `/modal-proof`, it is a route only in the deterministic
 * browser build (see next.config.js).
 */

import { useEffect, useState } from 'react'
import { TxProgress } from '@/components/ui/TxProgress'

export default function TallConfirmProofPage() {
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  return (
    <main data-ready={ready ? 'true' : 'false'}>
      {ready ? (
        <TxProgress
          open
          title="Tall review"
          steps={[{ title: 'First' }, { title: 'Second' }]}
          activeIndex={-1}
          next={{ label: 'Try again', onClick: () => {} }}
          onClose={() => {}}
          rows={[{ label: 'Project owner', value: '0x1111111111111111111111111111111111111111', mono: true }, ...Array.from({ length: 30 }, (_, index) => ({ label: `Row ${index + 1}`, value: `Value ${index + 1}` }))]}
        />
      ) : null}
    </main>
  )
}
