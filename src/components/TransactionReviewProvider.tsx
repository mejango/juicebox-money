'use client'

import {
  type PropsWithChildren,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  decodeAbiParameters,
  formatEther,
  toFunctionSelector,
  zeroAddress,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type Hex,
} from 'viem'
import { useAccount } from 'wagmi'
import {
  USDC_ADDRESSES,
  jbContractAddress,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { uniswapV4Deployment } from '@bananapus/nana-sdk-core/v6/uniswap-v4-deployments'
import { ChainIcon } from '@/components/ChainIcon'
import {
  ModalCloseButton,
  ModalDialog,
} from '@/components/ui/ModalShell'
import {
  buildTransactionReviewPrompt,
  registerTransactionReviewHandler,
  transactionReviewJson,
  type TransactionReviewCall,
  type TransactionReviewRequest,
} from '@/lib/transaction-review'
import { chainName } from '@/lib/urn'

type PendingReview = {
  id: number
  request: TransactionReviewRequest
  resolve: (approved: boolean) => void
}

function knownAddressName(chainId: number, value: unknown): string | null {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/iu.test(value)) return null
  const address = value.toLowerCase()
  try {
    const deployment = uniswapV4Deployment(chainId as JBChainId)
    if (deployment?.permit2?.toLowerCase() === address) return 'Permit2'
    if (deployment?.universalRouter?.toLowerCase() === address) {
      return 'Uniswap Universal Router'
    }
  } catch {
    // Unsupported chains can still be reviewed as raw addresses below.
  }
  if (USDC_ADDRESSES[chainId as JBChainId]?.toLowerCase() === address) return 'USDC'
  const contracts = jbContractAddress['6'] as unknown as Record<
    string,
    Partial<Record<number, Address>>
  >
  return (
    Object.entries(contracts).find(
      ([, addresses]) => addresses[chainId]?.toLowerCase() === address,
    )?.[0] ?? null
  )
}

function knownContractName(call: TransactionReviewCall): string | null {
  return call.contractName ?? knownAddressName(call.chainId, call.to)
}

function stringify(value: unknown): string {
  try {
    return (
      JSON.stringify(
        value,
        (_, item) => (typeof item === 'bigint' ? item.toString() : item),
        2,
      ) ?? String(value)
    )
  } catch {
    return String(value)
  }
}

function readableValue(type: string, value: unknown, chainId: number): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    if (type === 'address') {
      const name = knownAddressName(chainId, value)
      return name ? `${name} | ${value}` : value
    }
    if (type.startsWith('bytes') && value.length > 50) {
      return `${value.slice(0, 22)}…${value.slice(-12)}`
    }
    return value
  }
  return stringify(value)
}

function namedValue(value: unknown, name: string, index: number): unknown {
  if (Array.isArray(value)) return value[index]
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return row[name] ?? row[index]
  }
  return undefined
}

function hasComponents(
  parameter: AbiParameter,
): parameter is AbiParameter & { components: readonly AbiParameter[] } {
  return 'components' in parameter && Array.isArray(parameter.components)
}

function ArgumentValue({
  parameter,
  value,
  chainId,
  depth = 0,
}: {
  parameter: AbiParameter
  value: unknown
  chainId: number
  depth?: number
}) {
  const arrayMatch = parameter.type.match(/^(.*)\[(\d*)\]$/)
  if (arrayMatch && Array.isArray(value)) {
    const itemParameter = {
      ...parameter,
      type: arrayMatch[1],
    } as AbiParameter
    return (
      <div className="mt-2 space-y-2 border-l border-smoke-200 pl-3">
        {value.length ? (
          value.map((item, index) => (
            <div key={index}>
              <p className="font-mono text-[11px] font-medium text-smoke-600">
                [{index}]
              </p>
              <ArgumentValue
                parameter={itemParameter}
                value={item}
                chainId={chainId}
                depth={depth + 1}
              />
            </div>
          ))
        ) : (
          <span className="font-mono text-xs text-smoke-600">[]</span>
        )}
      </div>
    )
  }

  if (hasComponents(parameter)) {
    return (
      <div className="mt-2 space-y-2 border-l border-smoke-200 pl-3">
        {parameter.components.map((component, index) => (
          <ArgumentRow
            key={`${component.name || 'field'}-${index}`}
            parameter={component}
            value={namedValue(value, component.name ?? '', index)}
            chainId={chainId}
            depth={depth + 1}
          />
        ))}
      </div>
    )
  }

  return (
    <p className="break-all font-mono text-xs leading-relaxed text-ink">
      {readableValue(parameter.type, value, chainId)}
    </p>
  )
}

export type V4PlanStep =
  | {
      action: 'DECREASE_LIQUIDITY'
      position: string
      liquidity: bigint
      minimumOut: { currency0: bigint; currency1: bigint }
    }
  | {
      action: 'MINT_POSITION'
      owner: string
      pool: { currency0: string; currency1: string; fee: number; tickSpacing: number; hook: string }
      ticks: { lower: number; upper: number }
      liquidity: bigint
      maximumIn: { currency0: bigint; currency1: bigint }
    }
  | {
      action: 'BURN_POSITION'
      position: string
      minimumOut: { currency0: bigint; currency1: bigint }
    }
  | { action: 'TAKE_PAIR'; currency0: string; currency1: string; recipient: string }
  | { action: 'CLOSE_CURRENCY'; currency: string }
  | { action: 'SWEEP'; currency: string; recipient: string }

/**
 * Decode a Uniswap V4 PositionManager `unlockData` plan into typed steps.
 * Covers only the actions this app builds (mint/burn/decrease/take/close/
 * sweep); anything unrecognized falls back to the raw argument view — a
 * pretty rendering must never paper over bytes it can't fully account for.
 * Amounts stay in raw token units on purpose: this dialog shows the exact
 * payload. Addresses stay raw here; the renderer resolves known names.
 */
export function describeV4UnlockData(value: unknown): V4PlanStep[] | null {
  if (typeof value !== 'string' || !value.startsWith('0x')) return null
  try {
    const [actions, params] = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      value as Hex,
    )
    const codes = actions.slice(2).match(/.{2}/g) ?? []
    if (!codes.length || codes.length !== params.length) return null
    const steps: V4PlanStep[] = []
    for (const [index, byte] of codes.entries()) {
      const data = params[index]
      switch (parseInt(byte, 16)) {
        case 0x01: {
          const [tokenId, liquidity, amount0Min, amount1Min] = decodeAbiParameters(
            [
              { type: 'uint256' },
              { type: 'uint128' },
              { type: 'uint128' },
              { type: 'uint128' },
              { type: 'bytes' },
            ],
            data,
          )
          steps.push({
            action: 'DECREASE_LIQUIDITY',
            position: `#${tokenId}`,
            liquidity,
            minimumOut: { currency0: amount0Min, currency1: amount1Min },
          })
          break
        }
        case 0x02: {
          const [key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner] =
            decodeAbiParameters(
              [
                {
                  type: 'tuple',
                  components: [
                    { type: 'address' },
                    { type: 'address' },
                    { type: 'uint24' },
                    { type: 'int24' },
                    { type: 'address' },
                  ],
                },
                { type: 'int24' },
                { type: 'int24' },
                { type: 'uint256' },
                { type: 'uint128' },
                { type: 'uint128' },
                { type: 'address' },
                { type: 'bytes' },
              ],
              data,
            )
          steps.push({
            action: 'MINT_POSITION',
            owner,
            pool: {
              currency0: key[0],
              currency1: key[1],
              fee: key[2],
              tickSpacing: key[3],
              hook: key[4],
            },
            ticks: { lower: tickLower, upper: tickUpper },
            liquidity,
            maximumIn: { currency0: amount0Max, currency1: amount1Max },
          })
          break
        }
        case 0x03: {
          const [tokenId, amount0Min, amount1Min] = decodeAbiParameters(
            [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
            data,
          )
          steps.push({
            action: 'BURN_POSITION',
            position: `#${tokenId}`,
            minimumOut: { currency0: amount0Min, currency1: amount1Min },
          })
          break
        }
        case 0x11: {
          const [currency0, currency1, recipient] = decodeAbiParameters(
            [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
            data,
          )
          steps.push({ action: 'TAKE_PAIR', currency0, currency1, recipient })
          break
        }
        case 0x12: {
          const [currency] = decodeAbiParameters([{ type: 'address' }], data)
          steps.push({ action: 'CLOSE_CURRENCY', currency })
          break
        }
        case 0x14: {
          const [currency, recipient] = decodeAbiParameters(
            [{ type: 'address' }, { type: 'address' }],
            data,
          )
          steps.push({ action: 'SWEEP', currency, recipient })
          break
        }
        default:
          return null
      }
    }
    return steps
  } catch {
    return null
  }
}

/** The pay-confirm row grammar: `Label: value`, addresses resolved to known names. */
function V4PlanRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-1">
      <dt className="shrink-0 text-smoke-500">{label}:</dt>
      <dd className="min-w-0 break-all font-mono text-smoke-700">{children}</dd>
    </div>
  )
}

function v4AddressLabel(chainId: number, address: string): string {
  if (address.toLowerCase() === zeroAddress) return `native ETH | ${address}`
  const label = knownAddressName(chainId, address)
  return label ? `${label} | ${address}` : address
}

function v4Amounts(pair: { currency0: bigint; currency1: bigint }): string {
  return `${pair.currency0} (currency0) + ${pair.currency1} (currency1)`
}

/** A decoded unlockData plan in the same row grammar the pay confirm uses. */
function V4PlanView({ steps, chainId }: { steps: V4PlanStep[]; chainId: number }) {
  return (
    <div className="mt-1 space-y-3 text-xs">
      {steps.map((step, index) => {
        const title = (text: string) => (
          <p className="font-medium text-ink">
            {index + 1}. {text}
          </p>
        )
        switch (step.action) {
          case 'BURN_POSITION':
            return (
              <dl key={index} className="space-y-0.5">
                {title(`Burn position ${step.position}`)}
                <V4PlanRow label="Minimum out">
                  {v4Amounts(step.minimumOut)} — reverts below this
                </V4PlanRow>
              </dl>
            )
          case 'DECREASE_LIQUIDITY':
            return (
              <dl key={index} className="space-y-0.5">
                {title(
                  step.liquidity === 0n
                    ? `Collect fees on position ${step.position} (liquidity untouched)`
                    : `Decrease position ${step.position}`,
                )}
                {step.liquidity !== 0n ? (
                  <>
                    <V4PlanRow label="Liquidity">{String(step.liquidity)}</V4PlanRow>
                    <V4PlanRow label="Minimum out">
                      {v4Amounts(step.minimumOut)} — reverts below this
                    </V4PlanRow>
                  </>
                ) : null}
              </dl>
            )
          case 'MINT_POSITION':
            return (
              <dl key={index} className="space-y-0.5">
                {title('Mint a new position')}
                <V4PlanRow label="Owner">{v4AddressLabel(chainId, step.owner)}</V4PlanRow>
                <V4PlanRow label="Currency0">
                  {v4AddressLabel(chainId, step.pool.currency0)}
                </V4PlanRow>
                <V4PlanRow label="Currency1">
                  {v4AddressLabel(chainId, step.pool.currency1)}
                </V4PlanRow>
                <V4PlanRow label="Fee">
                  {step.pool.fee} ({step.pool.fee / 10_000}%) | tick spacing {step.pool.tickSpacing}
                </V4PlanRow>
                <V4PlanRow label="Hook">{v4AddressLabel(chainId, step.pool.hook)}</V4PlanRow>
                <V4PlanRow label="Ticks">
                  {step.ticks.lower} → {step.ticks.upper}
                </V4PlanRow>
                <V4PlanRow label="Liquidity">{String(step.liquidity)}</V4PlanRow>
                <V4PlanRow label="Maximum in">{v4Amounts(step.maximumIn)}</V4PlanRow>
              </dl>
            )
          case 'TAKE_PAIR':
            return (
              <dl key={index} className="space-y-0.5">
                {title('Take both currencies')}
                <V4PlanRow label="Currency0">
                  {v4AddressLabel(chainId, step.currency0)}
                </V4PlanRow>
                <V4PlanRow label="Currency1">
                  {v4AddressLabel(chainId, step.currency1)}
                </V4PlanRow>
                <V4PlanRow label="Recipient">{v4AddressLabel(chainId, step.recipient)}</V4PlanRow>
              </dl>
            )
          case 'CLOSE_CURRENCY':
            return (
              <dl key={index} className="space-y-0.5">
                {title('Close currency — settle the net; leftovers return to the caller')}
                <V4PlanRow label="Currency">{v4AddressLabel(chainId, step.currency)}</V4PlanRow>
              </dl>
            )
          case 'SWEEP':
            return (
              <dl key={index} className="space-y-0.5">
                {title('Sweep — refund unused balance')}
                <V4PlanRow label="Currency">{v4AddressLabel(chainId, step.currency)}</V4PlanRow>
                <V4PlanRow label="Recipient">{v4AddressLabel(chainId, step.recipient)}</V4PlanRow>
              </dl>
            )
        }
      })}
      <p className="text-smoke-500">The exact bytes are in the raw payload below.</p>
    </div>
  )
}

function ArgumentRow({
  parameter,
  value,
  chainId,
  depth = 0,
}: {
  parameter: AbiParameter
  value: unknown
  chainId: number
  depth?: number
}) {
  return (
    <div className={depth ? '' : 'rounded-lg bg-grey-25 px-3 py-2.5'}>
      <p className="text-xs font-medium text-smoke-700">
        {parameter.name || 'argument'}{' '}
        <span className="font-mono font-normal text-smoke-500">
          {parameter.type}
        </span>
      </p>
      <ArgumentValue parameter={parameter} value={value} chainId={chainId} depth={depth} />
    </div>
  )
}

/** Universal Router sentinels the direct-pay swap builders use. */
const UR_MSG_SENDER = "0x0000000000000000000000000000000000000001";
const UR_ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const UR_CONTRACT_BALANCE = 1n << 255n;

export type UrStep = { title: string; rows: [string, string][] };

function urRecipient(chainId: number, address: string): string {
  if (address.toLowerCase() === UR_MSG_SENDER) return "you (msg.sender)";
  if (address.toLowerCase() === UR_ADDRESS_THIS) return "the router (kept for the next step)";
  return v4AddressLabel(chainId, address);
}

function urAmount(value: bigint): string {
  if (value === UR_CONTRACT_BALANCE) return "the router's entire balance from the previous step";
  if (value === 0n) return "0 (the open amount from the previous step)";
  return value.toString();
}

/** A packed V3 path: 20-byte token, 3-byte fee, 20-byte token, … */
function urV3Path(chainId: number, path: string): string | null {
  const raw = path.slice(2);
  if (raw.length < 86 || (raw.length - 40) % 46 !== 0) return null;
  const parts: string[] = [v4AddressLabel(chainId, `0x${raw.slice(0, 40)}`)];
  for (let offset = 40; offset < raw.length; offset += 46) {
    const fee = parseInt(raw.slice(offset, offset + 6), 16);
    parts.push(`-${fee / 10_000}%→`, v4AddressLabel(chainId, `0x${raw.slice(offset + 6, offset + 46)}`));
  }
  return parts.join(" ");
}

/** The V4_SWAP command's inner action plan (the shapes the pay builders emit). */
function urV4SwapSteps(chainId: number, input: Hex): UrStep[] | null {
  const [actions, params] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    input,
  );
  const codes = actions.slice(2).match(/.{2}/g) ?? [];
  if (!codes.length || codes.length !== params.length) return null;
  const steps: UrStep[] = [];
  for (const [index, byte] of codes.entries()) {
    const data = params[index];
    switch (parseInt(byte, 16)) {
      case 0x06: {
        const [swap] = decodeAbiParameters(
          [
            {
              type: "tuple",
              components: [
                {
                  type: "tuple",
                  components: [
                    { type: "address" },
                    { type: "address" },
                    { type: "uint24" },
                    { type: "int24" },
                    { type: "address" },
                  ],
                },
                { type: "bool" },
                { type: "uint128" },
                { type: "uint128" },
                { type: "bytes" },
              ],
            },
          ],
          data,
        );
        const [key, zeroForOne, amountIn, minimumOut] = swap;
        const currencyIn = zeroForOne ? key[0] : key[1];
        const currencyOut = zeroForOne ? key[1] : key[0];
        steps.push({
          title: "Swap in the project's V4 pool (exact input)",
          rows: [
            ["Sell", v4AddressLabel(chainId, currencyIn)],
            ["Buy", v4AddressLabel(chainId, currencyOut)],
            ["Amount in", urAmount(amountIn)],
            ["Minimum out", `${minimumOut} — reverts below this`],
            ["Fee", `${key[2]} (${key[2] / 10_000}%) | tick spacing ${key[3]}`],
            ["Hook", v4AddressLabel(chainId, key[4])],
          ],
        });
        break;
      }
      case 0x0b: {
        const [currency, amount] = decodeAbiParameters(
          [{ type: "address" }, { type: "uint256" }, { type: "bool" }],
          data,
        );
        steps.push({
          title: "Pay the pool",
          rows: [
            ["Currency", v4AddressLabel(chainId, currency)],
            ["Amount", urAmount(amount)],
          ],
        });
        break;
      }
      case 0x0c: {
        const [currency, maximum] = decodeAbiParameters(
          [{ type: "address" }, { type: "uint256" }],
          data,
        );
        steps.push({
          title: "Pay the pool everything owed",
          rows: [
            ["Currency", v4AddressLabel(chainId, currency)],
            ["At most", maximum.toString()],
          ],
        });
        break;
      }
      case 0x0e: {
        const [currency, recipient, amount] = decodeAbiParameters(
          [{ type: "address" }, { type: "address" }, { type: "uint256" }],
          data,
        );
        steps.push({
          title: "Take the swap output",
          rows: [
            ["Currency", v4AddressLabel(chainId, currency)],
            ["Recipient", urRecipient(chainId, recipient)],
            ["Amount", urAmount(amount)],
          ],
        });
        break;
      }
      default:
        return null;
    }
  }
  return steps;
}

/**
 * Decode a Uniswap Universal Router `execute(commands, inputs, deadline)` into
 * readable steps. Covers only the command shapes the pay flow builds (Permit2
 * permit, wrap, V3 hop, unwrap, V4 swap); anything unrecognized falls back to
 * the raw argument view — a pretty rendering must never paper over bytes it
 * can't fully account for.
 */
export function describeUniversalRouterExecute(
  chainId: number,
  args: readonly unknown[] | undefined,
): UrStep[] | null {
  if (!args || args.length < 2) return null;
  const [commands, inputs] = args as [unknown, unknown];
  if (typeof commands !== "string" || !commands.startsWith("0x") || !Array.isArray(inputs)) {
    return null;
  }
  try {
    const codes = commands.slice(2).match(/.{2}/g) ?? [];
    if (!codes.length || codes.length !== inputs.length) return null;
    const steps: UrStep[] = [];
    for (const [index, byte] of codes.entries()) {
      const data = inputs[index] as Hex;
      switch (parseInt(byte, 16)) {
        case 0x00: {
          const [recipient, amountIn, minimumOut, path, payerIsUser] = decodeAbiParameters(
            [
              { type: "address" },
              { type: "uint256" },
              { type: "uint256" },
              { type: "bytes" },
              { type: "bool" },
            ],
            data,
          );
          const route = urV3Path(chainId, path);
          if (!route) return null;
          steps.push({
            title: "Swap through a V3 pool (exact input)",
            rows: [
              ["Route", route],
              ["Amount in", urAmount(amountIn)],
              ["Minimum out", minimumOut === 0n ? "0 — the final V4 minimum below is the real floor" : minimumOut.toString()],
              ["Paid by", payerIsUser ? "you (via Permit2)" : "the router's balance"],
              ["Recipient", urRecipient(chainId, recipient)],
            ],
          });
          break;
        }
        case 0x0a: {
          const [permit] = decodeAbiParameters(
            [
              {
                type: "tuple",
                components: [
                  {
                    type: "tuple",
                    components: [
                      { type: "address" },
                      { type: "uint160" },
                      { type: "uint48" },
                      { type: "uint48" },
                    ],
                  },
                  { type: "address" },
                  { type: "uint256" },
                ],
              },
              { type: "bytes" },
            ],
            data,
          );
          const [details, spender, sigDeadline] = permit;
          steps.push({
            title: "Apply your signed Permit2 authorization",
            rows: [
              ["Token", v4AddressLabel(chainId, details[0])],
              ["Amount", details[1].toString()],
              ["Spender", v4AddressLabel(chainId, spender)],
              ["Expires", new Date(Number(details[2]) * 1000).toLocaleString()],
              ["Signature deadline", new Date(Number(sigDeadline) * 1000).toLocaleString()],
            ],
          });
          break;
        }
        case 0x0b: {
          const [recipient, amount] = decodeAbiParameters(
            [{ type: "address" }, { type: "uint256" }],
            data,
          );
          steps.push({
            title: "Wrap ETH into WETH",
            rows: [
              ["Amount", urAmount(amount)],
              ["Recipient", urRecipient(chainId, recipient)],
            ],
          });
          break;
        }
        case 0x0c: {
          const [recipient, minimum] = decodeAbiParameters(
            [{ type: "address" }, { type: "uint256" }],
            data,
          );
          steps.push({
            title: "Unwrap WETH back to ETH",
            rows: [
              ["Minimum", urAmount(minimum)],
              ["Recipient", urRecipient(chainId, recipient)],
            ],
          });
          break;
        }
        case 0x10: {
          const inner = urV4SwapSteps(chainId, data);
          if (!inner) return null;
          steps.push(...inner);
          break;
        }
        default:
          return null;
      }
    }
    return steps;
  } catch {
    return null;
  }
}

/** A decoded Universal Router plan in the same row grammar as everything else. */
function UrPlanView({ steps, deadline }: { steps: UrStep[]; deadline?: unknown }) {
  return (
    <div className="mt-3 space-y-3 text-xs">
      {steps.map((step, index) => (
        <dl key={index} className="space-y-0.5">
          <p className="font-medium text-ink">
            {index + 1}. {step.title}
          </p>
          {step.rows.map(([label, value]) => (
            <V4PlanRow key={label} label={label}>
              {value}
            </V4PlanRow>
          ))}
        </dl>
      ))}
      {deadline != null ? (
        <dl className="space-y-0.5">
          <V4PlanRow label="Deadline">
            {new Date(Number(deadline) * 1000).toLocaleString()}
          </V4PlanRow>
        </dl>
      ) : null}
      <p className="text-smoke-500">The exact bytes are in the raw payload below.</p>
    </div>
  )
}

function functionFromCall(call: TransactionReviewCall): AbiFunction | null {
  if (!call.abi || !call.functionName) return null
  const selector = call.data.slice(0, 10)
  return (
    (call.abi.find(
      item =>
        item.type === 'function' &&
        item.name === call.functionName &&
        (selector.length !== 10 || toFunctionSelector(item) === selector),
    ) as AbiFunction | undefined) ?? null
  )
}

function nativeValue(value = 0n): string {
  return `${formatEther(value)} ETH | ${value.toString()} wei`
}

function PrettyCall({
  call,
  index,
  total,
}: {
  call: TransactionReviewCall
  index: number
  total: number
}) {
  const fn = functionFromCall(call)
  const args = call.args ?? []
  const byteLength = Math.max(0, (call.data.length - 2) / 2)
  const contractName = knownContractName(call)
  return (
    <section className="rounded-xl border border-smoke-200 bg-white p-4 sm:p-5">
      {total > 1 ? (
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-smoke-500">
          Transaction {index + 1} of {total}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="chip flex items-center gap-1.5 bg-bluebs-50 text-bluebs-700">
          <ChainIcon chainId={call.chainId} size={16} />
          {chainName(call.chainId)}
        </span>
        <span className="font-mono text-[11px] text-smoke-500">
          chain {call.chainId}
        </span>
      </div>

      {call.label ? (
        <h3 className="mt-3 font-agrandir text-base font-medium text-ink">
          {call.label}
        </h3>
      ) : null}

      <dl className="mt-4 space-y-3 text-sm">
        {call.from ? (
          <div>
            <dt className="text-xs font-medium text-smoke-600">From</dt>
            <dd className="mt-1 break-all font-mono text-xs text-ink">
              {call.from}
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-xs font-medium text-smoke-600">
            Destination{contractName ? ` | ${contractName}` : ''}
          </dt>
          <dd className="mt-1 break-all font-mono text-xs text-ink">{call.to}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-smoke-600">Native value</dt>
          <dd className="mt-1 font-mono text-xs text-ink">
            {nativeValue(call.value)}
          </dd>
        </div>
      </dl>

      {fn ? (
        <div className="mt-5 border-t border-smoke-200 pt-4">
          <p className="text-xs font-medium text-smoke-600">Contract function</p>
          <p className="mt-1 break-all font-mono text-sm font-medium text-ink">
            {fn.name}(
            {fn.inputs.map(input => input.type).join(', ')})
          </p>
          {fn.name === 'execute' &&
          describeUniversalRouterExecute(call.chainId, args) ? (
            <UrPlanView
              steps={describeUniversalRouterExecute(call.chainId, args)!}
              deadline={args[2]}
            />
          ) : fn.inputs.length ? (
            <div className="mt-3 space-y-2">
              {fn.inputs.map((parameter, argumentIndex) => {
                const decodedPlan =
                  fn.name === 'modifyLiquidities' && parameter.name === 'unlockData'
                    ? describeV4UnlockData(args[argumentIndex])
                    : null
                if (decodedPlan) {
                  return (
                    <div
                      key={`${parameter.name || 'argument'}-${argumentIndex}`}
                      className="rounded-lg bg-grey-25 px-3 py-2.5"
                    >
                      <p className="text-xs font-medium text-smoke-700">
                        {parameter.name}{' '}
                        <span className="font-mono font-normal text-smoke-500">
                          {parameter.type} · decoded plan
                        </span>
                      </p>
                      <V4PlanView steps={decodedPlan} chainId={call.chainId} />
                    </div>
                  )
                }
                return (
                  <ArgumentRow
                    key={`${parameter.name || 'argument'}-${argumentIndex}`}
                    parameter={parameter}
                    value={args[argumentIndex]}
                    chainId={call.chainId}
                  />
                )
              })}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-5 rounded-lg bg-split-50 p-3 text-xs leading-relaxed text-split-800">
          <p className="font-medium">
            This call’s ABI is not available in this flow. Check the complete
            calldata in Raw before continuing.
          </p>
          <p className="mt-1 font-mono">
            {call.data === '0x' ? 'No calldata' : `Selector ${call.data.slice(0, 10)}`}
          </p>
        </div>
      )}

      <p className="mt-3 text-[11px] text-smoke-500">
        Calldata: {byteLength.toLocaleString()} byte{byteLength === 1 ? '' : 's'}
      </p>
    </section>
  )
}

function ReviewModal({
  pending,
  onFinish,
}: {
  pending: PendingReview
  onFinish: (approved: boolean) => void
}) {
  const { request } = pending
  const [agreed, setAgreed] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(buildTransactionReviewPrompt(request))
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    window.setTimeout(() => setCopyState('idle'), 2200)
  }

  const titleId = `transaction-review-title-${pending.id}`
  const descriptionId = `transaction-review-description-${pending.id}`
  const isAuthorization = request.kind === 'authorization'
  const defaultDescription = isAuthorization
    ? 'This authorization commits to the exact destination, native value, and calldata below. A Safe or relayer can submit that call onchain after you continue.'
    : 'This is the exact destination, native value, and calldata the app will ask your wallet to send. Your wallet adds the nonce, gas limit, and network fees.'

  return (
    <ModalDialog
      onClose={() => onFinish(false)}
      labelledBy={titleId}
      describedBy={descriptionId}
      className="modal-dialog-blur items-start justify-center px-3 py-4 sm:px-6 sm:py-8"
    >
      <div
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-smoke-300 bg-bone shadow-2xl sm:max-h-[calc(100vh-4rem)]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-smoke-200 bg-white px-4 py-4 sm:px-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-bluebs-600">
              Client safety check
            </p>
            <h2
              id={titleId}
              className="mt-1 font-agrandir text-xl font-medium text-ink"
            >
              {request.title ??
                (isAuthorization ? 'Review authorization' : 'Review transaction')}
            </h2>
          </div>
          <ModalCloseButton
            onClick={() => onFinish(false)}
            aria-label="Cancel transaction review"
            className="-mr-2 -mt-2"
          />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <div className="rounded-xl border border-bluebs-100 bg-bluebs-25 px-4 py-3">
            <p
              id={descriptionId}
              className="whitespace-pre-line text-sm leading-relaxed text-bluebs-800"
            >
              {request.description ?? defaultDescription}
            </p>
          </div>
          {request.authorization ? (
            <div className="mt-3 rounded-xl border border-bluebs-100 bg-bluebs-25 px-4 py-3 text-xs leading-relaxed text-bluebs-700">
              The Raw view also includes the exact typed-data domain and message
              your signature commits to.
            </div>
          ) : null}

          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={copyPrompt}
              className="btn-link min-h-[36px] text-xs"
            >
              {copyState === 'copied'
                ? 'Prompt copied — paste into your LLM'
                : copyState === 'failed'
                  ? 'Could not copy prompt'
                  : '[copy tx audit prompt]'}
            </button>
          </div>

          <div className="mt-4 space-y-4">
            {request.calls.map((call, index) => (
              <PrettyCall
                key={`${call.chainId}-${call.to}-${index}`}
                call={call}
                index={index}
                total={request.calls.length}
              />
            ))}
          </div>

          <details className="mt-4 overflow-hidden rounded-xl border border-smoke-200 bg-white">
            <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-smoke-700 hover:bg-grey-25">
              Raw transaction payload
            </summary>
            <div className="border-t border-smoke-200 p-4">
              <p className="mb-2 text-xs leading-relaxed text-smoke-600">
                {request.authorization
                  ? 'Exact typed data plus the resulting app-controlled call. Hex value is the native token amount; data is the complete calldata.'
                  : 'Exact app-controlled JSON-RPC call fields. Hex value is the native token amount; data is the complete calldata.'}
              </p>
              <pre className="max-h-[28rem] overflow-auto rounded-xl border border-smoke-200 bg-grey-900 p-4 font-mono text-[11px] leading-relaxed text-grey-25">
                {transactionReviewJson(request)}
              </pre>
            </div>
          </details>
        </div>

        <footer className="shrink-0 border-t border-smoke-200 bg-white px-4 py-4 sm:px-6">
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-smoke-200 bg-grey-25 p-3 text-sm leading-relaxed text-ink">
            <input
              type="checkbox"
              checked={agreed}
              onChange={event => setAgreed(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span>
              I reviewed the chain, destination, native value, and calldata
              {request.authorization ? ', plus the exact typed data' : ''}. I
              agree to {isAuthorization ? 'authorize' : 'send'} this exact call.
            </span>
          </label>
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => onFinish(false)}
              className="btn-secondary min-h-[44px] px-5 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onFinish(true)}
              disabled={!agreed}
              className="btn-primary min-h-[44px] px-5 text-sm"
            >
              {request.confirmLabel ??
                (isAuthorization ? 'Agree & authorize' : 'Agree & continue')}
            </button>
          </div>
        </footer>
      </div>
    </ModalDialog>
  )
}

/**
 * Global, promise-based modal queue. Every low-level transaction boundary
 * registers with this one provider, so simultaneous multichain flows review
 * sequentially and each approval applies to one immutable call snapshot.
 */
export function TransactionReviewProvider({ children }: PropsWithChildren) {
  const { address } = useAccount()
  const accountRef = useRef<Address | undefined>(address)
  accountRef.current = address
  const nextId = useRef(1)
  const activeRef = useRef<PendingReview | null>(null)
  const queueRef = useRef<PendingReview[]>([])
  const [active, setActive] = useState<PendingReview | null>(null)

  const enqueue = useCallback(
    (request: TransactionReviewRequest) =>
      new Promise<boolean>(resolve => {
        const snapshot: TransactionReviewRequest = {
          ...request,
          calls: request.calls.map(call => ({
            ...call,
            from: call.from ?? accountRef.current,
            args: call.args ? [...call.args] : undefined,
          })),
        }
        const pending: PendingReview = {
          id: nextId.current++,
          request: snapshot,
          resolve,
        }
        if (activeRef.current) {
          queueRef.current.push(pending)
          return
        }
        activeRef.current = pending
        setActive(pending)
      }),
    [],
  )

  useEffect(() => registerTransactionReviewHandler(enqueue), [enqueue])

  useEffect(
    () => () => {
      activeRef.current?.resolve(false)
      queueRef.current.forEach(pending => pending.resolve(false))
      activeRef.current = null
      queueRef.current = []
    },
    [],
  )

  const finish = useCallback((approved: boolean) => {
    const current = activeRef.current
    if (!current) return
    const next = queueRef.current.shift() ?? null
    activeRef.current = next
    setActive(next)
    current.resolve(approved)
  }, [])

  return (
    <>
      {children}
      {active ? <ReviewModal key={active.id} pending={active} onFinish={finish} /> : null}
    </>
  )
}
