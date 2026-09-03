'use client'

import {
  JBCoreContracts,
  NATIVE_TOKEN,
  jbContractAddress,
  jbMultiTerminalAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  buildBridgePrepareTx,
  buildToRemoteTx,
  getAccountingContexts,
  getTokenAddress,
  getV6SuckerPairs,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  erc20Abi,
  formatUnits,
  parseUnits,
  zeroAddress,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem'
import { getPublicClient } from 'wagmi/actions'
import { useConfig } from 'wagmi'
import { ChainSelect } from '@/components/ChainSelect'
import {
  classifyInfra,
  findToRemoteValue,
  unpackAddress,
  SUCKER_EXTRA_ABI,
  type Infra,
} from '@/components/project/SettlementSection'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { txPhaseLabel, useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { etherscanTxUrl, formatTokenAmount } from '@/lib/format'
import { tokenSymbol } from '@/lib/token-symbol'
import { buildErc20ApproveRequest } from '@/lib/transaction-builders'
import { chainName } from '@/lib/urn'

/** The frozen, reviewed prepare: what the user confirms is exactly what's
 *  sent, including the min the preview backed. */
type ReviewedMove = {
  sucker: Address
  token: Address
  projectToken: Address
  amount: bigint
  minReclaimed: bigint
  /** The live backing preview the min was floored from (0 = zero backing). */
  previewNet: bigint
  backingDecimals: number
  backingSymbol: string
  infra: Infra
  account: Address
}

/**
 * The "Move between chains" flow (multichain only), extracted from
 * SettlementSection so the Accounts (YOU) card can render it inline. Bridge
 * your deployed ERC-20 to another chain via the project's sucker. Every
 * fund-moving step fails closed on any unverified mapping, unknown bridge
 * infra, or missing proof, and never bypasses useSafeTx.
 *
 * Rendered bare (no card chrome): the caller wraps it.
 */
export function MoveCard({
  chainId,
  projectId,
  chains,
}: {
  chainId: JBChainId
  projectId: number
  chains: [number, number][]
}) {
  const config = useConfig()
  const { isConnected, address, openSignIn } = useWallet()

  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const connected = mounted && isConnected && !!address

  const [from, setFrom] = useState<number>(chainId)
  const [to, setTo] = useState<number | null>(null)
  const [amount, setAmount] = useState('')

  const fromPid = useMemo(() => {
    const mapped = chains.find(([cid]) => cid === from)?.[1]
    // The route's own pair is known exactly. A remote deployment must always
    // come from the verified sucker-group map; never copy the home ID.
    return mapped ?? (from === chainId ? projectId : null)
  }, [chainId, chains, from, projectId])

  // Source-chain sucker pairs (linked destinations) + the caller's ERC-20
  // position on the source chain (only the deployed ERC-20 can bridge —
  // credits can't).
  const { data: src } = useQuery({
    queryKey: ['settlement-move-src', from, fromPid, address],
    enabled: connected && fromPid !== null,
    staleTime: 20_000,
    retry: 1,
    queryFn: async () => {
      if (fromPid === null) {
        throw new Error('The source project ID could not be verified.')
      }
      const client = getPublicClient(config, {
        chainId: from as JBChainId,
      }) as PublicClient | undefined
      if (!client) throw new Error(`Unsupported chain ${from}`)
      const [pairs, token] = await Promise.all([
        getV6SuckerPairs(client, {
          chainId: from as JBChainId,
          projectId: BigInt(fromPid),
        }),
        getTokenAddress(client, {
          chainId: from as JBChainId,
          projectId: BigInt(fromPid),
        }),
      ])
      const erc20Balance =
        token && token !== zeroAddress
          ? ((await client.readContract({
              abi: erc20Abi,
              address: token,
              functionName: 'balanceOf',
              args: [address!],
            })) as bigint)
          : 0n
      return { pairs, token: token && token !== zeroAddress ? token : null, erc20Balance }
    },
  })

  const dests = useMemo(
    () =>
      (src?.pairs ?? []).flatMap(p => {
        const remoteChainId = Number(p.remoteChainId)
        const remoteProjectId = chains.find(
          ([candidateChainId]) => candidateChainId === remoteChainId,
        )?.[1]
        // A sucker pair identifies the remote chain, not its project ID. If
        // the indexer has not verified that exact remote pair, moving stays
        // unavailable rather than guessing from either numeric ID.
        return remoteProjectId === undefined
          ? []
          : [{
              chainId: remoteChainId,
              projectId: remoteProjectId,
              sucker: p.local,
            }]
      }),
    [chains, src],
  )

  // Default the destination to the first linked chain once pairs load.
  useEffect(() => {
    if (to === null && dests.length > 0) setTo(dests[0].chainId)
  }, [dests, to])

  const parsedAmount = useMemo(() => {
    try {
      const t = amount.trim()
      if (!t || Number(t) <= 0) return 0n
      return parseUnits(t, 18)
    } catch {
      return 0n
    }
  }, [amount])

  const selectedPair = dests.find(d => d.chainId === to) ?? null

  return (
    <div>
      <p className="text-sm leading-relaxed text-smoke-700">
        Bridge your tokens to another chain. Only the deployed ERC-20 can move
        — internal credits can&apos;t bridge.
      </p>

      {!connected ? (
        <div className="mt-3">
          <button
            onClick={openSignIn}
            className="btn-secondary min-h-[40px] px-4 text-sm"
          >
            Sign in
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {fromPid === null ? (
            <p className="callout callout-warning text-xs">
              This deployment&apos;s project ID could not be verified. Moving
              stays unavailable until the linked projects can be resolved.
            </p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-end">
            <label className="block min-w-0">
              <span className="field-label">From</span>
              <ChainSelect
                options={chains.map(([cid]) => cid)}
                value={from}
                onChange={chainId => {
                  setFrom(chainId)
                  setTo(null)
                  setAmount('')
                }}
                className="mt-1.5"
              />
            </label>
            <span className="hidden pb-4 text-sm text-grey-500 sm:inline">to</span>
            <label className="block min-w-0">
              <span className="field-label">To</span>
              <ChainSelect
                options={dests.map(d => d.chainId)}
                value={to}
                onChange={setTo}
                disabled={dests.length === 0}
                placeholder="No linked chains"
                className="mt-1.5"
              />
            </label>
          </div>

          {src && !src.token ? (
            <p className="callout callout-warning text-xs">
              You don&apos;t have any ERC-20 {' '}
              tokens on {chainName(from)}. If you hold credits, claim them as
              ERC-20 in the Accounts tab first — credits can&apos;t bridge.
            </p>
          ) : (
            <>
              <label className="block">
                <span className="field-label">Amount</span>
                <div className="input-well mt-1.5 flex items-center px-4">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    placeholder="0"
                    className="min-h-[44px] w-full bg-transparent text-lg font-medium outline-none placeholder:text-smoke-500"
                  />
                  <button
                    onClick={() =>
                      src?.erc20Balance != null &&
                      setAmount(formatUnits(src.erc20Balance, 18))
                    }
                    className="btn-secondary ml-3 px-2.5 py-0.5 text-[11px]"
                  >
                    MAX
                  </button>
                </div>
              </label>
              {src ? (
                <p className="text-xs text-smoke-700">
                  {formatTokenAmount(src.erc20Balance)} ERC-20 available on{' '}
                  {chainName(from)}.
                </p>
              ) : null}
            </>
          )}

          {selectedPair &&
          fromPid !== null &&
          src?.token &&
          parsedAmount > 0n &&
          address ? (
            <MoveFlow
              key={`${from}:${to}`}
              from={from as JBChainId}
              fromPid={fromPid}
              to={to as number}
              toPid={selectedPair.projectId}
              sucker={selectedPair.sucker}
              projectToken={src.token}
              amount={parsedAmount}
              maxBalance={src.erc20Balance}
              account={address}
            />
          ) : null}
        </div>
      )}
    </div>
  )
}

/** The three-step move: approve the sucker, prepare (queue the leaf), then
 *  send to the remote chain. Each step is its own reviewed useSafeTx send. */
function MoveFlow({
  from,
  fromPid,
  to,
  toPid,
  sucker,
  projectToken,
  amount,
  maxBalance,
  account,
}: {
  from: JBChainId
  fromPid: number
  to: number
  toPid: number
  sucker: Address
  projectToken: Address
  amount: bigint
  maxBalance: bigint
  account: Address
}) {
  const config = useConfig()
  const tx = useSafeTx(from)
  const { address } = useWallet()

  // step: 0 review, 1 approve (if needed), 2 prepare, 3 send, 4 done
  const [step, setStep] = useState<0 | 1 | 2 | 3 | 4>(0)
  const [checking, setChecking] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [review, setReview] = useState<ReviewedMove | null>(null)
  const [needsApproval, setNeedsApproval] = useState(false)
  // The confirm dialog. Closing it mid-flow keeps the frozen review and the
  // current step, so the form's button resumes exactly where it stopped.
  const [open, setOpen] = useState(false)
  const [sentHash, setSentHash] = useState<`0x${string}` | null>(null)
  const advancedFor = useRef<number>(-1)

  const busy = checking || tx.busy

  const txUrl = tx.hash ? etherscanTxUrl(from, tx.hash) : null
  const sentUrl = sentHash ? etherscanTxUrl(from, sentHash) : null

  // Advance one step each time a send lands, exactly once per step.
  useEffect(() => {
    if (tx.phase !== 'success') return
    if (advancedFor.current === step) return
    advancedFor.current = step
    if (step === 3) setSentHash(tx.hash)
    setStep(s => (s < 4 ? ((s + 1) as typeof s) : s))
    tx.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.phase, step])

  /** Live re-reads + all fail-closed checks, then freeze the reviewed move. */
  const handleReview = async () => {
    if (busy) return
    setFlowError(null)
    setChecking(true)
    try {
      const client = getPublicClient(config, { chainId: from }) as
        | PublicClient
        | undefined
      if (!client) throw new Error(`Unsupported chain ${from}.`)
      const terminal = jbContractAddress['6'][JBCoreContracts.JBMultiTerminal][
        from
      ] as Address | undefined
      if (!terminal) throw new Error('No terminal on the source chain.')

      // The backing / terminal token the sucker reclaims and bridges: the
      // project's primary accounting token on the source chain.
      const contexts = await getAccountingContexts(client, {
        chainId: from,
        projectId: BigInt(fromPid),
      })
      const primary = contexts[0]
      if (!primary) throw new Error('This project holds no funds on the source chain to back the move.')
      const token = primary.token as Address
      const isNative = token.toLowerCase() === NATIVE_TOKEN.toLowerCase()

      const [suckerPid, mapping, infra, freshBalance] = await Promise.all([
        client.readContract({
          address: sucker,
          abi: SUCKER_EXTRA_ABI,
          functionName: 'projectId',
        }) as Promise<bigint>,
        client.readContract({
          address: sucker,
          abi: SUCKER_EXTRA_ABI,
          functionName: 'remoteTokenFor',
          args: [token],
        }) as Promise<{ enabled: boolean; emergencyHatch: boolean; minGas: number; addr: `0x${string}` }>,
        classifyInfra(client, sucker),
        client.readContract({
          abi: erc20Abi,
          address: projectToken,
          functionName: 'balanceOf',
          args: [account],
        }) as Promise<bigint>,
      ])

      // Fail closed on every uncertainty.
      if (suckerPid !== BigInt(fromPid)) {
        throw new Error('This bridge belongs to a different project.')
      }
      if (amount > freshBalance) {
        throw new Error('That is more ERC-20 than you hold on the source chain.')
      }
      if (infra === 'unknown') {
        throw new Error(
          'This bridge type could not be verified. Moving stays blocked until it can be read again.',
        )
      }
      if (!mapping.enabled || !mapping.addr || /^0x0+$/.test(mapping.addr)) {
        throw new Error('The backing token is not mapped on this bridge — nothing was sent.')
      }
      // Canonical ERC-20 over an OP-stack / Arbitrum native bridge strands in
      // escrow — the mapping can exist but the delivery leg never settles.
      if (infra === 'native' && !isNative) {
        throw new Error(
          'This route uses a native bridge, which cannot deliver this backing token — it would get stuck in escrow.',
        )
      }
      // The mapped destination token must match a verified accounting context
      // on the destination chain.
      const destClient = getPublicClient(config, { chainId: to as JBChainId }) as
        | PublicClient
        | undefined
      if (!destClient) throw new Error(`Unsupported destination chain ${to}.`)
      // The project's id on the destination chain — a sucker group can have
      // DIFFERENT project ids per chain, so this must be the dest chain's own
      // id, not the source's, or the accounting-context check verifies the
      // wrong project.
      const destContexts = await getAccountingContexts(destClient, {
        chainId: to as JBChainId,
        projectId: BigInt(toPid),
      }).catch(() => [])
      const mappedRemote = unpackAddress(mapping.addr).toLowerCase()
      const destMatch = destContexts.some(
        c => c.token.toLowerCase() === mappedRemote,
      )
      if (!destMatch) {
        throw new Error(
          'The bridge maps this backing token to a token that is not a verified accounting context on the destination chain.',
        )
      }

      // Live backing preview: what the sucker's cash-out of the moved tokens
      // reclaims (holder = the sucker, a protocol-registered feeless address,
      // so the reclaim isn't fee-reduced). Floor the min at 99% of it; a zero
      // preview moves the same token count with no backing and says so.
      // previewCashOutFrom returns [ruleset, reclaimAmount, cashOutTaxRate,
      // hookSpecifications] — reclaimAmount is index 1.
      const preview = (await client.readContract({
        address: terminal,
        abi: jbMultiTerminalAbi,
        functionName: 'previewCashOutFrom',
        args: [sucker, BigInt(fromPid), amount, token, sucker, '0x'],
      })) as readonly [unknown, bigint, bigint, unknown]
      const gross = preview[1] ?? 0n
      // Clamped to >=1 like retainedFloor: at gross === 1 the 99% floor truncates to 0n, and a
      // zero minimum is an UNPROTECTED bridge prepare — the one thing every floor helper here
      // exists to prevent.
      const minReclaimed =
        gross > 0n ? ((gross * 99n) / 100n > 0n ? (gross * 99n) / 100n : 1n) : 0n

      const backingSymbol = await tokenSymbol(client, token, { chainId: from })

      // Does the sucker already have enough allowance for the project token?
      const allowance = (await client.readContract({
        abi: erc20Abi,
        address: projectToken,
        functionName: 'allowance',
        args: [account, sucker],
      })) as bigint
      setNeedsApproval(allowance < amount)

      setReview({
        sucker,
        token,
        projectToken,
        amount,
        minReclaimed,
        previewNet: gross,
        backingDecimals: primary.decimals,
        backingSymbol,
        infra,
        account,
      })
      setStep(allowance < amount ? 1 : 2)
      setSentHash(null)
      advancedFor.current = -1
      setOpen(true)
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : 'Could not prepare this move.')
    } finally {
      setChecking(false)
    }
  }

  /** Every send step's gate: when the connected account changed since the
   *  review was frozen, drop back to review instead of sending. */
  const guardAccount = (): boolean => {
    if (address?.toLowerCase() === review?.account.toLowerCase()) return true
    setReview(null)
    setStep(0)
    setFlowError('Your connected account changed — review the move again.')
    return false
  }

  const sendApprove = () => {
    if (!review || busy) return
    if (!guardAccount()) return
    tx.send(
      buildErc20ApproveRequest({
        chainId: from as JBChainId,
        token: review.projectToken,
        spender: review.sucker,
        amount: review.amount,
      }),
    )
  }

  const sendPrepare = () => {
    if (!review || busy) return
    if (!guardAccount()) return
    const request = buildBridgePrepareTx({
      chainId: from,
      sucker: review.sucker,
      projectTokenCount: review.amount,
      beneficiary: review.account,
      minTokensReclaimed: review.minReclaimed,
      token: review.token,
    })
    tx.send({ ...request, abi: request.abi as Abi })
  }

  const sendToRemote = async () => {
    if (!review || busy) return
    if (!guardAccount()) return
    setFlowError(null)
    setChecking(true)
    try {
      const client = getPublicClient(config, { chainId: from }) as
        | PublicClient
        | undefined
      if (!client) throw new Error(`Unsupported chain ${from}.`)
      const value = await findToRemoteValue(
        client,
        from,
        review.sucker,
        review.token,
        review.infra,
        review.account,
      )
      if (value === null) {
        throw new Error(
          'Prepared, but the bridge fee could not be determined yet — try sending again shortly.',
        )
      }
      const request = buildToRemoteTx({
        chainId: from,
        sucker: review.sucker,
        token: review.token,
        value,
      })
      await tx.send({ ...request, abi: request.abi as Abi })
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : 'Could not send to the remote chain.')
    } finally {
      setChecking(false)
    }
  }

  if (amount > maxBalance) {
    return (
      <p className="text-xs text-red-700">
        That is more than the {formatTokenAmount(maxBalance)} ERC-20 you hold on{' '}
        {chainName(from)}.
      </p>
    )
  }

  // Before the route is checked the confirm is already up, in its preparing state.
  const preparing = checking && step === 0
  const dialogOpen = (open && review !== null && step > 0) || preparing

  const steps = [
    ...(needsApproval
      ? [
          {
            key: 'approve',
            title: 'Approve the bridge',
            detail: 'Lets the bridge move your ERC-20 for this transfer.',
          },
        ]
      : []),
    {
      key: 'prepare',
      title: 'Prepare the move',
      detail: "Queues your move into the bridge's outbox.",
    },
    {
      key: 'send',
      title: `Send to ${chainName(to)}`,
      detail: `Ships the queued outbox to ${chainName(to)}. Anyone can send this; the value is the bridge's messaging fee, not the bridged tokens.`,
    },
  ]

  const rows: TxConfirmRow[] = review
    ? [
        {
          label: 'Move',
          value: `${formatTokenAmount(review.amount)} tokens`,
          strong: true,
        },
        { label: 'From', value: chainName(from) },
        { label: 'To', value: chainName(to) },
        {
          label: 'Backing',
          value:
            review.previewNet > 0n
              ? `About ${formatTokenAmount(review.previewNet, review.backingDecimals)} ${review.backingSymbol}`
              : 'None from this chain right now',
        },
        ...(review.previewNet > 0n
          ? [
              {
                label: 'Minimum backing',
                value: `${formatTokenAmount(review.minReclaimed, review.backingDecimals)} ${review.backingSymbol}`,
              },
            ]
          : []),
        { label: 'Bridge', value: review.infra === 'CCIP' ? 'CCIP' : 'Native' },
        { label: 'Beneficiary', value: review.account, mono: true },
      ]
    : []

  const stepIdle =
    step === 1 ? 'Approve' : step === 2 ? 'Prepare' : `Send to ${chainName(to)}`

  return (
    <div className="rounded-xl border border-smoke-200 p-4">
      {step === 0 ? (
        <div className="flex justify-end">
          <button
            onClick={handleReview}
            disabled={busy}
            className="btn-primary min-h-[44px] px-5 text-sm"
          >
            Move to {chainName(to)}
          </button>
        </div>
      ) : step < 4 && !dialogOpen ? (
        <div>
          <p className="mb-2 text-xs text-smoke-700">
            Move in progress — {steps.length - (needsApproval ? step - 1 : step - 2)} of{' '}
            {steps.length} onchain actions left.
          </p>
          <div className="flex justify-end">
            <button
              onClick={() => setOpen(true)}
              className="btn-primary min-h-[44px] px-5 text-sm"
            >
              Resume move
            </button>
          </div>
        </div>
      ) : null}

      {step === 4 ? (
        <div className="callout callout-info text-xs">
          Bridging to {chainName(to)}. Once it lands, claim it from Queued
          movements in the Settlement tab.
          {sentUrl ? (
            <>
              {' '}
              <a
                href={sentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-bluebs-600 underline underline-offset-2"
              >
                View transaction
              </a>
            </>
          ) : null}
        </div>
      ) : null}

      {!dialogOpen ? (
        <TxError
          error={flowError ?? tx.error}
          className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700"
        />
      ) : null}

      <TxConfirmDialog
        open={dialogOpen}
        preparing={preparing}
        onClose={() => setOpen(false)}
        title={step === 4 ? 'Move sent' : 'Confirm move'}
        rows={rows}
        steps={steps}
        activeIndex={needsApproval ? step - 1 : step - 2}
        stepsIntro={
          needsApproval
            ? 'Three separate onchain actions, each confirmed before the next. You can leave and resume where you stopped.'
            : 'Two separate onchain actions, each confirmed before the next. You can leave and resume where you stopped.'
        }
        action={txPhaseLabel(step === 3 && checking ? 'simulating' : tx.phase, {
          pending: 'Submitting…',
          idle: stepIdle,
        })}
        onConfirm={
          step === 1 ? sendApprove : step === 2 ? sendPrepare : () => void sendToRemote()
        }
        busy={busy}
        complete={step === 4}
        status={
          preparing ? (
            'Checking the route and your balances…'
          ) : tx.phase === 'pending' && txUrl ? (
            <>
              Waiting for confirmation —{' '}
              <a
                href={txUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2"
              >
                view transaction
              </a>
            </>
          ) : null
        }
        error={flowError ?? tx.error}
      />
    </div>
  )
}
