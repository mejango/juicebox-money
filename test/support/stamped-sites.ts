import {
  buildCollectUniswapV4FeesTx,
  buildPermit2ApproveTx,
  buildUniswapV4ExactInputSwapTx,
  uniswapV4Deployment,
  type UniswapV4PoolKey,
} from '@bananapus/nana-sdk-core/v6'
import { decodeAbiParameters, type Address, type Hex } from 'viem'
import type { TxRequest } from '@/hooks/useSafeTx'
import {
  buildDirectPaySwapTx,
  restampDirectSwapDeadline,
  type DirectPaySwapQuote,
} from '@/lib/direct-pay-swap'
import { buildCollectMarketFeesUnlockData } from '@/lib/market-liquidity'
import {
  buildModifyLiquiditiesRequest,
  buildPermit2ApproveRequest,
  buildRemoveLiquidityUnlockData,
} from '@/lib/transaction-builders'

/**
 * Every call this app sends through useSafeTx with a field stamped at send
 * time, built as its site builds it. `build(stamp, other)` sends the stamp
 * (a deadline, or Permit2's expiration) and changes one other field when
 * `other` is not 0.
 */

/** Chain 10 has Safe's service and every Uniswap deployment these calls use. */
export const STAMPED_CHAIN = 10
const deployment = uniswapV4Deployment(STAMPED_CHAIN)!
const POSITION_MANAGER = deployment.positionManager!
const SAFE = '0x1111111111111111111111111111111111111111' as Address
const TOKEN = '0x3333333333333333333333333333333333333333' as Address
const NATIVE = '0x0000000000000000000000000000000000000000' as Address
const HOOK = '0x4444444444444444444444444444444444444444' as Address
const poolKey: UniswapV4PoolKey = {
  currency0: NATIVE,
  currency1: TOKEN,
  fee: 3000,
  tickSpacing: 60,
  hooks: HOOK,
}

function request(built: {
  chainId: number
  address: Address
  abi: unknown
  functionName: string
  args: readonly unknown[]
  value?: bigint
}): TxRequest {
  return built as TxRequest
}

const liquidity = (unlockData: Hex, stamp: bigint) =>
  request(
    buildModifyLiquiditiesRequest({
      chainId: STAMPED_CHAIN,
      positionManager: POSITION_MANAGER,
      unlockData,
      deadline: stamp,
      value: 0n,
    }),
  )

const removal = (other: bigint) =>
  buildRemoveLiquidityUnlockData({
    tokenId: 7n + other,
    currency0: NATIVE,
    currency1: TOKEN,
    recipient: SAFE,
    amount0Min: 95n,
    amount1Min: 950n,
  })

const positionManagerAuthorization = (stamp: bigint, other = 0n) =>
  request(
    buildPermit2ApproveRequest({
      chainId: STAMPED_CHAIN,
      token: TOKEN,
      positionManager: POSITION_MANAGER,
      amount: 10n ** 18n + other,
      expiration: Number(stamp),
    }),
  )

const routerAuthorization = (stamp: bigint, other = 0n) =>
  request(
    buildPermit2ApproveTx({
      chainId: STAMPED_CHAIN,
      token: TOKEN,
      amount: 5n * 10n ** 18n + other,
      expiration: Number(stamp),
    }),
  )

export const STAMPED_SITES: readonly [site: string, build: (stamp: bigint, other?: bigint) => TxRequest][] = [
  [
    'the pool sale (CashOutFlow)',
    (stamp, other = 0n) =>
      request(
        buildUniswapV4ExactInputSwapTx({
          chainId: STAMPED_CHAIN,
          poolKey,
          zeroForOne: false,
          amountIn: 10n ** 18n,
          minimumAmountOut: 10n ** 15n + other,
          recipient: SAFE,
          deadline: stamp,
        }),
      ),
  ],
  ['the router authorization (CashOutFlow)', routerAuthorization],
  ['the router authorization (PayPanel)', routerAuthorization],
  [
    'the direct swap payment (PayPanel)',
    (stamp, other = 0n) =>
      request(
        // Built at review, restamped as it is sent.
        restampDirectSwapDeadline(
          buildDirectPaySwapTx({
            chainId: STAMPED_CHAIN,
            quote: {
              poolKey,
              zeroForOne: true,
              minimumTokenCount: 10n ** 21n + other,
              inputRoute: { kind: 'single-v4' },
            } as unknown as DirectPaySwapQuote,
            amount: 10n ** 18n,
            recipient: SAFE,
            deadline: 1n,
          }),
          stamp,
        ),
      ),
  ],
  ['the position manager authorization (AddLiquidityFlow, EditPositionPanel, MarketEditPanel)', positionManagerAuthorization],
  ['the mint (AddLiquidityFlow)', (stamp, other = 0n) => liquidity(`0x0b${(other + 1n).toString(16).padStart(62, '0')}`, stamp)],
  ['the edit (EditPositionPanel)', (stamp, other = 0n) => liquidity(`0x0c${(other + 1n).toString(16).padStart(62, '0')}`, stamp)],
  ['the market edit (MarketEditPanel)', (stamp, other = 0n) => liquidity(`0x0d${(other + 1n).toString(16).padStart(62, '0')}`, stamp)],
  [
    "a position's fee claim (LiquidityPositions)",
    (stamp, other = 0n) => {
      // The inner collect is stamped too; only its unlock data is sent.
      const { data } = buildCollectUniswapV4FeesTx({
        positionManager: POSITION_MANAGER,
        tokenId: 7n + other,
        currency0: NATIVE,
        currency1: TOKEN,
        recipient: SAFE,
        deadline: stamp,
      })
      const [unlockData] = decodeAbiParameters([{ type: 'bytes' }, { type: 'uint256' }], `0x${data.slice(10)}`)
      return liquidity(unlockData, stamp)
    },
  ],
  [
    "several positions' fee claim (LiquidityPositions)",
    (stamp, other = 0n) =>
      liquidity(
        buildCollectMarketFeesUnlockData({ status: 'pool', key: poolKey } as never, [7n, 8n + other], SAFE),
        stamp,
      ),
  ],
  ['the removal (LiquidityPositions)', (stamp, other = 0n) => liquidity(removal(other), stamp)],
]

/** Whether the contract a site calls refuses the call once the chain passes its stamp. */
export const revertsOnceStampPasses = (site: string) => !site.includes('authorization')
