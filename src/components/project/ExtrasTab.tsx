'use client'

import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { parseEventLogs, zeroAddress, type Address } from 'viem'
import { AddressField } from '@/components/create/AddressField'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { draftFileName, parseDraft } from '@/lib/draft'
import { resolvedAddress } from '@/lib/ens'
import { truncateAddress } from '@/lib/format'
import { chainName, toUrn } from '@/lib/urn'

/**
 * Extras tab (website/ parity: renderExtrasSection): a .jb draft export
 * ("Copy this project") and the payer-address deployer (tx #32,
 * JBProjectPayerDeployer.deployProjectPayer). Deploys go through useSafeTx
 * (simulate-first) on the current page chain only; other chains link to
 * their own Extras tab.
 */

// ABI fragment + singleton address for JBProjectPayerDeployer, taken from
// website/src/abi-registry.js (generated from
// deploy-all-v6/deployments/<chain>/JBProjectPayerDeployer.json) —
// @bananapus/nana-sdk-core@1.2.0 does not ship this contract. The deployer
// is a singleton at the same address on every supported chain.
const PROJECT_PAYER_DEPLOYER_ADDRESS: Partial<Record<number, Address>> = {
  1: '0x7321740fd0dcf73dd3e2aa8fc060454abfce9517',
  10: '0x7321740fd0dcf73dd3e2aa8fc060454abfce9517',
  8453: '0x7321740fd0dcf73dd3e2aa8fc060454abfce9517',
  42161: '0x7321740fd0dcf73dd3e2aa8fc060454abfce9517',
  84532: '0x7321740fd0dcf73dd3e2aa8fc060454abfce9517',
  421614: '0x7321740fd0dcf73dd3e2aa8fc060454abfce9517',
  11155111: '0x7321740fd0dcf73dd3e2aa8fc060454abfce9517',
  11155420: '0x7321740fd0dcf73dd3e2aa8fc060454abfce9517',
}

const PROJECT_PAYER_DEPLOYER_ABI = [
  {
    type: 'function',
    name: 'deployProjectPayer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'defaultProjectId', type: 'uint256' },
      { name: 'defaultBeneficiary', type: 'address' },
      { name: 'defaultMemo', type: 'string' },
      { name: 'defaultMetadata', type: 'bytes' },
      { name: 'defaultAddToBalance', type: 'bool' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ name: 'projectPayer', type: 'address' }],
  },
  {
    type: 'event',
    name: 'DeployProjectPayer',
    anonymous: false,
    inputs: [
      { name: 'projectPayer', type: 'address', indexed: true },
      { name: 'defaultProjectId', type: 'uint256', indexed: false },
      { name: 'defaultBeneficiary', type: 'address', indexed: false },
      { name: 'defaultMemo', type: 'string', indexed: false },
      { name: 'defaultMetadata', type: 'bytes', indexed: false },
      { name: 'defaultAddToBalance', type: 'bool', indexed: false },
      { name: 'directory', type: 'address', indexed: false },
      { name: 'owner', type: 'address', indexed: false },
      { name: 'caller', type: 'address', indexed: false },
    ],
  },
] as const

export type ExtrasProfile = {
  name: string
  tagline: string
  description: string
  logoUri: string | null
  infoUri?: string
  twitter?: string
  discord?: string
  telegram?: string
  whatsapp?: string
  instagram?: string
}

export function ExtrasTab({
  chainId,
  projectId,
  isRevnet,
  profile,
  chains,
}: {
  chainId: JBChainId
  projectId: number
  isRevnet: boolean
  profile: ExtrasProfile
  /** Per-chain deployments: [chainId, projectId] — sibling ids can differ. */
  chains: [number, number][]
}) {
  return (
    <div className="space-y-5">
      <CopyProjectCard
        isRevnet={isRevnet}
        profile={profile}
        chains={chains.map(([id]) => id)}
      />
      <PayerAddressCard
        chainId={chainId}
        projectId={projectId}
        chains={chains}
      />
    </div>
  )
}

/**
 * "Copy this project": downloads a .jb create-flow draft seeded from this
 * project's profile. The draft is a PARTIAL copy — name, tagline,
 * description, links, chains, and flavor — not an on-chain reconstruction;
 * rules (stages) are the create flow's defaults. Built via the
 * parseDraft(JSON.stringify(...)) round-trip so the file is always
 * schema-valid (parseDraft is the .jb security boundary).
 */
function CopyProjectCard({
  isRevnet,
  profile,
  chains,
}: {
  isRevnet: boolean
  profile: ExtrasProfile
  chains: number[]
}) {
  const [error, setError] = useState<string | null>(null)

  const download = () => {
    setError(null)
    try {
      const draft = parseDraft(
        JSON.stringify({
          v: 1,
          flavor: isRevnet ? 'revnet' : 'project',
          name: profile.name,
          tagline: profile.tagline,
          description: profile.description,
          links: {
            infoUri: profile.infoUri ?? '',
            twitter: profile.twitter ?? '',
            discord: profile.discord ?? '',
            telegram: profile.telegram ?? '',
            whatsapp: profile.whatsapp ?? '',
            instagram: profile.instagram ?? '',
          },
          chains,
          // One default-shaped stage: parseDraft requires at least one, and
          // sanitizeStage fills every rule with the create flow's defaults.
          stages: [{}],
        }),
      )
      const blob = new Blob([JSON.stringify(draft, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = draftFileName(profile.name)
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setError('Could not build the draft file. Try again.')
    }
  }

  return (
    <div className="card p-5">
      <span className="field-label">Copy this project</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        Start your own project from this one&apos;s profile. The download is a
        .jb draft with this project&apos;s name, tagline, description, links,
        and chains — rules start fresh in the create flow, and the logo
        isn&apos;t included.
      </p>
      <button
        onClick={download}
        className="btn-secondary mt-4 min-h-[40px] px-4 text-sm"
      >
        Download .jb draft
      </button>
      <p className="mt-2 text-xs text-smoke-700">
        Import the file on the Create page to pick up from here.
      </p>
      {error ? (
        <p className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** A reviewed, ready-to-send deploy: the exact args are frozen here so what
 *  the user confirms is what's sent. */
type ReviewedDeploy = {
  args: readonly [bigint, Address, string, `0x${string}`, boolean, Address]
  beneficiary: Address
  owner: Address
  addToBalance: boolean
  memo: string
  /** The account the review was made for. */
  account: Address
}

/**
 * "Payer address" (tx #32): deploy a JBProjectPayer so plain ETH transfers
 * to a dedicated address pay the project. Website parity: default behavior
 * is Pay, default beneficiary is the zero address (the original payer
 * receives the tokens), default owner is the zero address (immutable) with
 * an opt-in editable mode owned by the connected wallet, and metadata is
 * always 0x. Deploys are permissionless.
 */
function PayerAddressCard({
  chainId,
  projectId,
  chains,
}: {
  chainId: JBChainId
  projectId: number
  /** Per-chain deployments: [chainId, projectId]. */
  chains: [number, number][]
}) {
  const { isConnected, address, openSignIn } = useWallet()
  const tx = useSafeTx(chainId)

  const [addToBalance, setAddToBalance] = useState(false)
  const [beneficiary, setBeneficiary] = useState('')
  const [memo, setMemo] = useState('')
  const [editable, setEditable] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [review, setReview] = useState<ReviewedDeploy | null>(null)

  const deployer = PROJECT_PAYER_DEPLOYER_ADDRESS[chainId]
  const chainMeta = JB_CHAINS[chainId]
  const etherscanHost = chainMeta?.etherscanHostname
  const txUrl = tx.hash
    ? `https://${etherscanHost}/tx/${tx.hash}`
    : null

  const busy =
    tx.phase === 'simulating' ||
    tx.phase === 'signing' ||
    tx.phase === 'pending'

  // Editing any input invalidates the reviewed args.
  const invalidate = () => {
    setReview(null)
    setFlowError(null)
  }

  // The deployed payer address comes from the deployer's DeployProjectPayer
  // event in the receipt (the function's return value isn't available from
  // a transaction) — projectPayer is the indexed first arg.
  const deployedPayer = useMemo(() => {
    if (!tx.receipt) return null
    try {
      const logs = parseEventLogs({
        abi: PROJECT_PAYER_DEPLOYER_ABI,
        eventName: 'DeployProjectPayer',
        logs: tx.receipt.logs,
      })
      return logs[0]?.args.projectPayer ?? null
    } catch {
      return null
    }
  }, [tx.receipt])

  const otherChains = chains.filter(([id]) => id !== chainId)

  if (!deployer) {
    return (
      <div className="card p-5">
        <span className="field-label">Payer address</span>
        <p className="mt-2 text-sm leading-relaxed text-smoke-700">
          Payer addresses aren&apos;t available on {chainName(chainId)} — the
          deployer contract isn&apos;t on this chain.
        </p>
      </div>
    )
  }

  const handleReview = () => {
    if (busy) return
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    setFlowError(null)
    // Empty beneficiary = the zero address: the payer contract mints to
    // whoever sent the ETH.
    let beneficiaryAddress: Address = zeroAddress
    const raw = beneficiary.trim()
    if (raw) {
      const resolved = resolvedAddress(raw)
      if (!resolved) {
        setFlowError(
          'Enter a valid beneficiary address or ENS name, or leave it empty.',
        )
        return
      }
      beneficiaryAddress = resolved
    }
    // Website parity: owner defaults to the zero address (nobody can ever
    // change the payer); editable mode sets the connected wallet as owner.
    const owner: Address = editable ? address : zeroAddress
    setReview({
      args: [
        BigInt(projectId),
        beneficiaryAddress,
        memo.trim(),
        '0x',
        addToBalance,
        owner,
      ],
      beneficiary: beneficiaryAddress,
      owner,
      addToBalance,
      memo: memo.trim(),
      account: address,
    })
  }

  const handleConfirm = () => {
    if (!review || busy) return
    // Account-unchanged recheck: the reviewed args embed the owner.
    if (address?.toLowerCase() !== review.account.toLowerCase()) {
      setReview(null)
      setFlowError('Your connected account changed — review the deploy again.')
      return
    }
    tx.send({
      chainId,
      address: deployer,
      abi: PROJECT_PAYER_DEPLOYER_ABI,
      functionName: 'deployProjectPayer',
      args: review.args,
    })
  }

  const resetAll = () => {
    setReview(null)
    setFlowError(null)
    tx.reset()
  }

  return (
    <div className="card p-5">
      <span className="field-label">Payer address</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        Get a dedicated address that pays this project whenever someone sends
        ETH to it — no app needed. Sending other tokens to it directly
        doesn&apos;t work. Anyone can create any number of payer addresses.
      </p>

      {tx.phase === 'success' ? (
        <PayerDeployedPanel
          payer={deployedPayer}
          etherscanHost={etherscanHost}
          txUrl={txUrl}
          onReset={resetAll}
        />
      ) : (
        <>
          <label className="mt-4 block">
            <span className="field-label">Behavior</span>
            <select
              value={addToBalance ? 'balance' : 'pay'}
              disabled={busy}
              onChange={e => {
                setAddToBalance(e.target.value === 'balance')
                invalidate()
              }}
              className="input-well mt-1.5 min-h-[40px] w-full px-3 text-sm"
            >
              <option value="pay">Pay</option>
              <option value="balance">Add to balance</option>
            </select>
          </label>
          <p className="mt-1.5 text-xs text-smoke-700">
            {addToBalance
              ? 'Adds funds to the project without minting any tokens.'
              : 'Pays the project and mints its tokens to the beneficiary.'}
          </p>

          {!addToBalance ? (
            <div className="mt-4">
              <span className="field-label">Token beneficiary</span>
              <AddressField
                value={beneficiary}
                onChange={value => {
                  setBeneficiary(value)
                  invalidate()
                }}
                disabled={busy}
                placeholder="0x… or name.eth (optional)"
                ariaLabel="Token beneficiary"
                className="mt-1.5"
                compact
              />
              <p className="mt-1.5 text-xs text-smoke-700">
                Leave empty and whoever sends the ETH gets the tokens.
              </p>
            </div>
          ) : null}

          <label className="mt-4 block">
            <span className="field-label">Memo</span>
            <input
              type="text"
              value={memo}
              onChange={e => {
                setMemo(e.target.value.slice(0, 256))
                invalidate()
              }}
              disabled={busy}
              placeholder="Optional note attached to every payment"
              aria-label="Memo"
              className="input-well mt-1.5 min-h-[40px] w-full px-3 text-sm disabled:opacity-60"
            />
          </label>

          <label className="mt-4 flex items-start gap-2.5 text-sm text-ink">
            <input
              type="checkbox"
              checked={editable}
              disabled={busy}
              onChange={e => {
                setEditable(e.target.checked)
                invalidate()
              }}
              className="mt-0.5"
            />
            <span>
              Let me edit this later
              <span className="mt-0.5 block text-xs leading-relaxed text-smoke-700">
                {editable
                  ? 'Your connected wallet can later change the destination project, behavior, beneficiary, and memo. It never receives the payments.'
                  : 'Off by default: the settings above are permanent once deployed.'}
              </span>
            </span>
          </label>

          {review ? (
            <div className="callout callout-info mt-4 text-xs">
              <p>
                Deploys a payer address on {chainName(chainId)} that{' '}
                {review.addToBalance
                  ? 'adds every ETH transfer to the project balance without minting tokens'
                  : 'pays the project with every ETH transfer'}
                .
              </p>
              {!review.addToBalance ? (
                <p className="mt-1">
                  Tokens go to{' '}
                  {review.beneficiary === zeroAddress
                    ? 'whoever sends the ETH'
                    : truncateAddress(review.beneficiary)}
                  .
                </p>
              ) : null}
              {review.memo ? (
                <p className="mt-1">Memo: {review.memo}</p>
              ) : null}
              <p className="mt-1 text-smoke-700">
                {review.owner === zeroAddress
                  ? 'These settings can never be changed.'
                  : `${truncateAddress(review.owner)} can change these settings later.`}
              </p>
            </div>
          ) : null}

          <button
            onClick={review ? handleConfirm : handleReview}
            disabled={busy}
            className="btn-primary mt-4 min-h-[44px] w-full text-sm"
          >
            {tx.phase === 'simulating'
              ? 'Double-checking the transaction…'
              : tx.phase === 'signing'
                ? 'Confirm in your wallet…'
                : tx.phase === 'pending'
                  ? 'Deploying…'
                  : !isConnected
                    ? 'Sign in to continue'
                    : review
                      ? 'Confirm deploy'
                      : 'Review deploy'}
          </button>

          {tx.phase === 'pending' && txUrl ? (
            <p className="mt-2 text-center text-xs text-smoke-700">
              Waiting for confirmation —{' '}
              <a
                href={txUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2"
              >
                view transaction
              </a>
            </p>
          ) : null}

          {flowError || tx.error ? (
            <p className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
              {flowError ?? tx.error}
            </p>
          ) : null}
        </>
      )}

      {otherChains.length > 0 ? (
        <p className="mt-4 text-xs leading-relaxed text-smoke-700">
          Payer addresses deploy per chain. For other chains:{' '}
          {otherChains.map(([id, pid], i) => (
            <span key={id}>
              <Link
                href={`/${toUrn(id, pid)}#extras`}
                className="underline underline-offset-2 hover:text-ink"
              >
                {chainName(id)}
              </Link>
              {i < otherChains.length - 1 ? ', ' : ''}
            </span>
          ))}
          .
        </p>
      ) : null}
    </div>
  )
}

/** Success panel: the deployed payer address, ready to copy and share. */
function PayerDeployedPanel({
  payer,
  etherscanHost,
  txUrl,
  onReset,
}: {
  payer: Address | null
  etherscanHost?: string
  txUrl: string | null
  onReset: () => void
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <div className="mt-4 rounded-xl border border-smoke-200 p-4">
      <p className="text-sm font-medium text-ink">
        Payer address deployed. Anyone who sends ETH to it pays this project.
      </p>
      {payer ? (
        <div className="mt-3">
          <span className="field-label">Send ETH to</span>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <code className="break-all rounded-lg bg-split-50 px-3 py-2 font-mono text-xs text-ink">
              {payer}
            </code>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(payer)
                setCopied(true)
              }}
              className="btn-secondary px-2.5 py-1 text-[11px]"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm text-smoke-700">
          The new address will show on the transaction&apos;s explorer page.
        </p>
      )}
      <div className="mt-3 flex gap-3 text-sm font-semibold">
        {payer && etherscanHost ? (
          <a
            href={`https://${etherscanHost}/address/${payer}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
          >
            View on explorer
          </a>
        ) : null}
        {txUrl ? (
          <a
            href={txUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
          >
            View transaction
          </a>
        ) : null}
        <button onClick={onReset} className="text-smoke-700 hover:text-ink">
          Deploy another
        </button>
      </div>
    </div>
  )
}
