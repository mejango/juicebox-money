'use client'

import { useId } from 'react'
import { getAddress, zeroAddress } from 'viem'
import { ModalCloseButton } from '@/components/ui/ModalShell'

const MIN_SIGNERS = 2
const MAX_SIGNERS = 20
const SENTINEL_ADDRESS = '0x0000000000000000000000000000000000000001'

function signerAddress(value: string): string | null {
  try {
    const address = getAddress(value.trim())
    return address === zeroAddress || address === SENTINEL_ADDRESS
      ? null
      : address
  } catch {
    return null
  }
}

/** The controlled signer policy for a new project owner or revnet operator Safe. */
export function AuthoritySafeEditor({
  role,
  owners,
  threshold,
  onOwnersChange,
  onThresholdChange,
  disabled = false,
}: {
  role: 'owner' | 'operator'
  owners: string[]
  threshold: number
  onOwnersChange: (owners: string[]) => void
  onThresholdChange: (threshold: number) => void
  disabled?: boolean
}) {
  const id = useId()
  const roleLabel = role === 'owner' ? 'Owner' : 'Operator'
  const addresses = owners.map(signerAddress)
  const validThreshold = Number.isInteger(threshold) && threshold >= 1 && threshold <= owners.length

  return (
    <div className="space-y-3">
      {owners.map((owner, index) => {
        const address = addresses[index]
        const error = !owner.trim()
          ? null
          : !address
            ? 'Enter a valid wallet address. Zero and reserved addresses cannot sign.'
            : addresses.some((other, otherIndex) => otherIndex !== index && other === address)
              ? 'Each signer must have a different address.'
              : null
        const errorId = `${id}-signer-${index}`

        return (
          <div key={index}>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={owner}
                onChange={event => onOwnersChange(owners.map((value, ownerIndex) =>
                  ownerIndex === index ? event.target.value.trim().slice(0, 64) : value,
                ))}
                disabled={disabled}
                placeholder="0x…"
                aria-label={`${roleLabel} signer ${index + 1}`}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? errorId : undefined}
                className={`input-well min-h-[44px] min-w-0 flex-1 px-3 font-mono text-xs disabled:opacity-60 ${error ? '!border-red-400' : ''}`}
              />
              <ModalCloseButton
                onClick={() => {
                  if (disabled || owners.length <= MIN_SIGNERS) return
                  const next = owners.filter((_, ownerIndex) => ownerIndex !== index)
                  onOwnersChange(next)
                  if (threshold > next.length) onThresholdChange(next.length)
                }}
                disabled={disabled || owners.length <= MIN_SIGNERS}
                aria-label={`Remove ${roleLabel.toLowerCase()} signer ${index + 1}`}
                className="text-smoke-700 hover:bg-smoke-75 hover:text-ink disabled:opacity-40"
              />
            </div>
            {error ? <p id={errorId} className="field-error pl-1">{error}</p> : null}
          </div>
        )
      })}
      <button
        type="button"
        onClick={() => {
          if (!disabled && owners.length < MAX_SIGNERS) onOwnersChange([...owners, ''])
        }}
        disabled={disabled || owners.length >= MAX_SIGNERS}
        className="min-h-[44px] text-xs font-medium text-bluebs-600 hover:text-bluebs-700 disabled:opacity-40"
      >
        + Add signer
      </button>
      <div className="w-40 max-w-full">
        <label htmlFor={`${id}-threshold`} className="field-label">
          Approval policy
        </label>
        <select
          id={`${id}-threshold`}
          value={validThreshold ? threshold : ''}
          onChange={event => onThresholdChange(Number(event.target.value))}
          disabled={disabled}
          aria-label={`${roleLabel} approval policy`}
          aria-invalid={!validThreshold}
          className="input-well select-caret mt-2 min-h-[44px] px-3 pr-9 text-sm disabled:opacity-60"
        >
          {!validThreshold ? <option value="" disabled>Choose policy</option> : null}
          {owners.map((_, index) => (
            <option key={index + 1} value={index + 1}>
              {index + 1} of {owners.length}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
