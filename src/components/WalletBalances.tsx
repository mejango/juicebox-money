'use client'

import {
  JB_CHAINS,
  JBCoreContracts,
  USDC_ADDRESSES,
  jbContractAddress,
  jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import { erc20Abi, type Address } from 'viem'
import { useBalance, useConfig, useReadContract } from 'wagmi'
import { getBalance, readContract } from 'wagmi/actions'
import { useProjectTokenSymbol } from '@/hooks/useProjectTokenSymbol'
import { formatTokenAmount } from '@/lib/format'
import {
  getProject,
  getSuckerGroupProjects,
  resolveProjectDeployments,
} from '@/lib/bendystraw'

function formatWalletBalance(
  value: bigint | undefined,
  decimals: number,
  symbol: string,
) {
  if (value === undefined) return 'Loading…'
  return `${formatTokenAmount(value, decimals)} ${symbol}`
}

function BalanceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-5">
      <dt className="text-smoke-600">{label}</dt>
      <dd className="whitespace-nowrap font-medium text-ink">{value}</dd>
    </div>
  )
}

function ProjectWalletBalances({
  address,
  chainId,
  projectId,
}: {
  address: Address
  chainId: JBChainId
  projectId: number
}) {
  const config = useConfig()
  const { data: projectToken, isLoading: projectTokenLoading } =
    useProjectTokenSymbol(chainId, projectId)
  const deployments = useQuery({
    queryKey: ['walletProjectDeployments', chainId, projectId],
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const home = await getProject(chainId, projectId, { signal })
      if (!home) return [{ chainId, projectId }]
      const peers = home.suckerGroupId
        ? await getSuckerGroupProjects(home.suckerGroupId, chainId, { signal })
        : []
      return resolveProjectDeployments(home, peers).map(project => ({
        chainId: project.chainId as JBChainId,
        projectId: project.projectId,
      }))
    },
  })
  const deploymentKey = (deployments.data ?? [])
    .map(project => `${project.chainId}:${project.projectId}`)
    .join(',')
  const balances = useQuery({
    queryKey: ['walletProjectBalances', address, deploymentKey],
    enabled: !!deploymentKey,
    staleTime: 30_000,
    queryFn: async () => {
      const rows = await Promise.all(
        (deployments.data ?? []).map(async project => {
          const tokens = jbContractAddress['6'][JBCoreContracts.JBTokens][
            project.chainId
          ] as Address | undefined
          if (!tokens) throw new Error(`Unsupported chain ${project.chainId}`)
          const usdc = USDC_ADDRESSES[project.chainId]
          const [nativeBalance, usdcBalance, projectBalance] = await Promise.all([
            getBalance(config, { address, chainId: project.chainId }),
            usdc
              ? readContract(config, {
                  abi: erc20Abi,
                  address: usdc,
                  chainId: project.chainId,
                  functionName: 'balanceOf',
                  args: [address],
                })
              : Promise.resolve(0n),
            readContract(config, {
              abi: jbTokensAbi,
              address: tokens,
              chainId: project.chainId,
              functionName: 'totalBalanceOf',
              args: [address, BigInt(project.projectId)],
            }),
          ])
          return { nativeBalance, usdcBalance, projectBalance }
        }),
      )
      return {
        native: rows.reduce((sum, row) => sum + row.nativeBalance.value, 0n),
        nativeSymbol: rows[0]?.nativeBalance.symbol ?? 'ETH',
        project: rows.reduce((sum, row) => sum + row.projectBalance, 0n),
        usdc: rows.reduce((sum, row) => sum + row.usdcBalance, 0n),
      }
    },
  })
  const chainCount = deployments.data?.length ?? 0
  const loading = deployments.isLoading || balances.isLoading

  return (
    <div className="border-b border-smoke-200 px-4 py-3 text-xs">
      <div className="mb-2 text-smoke-600">
        {chainCount ? `Across ${chainCount} project chains` : 'Across project chains'}
      </div>
      <dl className="space-y-1.5">
        <BalanceRow
          label={balances.data?.nativeSymbol ?? 'ETH'}
          value={
            loading
              ? 'Loading…'
              : balances.data
                ? formatWalletBalance(
                    balances.data.native,
                    18,
                    balances.data.nativeSymbol,
                  )
                : 'Unavailable'
          }
        />
        <BalanceRow
          label="USDC"
          value={
            loading
              ? 'Loading…'
              : balances.data
                ? formatWalletBalance(balances.data.usdc, 6, 'USDC')
                : 'Unavailable'
          }
        />
        <BalanceRow
          label={projectToken?.symbol ?? 'Project token'}
          value={
            loading || projectTokenLoading
              ? 'Loading…'
              : balances.data && projectToken
                ? formatWalletBalance(
                    balances.data.project,
                    18,
                    projectToken.symbol,
                  )
                : 'Unavailable'
          }
        />
      </dl>
    </div>
  )
}

function SingleChainWalletBalances({
  address,
  chainId,
}: {
  address: Address
  chainId: JBChainId
}) {
  const chain = JB_CHAINS[chainId]
  const nativeSymbol = chain?.nativeTokenSymbol ?? 'ETH'
  const usdc = USDC_ADDRESSES[chainId]
  const { data: nativeBalance } = useBalance({ address, chainId })
  const { data: usdcBalance } = useReadContract({
    abi: erc20Abi,
    address: usdc,
    chainId,
    functionName: 'balanceOf',
    args: [address],
    query: { enabled: !!usdc },
  })
  return (
    <div className="border-b border-smoke-200 px-4 py-3 text-xs">
      <div className="mb-2 text-smoke-600">{chain?.name ?? `Chain ${chainId}`}</div>
      <dl className="space-y-1.5">
        <BalanceRow
          label={nativeSymbol}
          value={formatWalletBalance(nativeBalance?.value, 18, nativeSymbol)}
        />
        <BalanceRow
          label="USDC"
          value={
            usdc
              ? formatWalletBalance(usdcBalance, 6, 'USDC')
              : 'Unavailable'
          }
        />
      </dl>
    </div>
  )
}

export function WalletBalances({
  address,
  chainId,
  projectId,
}: {
  address: Address
  chainId: JBChainId
  projectId?: number
}) {
  return projectId ? (
    <ProjectWalletBalances
      address={address}
      chainId={chainId}
      projectId={projectId}
    />
  ) : (
    <SingleChainWalletBalances address={address} chainId={chainId} />
  )
}
