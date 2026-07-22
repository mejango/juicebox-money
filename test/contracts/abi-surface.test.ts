import {
  CCIP_SUCKER_DEPLOYER_ADDRESSES,
  MappableAsset,
  NATIVE_SUCKER_DEPLOYER_ADDRESSES,
  NATIVE_TOKEN,
  USDC_ADDRESSES,
  jb721TiersHookAbi,
  jbContractAddress,
  jbControllerAbi,
  jbMultiTerminalAbi,
  jbPermissionsAbi,
  parseSuckerDeployerConfig,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  pad,
  toFunctionSelector,
  zeroHash,
  type Abi,
  type AbiFunction,
  type Address,
} from 'viem'
import { describe, expect, it } from 'vitest'
import { addrOf } from '@/lib/contracts'
import deploymentFixture from '../fixtures/protocol-deployments.v6.json'

type FixtureOverride = Record<string, string | null>
type SuckerPairFixture = Record<
  string,
  Record<
    string,
    {
      ccip: { artifact: string; address: Address }
      native: { artifact: string; address: Address } | null
    }
  >
>

function functionOf(abi: Abi, name: string): AbiFunction {
  const fn = abi.find(
    (item): item is AbiFunction => item.type === 'function' && item.name === name,
  )
  if (!fn) throw new Error(`Missing ${name} in ABI`)
  return fn
}

describe('canonical v6 deployment surface', () => {
  it('matches the independently pinned deploy-all fixture on every app chain', () => {
    const sdk = jbContractAddress['6'] as unknown as Record<
      string,
      Partial<Record<JBChainId, string>>
    >

    for (const chainIdText of Object.keys(deploymentFixture.chains)) {
      const chainId = Number(chainIdText) as JBChainId
      const overrides = (
        deploymentFixture.overrides as Record<string, FixtureOverride>
      )[chainIdText]
      for (const [name, commonAddress] of Object.entries(
        deploymentFixture.deployments,
      )) {
        const expected = Object.hasOwn(overrides ?? {}, name)
          ? overrides[name]
          : commonAddress
        const actual = sdk[name]?.[chainId]?.toLowerCase() ?? null

        expect(actual, `${name} on chain ${chainId}`).toBe(expected)
        expect(addrOf(name, chainId)?.toLowerCase() ?? null).toBe(expected)
      }
    }
  })

  it('returns undefined instead of inventing an unknown deployment', () => {
    expect(addrOf('DefinitelyNotAContract', 1)).toBeUndefined()
  })
})

describe('canonical v6 sucker deployer pair surface', () => {
  const pairs =
    deploymentFixture.suckerDeployerPairs as unknown as SuckerPairFixture

  function fixtureMap(kind: 'ccip' | 'native') {
    return Object.fromEntries(
      Object.entries(pairs).map(([local, remotes]) => [
        local,
        Object.fromEntries(
          Object.entries(remotes)
            .filter(([, pair]) => pair[kind] !== null)
            .map(([remote, pair]) => [remote, pair[kind]!.address]),
        ),
      ]),
    )
  }

  function sdkMap(
    map: Partial<
      Record<JBChainId, Partial<Record<JBChainId, Address>>>
    >,
  ) {
    const normalized: Record<string, Record<string, string>> = {}
    for (const [local, remotes] of Object.entries(map)) {
      if (!remotes) continue
      normalized[local] = {}
      for (const [remote, address] of Object.entries(remotes)) {
        if (address) normalized[local][remote] = address.toLowerCase()
      }
    }
    return normalized
  }

  it('matches every independently pinned CCIP and native pair map', () => {
    expect(sdkMap(CCIP_SUCKER_DEPLOYER_ADDRESSES[6])).toEqual(
      fixtureMap('ccip'),
    )
    expect(sdkMap(NATIVE_SUCKER_DEPLOYER_ADDRESSES[6])).toEqual(
      fixtureMap('native'),
    )
  })

  it('parses each directed pair to the pinned deployers and exact mappings', () => {
    for (const [localText, remotes] of Object.entries(pairs)) {
      const local = Number(localText) as JBChainId
      for (const [remoteText, pair] of Object.entries(remotes)) {
        const remote = Number(remoteText) as JBChainId
        const nativeMapping = {
          localToken: NATIVE_TOKEN,
          minGas: 200_000,
          remoteToken: pad(NATIVE_TOKEN),
        }
        const ccipMappings = [
          nativeMapping,
          {
            localToken: USDC_ADDRESSES[local],
            minGas: 200_000,
            remoteToken: pad(USDC_ADDRESSES[remote]),
          },
        ]
        const ccip = parseSuckerDeployerConfig(
          local,
          [local, remote],
          [MappableAsset.NATIVE, MappableAsset.USDC],
          { version: 6, bridge: 'ccip' },
        )
        expect(
          ccip.deployerConfigurations,
          `CCIP parser ${local} -> ${remote}`,
        ).toEqual([
          {
            deployer: pair.ccip.address,
            peer: zeroHash,
            mappings: ccipMappings,
          },
        ])

        const both = parseSuckerDeployerConfig(
          local,
          [local, remote],
          [MappableAsset.NATIVE, MappableAsset.USDC],
          { version: 6, bridge: 'both' },
        )
        expect(
          both.deployerConfigurations,
          `redundant parser ${local} -> ${remote}`,
        ).toEqual([
          ...(pair.native
            ? [
                {
                  deployer: pair.native.address,
                  peer: zeroHash,
                  mappings: [nativeMapping],
                },
              ]
            : []),
          {
            deployer: pair.ccip.address,
            peer: zeroHash,
            mappings: ccipMappings,
          },
        ])
      }
    }
  })
})

describe('contract selectors pinned to the v6 source surface', () => {
  it.each([
    [jbMultiTerminalAbi, 'pay', '0xfef43257'],
    [jbMultiTerminalAbi, 'addToBalanceOf', '0x9e6eec05'],
    [jbMultiTerminalAbi, 'cashOutTokensOf', '0x13da8317'],
    [jbMultiTerminalAbi, 'sendPayoutsOf', '0xcfaf5839'],
    [jbMultiTerminalAbi, 'useAllowanceOf', '0x748e821c'],
    [jbControllerAbi, 'queueRulesetsOf', '0x3141db70'],
    [jbControllerAbi, 'setSplitGroupsOf', '0x8a36dffd'],
    [jbControllerAbi, 'claimTokensFor', '0x303f5dfa'],
    [jbControllerAbi, 'sendReservedTokensToSplitsOf', '0x090db2f1'],
    [jbControllerAbi, 'deployERC20For', '0x58178191'],
    [jb721TiersHookAbi, 'adjustTiers', '0x437aa91a'],
    [jbPermissionsAbi, 'setPermissionsFor', '0x449f24a4'],
  ] as const)('%s.%s remains %s', (abi, name, selector) => {
    expect(toFunctionSelector(functionOf(abi as Abi, name))).toBe(selector)
  })

  it('keeps payout currency uint256 and the canonical JBSplit tuple order', () => {
    const payouts = functionOf(jbMultiTerminalAbi, 'sendPayoutsOf')
    expect(payouts.inputs.find(input => input.name === 'currency')?.type).toBe(
      'uint256',
    )

    const queue = functionOf(jbControllerAbi, 'queueRulesetsOf')
    const configurations = queue.inputs.find(
      input => input.name === 'rulesetConfigurations',
    ) as { components?: readonly { name?: string; components?: readonly unknown[] }[] }
    const splitGroups = configurations.components?.find(
      component => component.name === 'splitGroups',
    ) as { components?: readonly { name?: string; components?: readonly { name?: string }[] }[] }
    const splits = splitGroups.components?.find(
      component => component.name === 'splits',
    )

    expect(splits?.components?.map(component => component.name)).toEqual([
      'percent',
      'projectId',
      'beneficiary',
      'preferAddToBalance',
      'lockedUntil',
      'hook',
    ])
  })
})
