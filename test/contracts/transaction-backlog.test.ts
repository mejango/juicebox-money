import {
  JBCoreContracts,
  NATIVE_TOKEN,
  RevnetCoreContracts,
  jbControllerAbi,
  jbContractAddress,
  jbDirectoryAbi,
  jbMultiTerminalAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  JB_PROJECT_PAYER_DEPLOYER,
  UNISWAP_PERMIT2_ADDRESS,
  build721CashOutMetadata,
  buildAccountingContext,
  buildAutoIssueTx,
  buildBridgeClaimTx,
  buildBridgePrepareTx,
  buildCashOutTx,
  buildClaimTokensTx,
  buildDeployProjectPayerTx,
  buildSyncAccountingDataTx,
  buildToRemoteTx,
  type JBClaim,
} from '@bananapus/nana-sdk-core/v6'
import {
  decodeFunctionData,
  encodeFunctionData,
  pad,
  toHex,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { describe, expect, it } from 'vitest'
import { POWERS, type PowerFlag, type ResolvedValues } from '@/lib/projectPowers'
import {
  buildBuybackHookAuthorityCall,
  buildInitializeBuybackPoolAuthorityCall,
  buildModifyLiquiditiesRequest,
  buildPermit2ApproveRequest,
  buildProjectOwnershipAuthorityCall,
  buildProjectPowerAuthorityCall,
  buildRevnetOperatorAuthorityCall,
  buildRouterTerminalAuthorityCall,
  buildSendReservedTokensRequest,
  buildTokenMetadataAuthorityCall,
} from '@/lib/transaction-builders'

const CHAIN_ID = 1 satisfies JBChainId
const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const TOKEN = '0x3333333333333333333333333333333333333333' as Address
const TERMINAL = '0x4444444444444444444444444444444444444444' as Address
const HOOK = '0x5555555555555555555555555555555555555555' as Address
const CONTROLLER = '0x6666666666666666666666666666666666666666' as Address
const AUTHORITY = '0x7777777777777777777777777777777777777777' as Address
const REGISTRY = '0x8888888888888888888888888888888888888888' as Address
const SUCKER = '0x9999999999999999999999999999999999999999' as Address

type EncodableRequest = {
  abi: Abi
  functionName: string
  args: readonly unknown[]
}

function encode(request: EncodableRequest): Hex {
  return encodeFunctionData(request)
}

describe('remaining local transaction builders', () => {
  it('pins reserved-token distribution to the verified controller and project', () => {
    const request = buildSendReservedTokensRequest({
      chainId: CHAIN_ID,
      controller: CONTROLLER,
      projectId: 41n,
    })
    const data = encode(request)

    expect(request).toMatchObject({
      chainId: CHAIN_ID,
      address: CONTROLLER,
      functionName: 'sendReservedTokensToSplitsOf',
      args: [41n],
    })
    expect(data.slice(0, 10)).toBe('0x090db2f1')
    expect(decodeFunctionData({ abi: request.abi, data })).toEqual({
      functionName: 'sendReservedTokensToSplitsOf',
      args: [41n],
    })
  })

  it('pins token renaming to its authority, controller, name, and symbol', () => {
    const call = buildTokenMetadataAuthorityCall({
      chainId: CHAIN_ID,
      authority: AUTHORITY,
      controller: CONTROLLER,
      projectId: 42n,
      name: 'Juice Token',
      symbol: 'JUICE',
    })

    expect(call).toMatchObject({
      chainId: CHAIN_ID,
      authority: AUTHORITY,
      target: CONTROLLER,
      functionName: 'setTokenMetadataOf',
      args: [42n, 'Juice Token', 'JUICE'],
      contractName: 'JBController',
      gas: 200_000n,
      label: 'Set token metadata',
    })
    expect(call.data.slice(0, 10)).toBe('0xfac3a6a2')
    expect(decodeFunctionData({ abi: call.abi!, data: call.data })).toEqual({
      functionName: 'setTokenMetadataOf',
      args: [42n, 'Juice Token', 'JUICE'],
    })
  })

  it('pins project ownership and revnet operator transfers to canonical targets', () => {
    const ownership = buildProjectOwnershipAuthorityCall({
      chainId: CHAIN_ID,
      authority: AUTHORITY,
      projectId: 43n,
      destination: BOB,
    })
    const operator = buildRevnetOperatorAuthorityCall({
      chainId: CHAIN_ID,
      authority: AUTHORITY,
      revnetId: 44n,
      operator: BOB,
    })

    expect(ownership).toMatchObject({
      chainId: CHAIN_ID,
      authority: AUTHORITY,
      target: jbContractAddress['6'][JBCoreContracts.JBProjects][CHAIN_ID],
      functionName: 'transferFrom',
      args: [AUTHORITY, BOB, 43n],
      contractName: 'JBProjects',
    })
    expect(ownership.data.slice(0, 10)).toBe('0x23b872dd')
    expect(
      decodeFunctionData({ abi: ownership.abi!, data: ownership.data }),
    ).toEqual({
      functionName: 'transferFrom',
      args: [AUTHORITY, BOB, 43n],
    })

    expect(operator).toMatchObject({
      chainId: CHAIN_ID,
      authority: AUTHORITY,
      target:
        jbContractAddress['6'][RevnetCoreContracts.REVOwner][CHAIN_ID],
      functionName: 'setOperatorOf',
      args: [44n, BOB],
      contractName: 'REVOwner',
    })
    expect(operator.data.slice(0, 10)).toBe('0x62982730')
    expect(
      decodeFunctionData({ abi: operator.abi!, data: operator.data }),
    ).toEqual({
      functionName: 'setOperatorOf',
      args: [44n, BOB],
    })
  })

  it('round-trips every active ruleset-gated owner power, including minting', () => {
    const directory = jbContractAddress['6'][JBCoreContracts.JBDirectory][
      CHAIN_ID
    ] as Address
    const terminal = jbContractAddress['6'][JBCoreContracts.JBMultiTerminal][
      CHAIN_ID
    ] as Address
    const fixtures: Record<
      PowerFlag,
      { values: ResolvedValues; args: readonly unknown[]; selector: Hex }
    > = {
      allowOwnerMinting: {
        values: {
          tokenCount: 12n * 10n ** 18n,
          beneficiary: ALICE,
          useReservedPercent: true,
        },
        args: [45n, 12n * 10n ** 18n, ALICE, '', true],
        selector: '0xc7fb92de',
      },
      allowAddPriceFeed: {
        values: { pricingCurrency: 2n, unitCurrency: 1n, feed: HOOK },
        args: [45n, 2n, 1n, HOOK],
        selector: '0xc6081d71',
      },
      allowSetTerminals: {
        values: { terminal: TERMINAL },
        args: [45n, [TERMINAL]],
        selector: '0x821b9fd8',
      },
      allowSetController: {
        values: { controller: CONTROLLER },
        args: [45n, CONTROLLER],
        selector: '0x714e7f32',
      },
      allowTerminalMigration: {
        values: { token: NATIVE_TOKEN, to: TERMINAL },
        args: [45n, NATIVE_TOKEN, TERMINAL],
        selector: '0xe28b5411',
      },
      allowSetCustomToken: {
        values: { token: TOKEN },
        args: [45n, TOKEN],
        selector: '0xf12b64a5',
      },
      allowAddAccountingContext: {
        values: { token: TOKEN, decimals: 6 },
        args: [45n, [buildAccountingContext(TOKEN, 6)]],
        selector: '0x253721c8',
      },
    }

    for (const power of POWERS) {
      const fixture = fixtures[power.flag]
      const abi =
        power.target === 'controller'
          ? jbControllerAbi
          : power.target === 'directory'
            ? jbDirectoryAbi
            : jbMultiTerminalAbi
      const target =
        power.target === 'controller'
          ? CONTROLLER
          : power.target === 'directory'
            ? directory
            : terminal
      const contractName =
        power.target === 'controller'
          ? 'JBController'
          : power.target === 'directory'
            ? 'JBDirectory'
            : 'JBMultiTerminal'
      const args = power.buildArgs(45n, fixture.values)
      const call = buildProjectPowerAuthorityCall({
        chainId: CHAIN_ID,
        authority: AUTHORITY,
        target,
        abi,
        functionName: power.functionName,
        args,
        contractName,
        gas: power.flag === 'allowAddAccountingContext' ? 300_000n : 500_000n,
        label: power.actionLabel,
      })

      expect(args, power.flag).toEqual(fixture.args)
      expect(call, power.flag).toMatchObject({
        chainId: CHAIN_ID,
        authority: AUTHORITY,
        target,
        functionName: power.functionName,
        args: fixture.args,
        contractName,
        gas: power.flag === 'allowAddAccountingContext' ? 300_000n : 500_000n,
        label: power.actionLabel,
      })
      expect(call.data.slice(0, 10), power.flag).toBe(fixture.selector)
      expect(
        decodeFunctionData({ abi: call.abi!, data: call.data }),
        power.flag,
      ).toEqual({ functionName: power.functionName, args: fixture.args })
    }
  })

  it('pins every buyback/router action and the complete pool tuple', () => {
    const hook = buildBuybackHookAuthorityCall({
      chainId: CHAIN_ID,
      authority: AUTHORITY,
      registry: REGISTRY,
      projectId: 46n,
      hook: HOOK,
    })
    const router = buildRouterTerminalAuthorityCall({
      chainId: CHAIN_ID,
      authority: AUTHORITY,
      registry: REGISTRY,
      projectId: 46n,
      terminal: TERMINAL,
    })
    const pool = buildInitializeBuybackPoolAuthorityCall({
      chainId: CHAIN_ID,
      authority: AUTHORITY,
      registry: REGISTRY,
      projectId: 46n,
      fee: 3000,
      tickSpacing: 60,
      twapWindow: 1800n,
      pairToken: TOKEN,
      sqrtPriceX96: 79_228_162_514_264_337_593_543_950_336n,
    })

    expect(hook).toMatchObject({
      target: REGISTRY,
      authority: AUTHORITY,
      functionName: 'setHookFor',
      args: [46n, HOOK],
      gas: 200_000n,
    })
    expect(hook.data.slice(0, 10)).toBe('0x779b0290')
    expect(decodeFunctionData({ abi: hook.abi!, data: hook.data })).toEqual({
      functionName: 'setHookFor',
      args: [46n, HOOK],
    })

    expect(router).toMatchObject({
      target: REGISTRY,
      authority: AUTHORITY,
      functionName: 'setTerminalFor',
      args: [46n, TERMINAL],
      gas: 200_000n,
    })
    expect(router.data.slice(0, 10)).toBe('0xf3e37d01')
    expect(
      decodeFunctionData({ abi: router.abi!, data: router.data }),
    ).toEqual({ functionName: 'setTerminalFor', args: [46n, TERMINAL] })

    expect(pool).toMatchObject({
      target: REGISTRY,
      authority: AUTHORITY,
      functionName: 'initializePoolFor',
      args: [
        46n,
        3000,
        60,
        1800n,
        TOKEN,
        79_228_162_514_264_337_593_543_950_336n,
      ],
      gas: 500_000n,
    })
    expect(pool.data.slice(0, 10)).toBe('0x49e30383')
    expect(decodeFunctionData({ abi: pool.abi!, data: pool.data })).toEqual({
      functionName: 'initializePoolFor',
      args: [
        46n,
        3000,
        60,
        1800n,
        TOKEN,
        79_228_162_514_264_337_593_543_950_336n,
      ],
    })
  })

  it('pins Permit2 approval and final PositionManager bytes, deadline, and value', () => {
    const permit = buildPermit2ApproveRequest({
      chainId: CHAIN_ID,
      token: TOKEN,
      positionManager: TERMINAL,
      amount: (1n << 160n) - 1n,
      expiration: 1_800_000_000,
    })
    const mint = buildModifyLiquiditiesRequest({
      chainId: CHAIN_ID,
      positionManager: TERMINAL,
      unlockData: '0x1234abcd',
      deadline: 1_800_001_200n,
      value: 77_000n,
    })

    expect(permit).toMatchObject({
      chainId: CHAIN_ID,
      address: UNISWAP_PERMIT2_ADDRESS,
      functionName: 'approve',
      args: [TOKEN, TERMINAL, (1n << 160n) - 1n, 1_800_000_000],
    })
    const permitData = encode(permit)
    expect(permitData.slice(0, 10)).toBe('0x87517c45')
    expect(decodeFunctionData({ abi: permit.abi, data: permitData })).toEqual({
      functionName: 'approve',
      args: [TOKEN, TERMINAL, (1n << 160n) - 1n, 1_800_000_000],
    })

    expect(mint).toMatchObject({
      chainId: CHAIN_ID,
      address: TERMINAL,
      functionName: 'modifyLiquidities',
      args: ['0x1234abcd', 1_800_001_200n],
      value: 77_000n,
    })
    const mintData = encode(mint)
    expect(mintData.slice(0, 10)).toBe('0xdd46508f')
    expect(decodeFunctionData({ abi: mint.abi, data: mintData })).toEqual({
      functionName: 'modifyLiquidities',
      args: ['0x1234abcd', 1_800_001_200n],
    })
  })
})

describe('remaining canonical SDK transaction builders', () => {
  it('pins project-payer deployment to its project, behavior, beneficiary, memo, and owner', () => {
    const request = buildDeployProjectPayerTx({
      chainId: CHAIN_ID,
      projectId: 50n,
      beneficiary: ALICE,
      memo: 'from the component review',
      addToBalance: true,
      owner: BOB,
    })
    const data = encode(request)

    expect(request).toMatchObject({
      chainId: CHAIN_ID,
      address: JB_PROJECT_PAYER_DEPLOYER,
      functionName: 'deployProjectPayer',
      args: [50n, ALICE, 'from the component review', '0x', true, BOB],
    })
    expect(decodeFunctionData({ abi: request.abi, data })).toEqual({
      functionName: 'deployProjectPayer',
      args: [50n, ALICE, 'from the component review', '0x', true, BOB],
    })
  })

  it('pins claim-credits calldata to holder, beneficiary, count, and controller', () => {
    const request = buildClaimTokensTx({
      chainId: CHAIN_ID,
      holder: ALICE,
      projectId: 51n,
      tokenCount: 8n * 10n ** 18n,
      beneficiary: BOB,
    })
    const data = encode(request)

    expect(request).toMatchObject({
      chainId: CHAIN_ID,
      address: jbContractAddress['6'][JBCoreContracts.JBController][CHAIN_ID],
      functionName: 'claimTokensFor',
      args: [ALICE, 51n, 8n * 10n ** 18n, BOB],
    })
    expect(data.slice(0, 10)).toBe('0x303f5dfa')
    expect(decodeFunctionData({ abi: request.abi, data })).toEqual({
      functionName: 'claimTokensFor',
      args: [ALICE, 51n, 8n * 10n ** 18n, BOB],
    })
  })

  it('freezes NFT ids in canonical metadata and cashes out zero fungible tokens', () => {
    const metadata = build721CashOutMetadata({
      metadataIdTarget: HOOK,
      tokenIds: [1001n, 2002n],
    })
    const expectedMetadata =
      '0x0000000000000000000000000000000000000000000000000000000000000000d3e41aa1020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000003e900000000000000000000000000000000000000000000000000000000000007d2'
    const request = buildCashOutTx({
      chainId: CHAIN_ID,
      terminal: TERMINAL,
      holder: ALICE,
      projectId: 52n,
      cashOutCount: 0n,
      tokenToReclaim: TOKEN,
      minTokensReclaimed: 97_500n,
      beneficiary: ALICE,
      metadata,
    })
    const data = encode(request)

    expect(metadata).toBe(expectedMetadata)
    expect(request).toMatchObject({
      chainId: CHAIN_ID,
      address: TERMINAL,
      functionName: 'cashOutTokensOf',
      args: [ALICE, 52n, 0n, TOKEN, 97_500n, ALICE, expectedMetadata],
    })
    expect(data.slice(0, 10)).toBe('0x13da8317')
    expect(decodeFunctionData({ abi: request.abi, data })).toEqual({
      functionName: 'cashOutTokensOf',
      args: [ALICE, 52n, 0n, TOKEN, 97_500n, ALICE, expectedMetadata],
    })
  })

  it('pins auto-issuance to the revnet, stage, beneficiary, and REVOwner', () => {
    const request = buildAutoIssueTx({
      chainId: CHAIN_ID,
      revnetId: 53n,
      stageId: 4n,
      beneficiary: ALICE,
    })
    const data = encode(request)

    expect(request).toMatchObject({
      chainId: CHAIN_ID,
      address:
        jbContractAddress['6'][RevnetCoreContracts.REVOwner][CHAIN_ID],
      functionName: 'autoIssueFor',
      args: [53n, 4n, ALICE],
    })
    expect(data.slice(0, 10)).toBe('0xb987005d')
    expect(decodeFunctionData({ abi: request.abi, data })).toEqual({
      functionName: 'autoIssueFor',
      args: [53n, 4n, ALICE],
    })
  })

  it('pins bridge prepare, transport fee, and accounting sync requests', () => {
    const beneficiary = pad(ALICE.toLowerCase() as Address, { size: 32 })
    const prepare = buildBridgePrepareTx({
      chainId: CHAIN_ID,
      sucker: SUCKER,
      projectTokenCount: 9n * 10n ** 18n,
      beneficiary: ALICE,
      minTokensReclaimed: 123_000n,
      token: TOKEN,
      metadata: toHex(77n, { size: 32 }),
    })
    const remote = buildToRemoteTx({
      chainId: CHAIN_ID,
      sucker: SUCKER,
      token: TOKEN,
      value: 88_000n,
    })
    const sync = buildSyncAccountingDataTx({
      chainId: CHAIN_ID,
      sucker: SUCKER,
      value: 99_000n,
    })

    const prepareData = encode(prepare)
    expect(prepare).toMatchObject({
      chainId: CHAIN_ID,
      address: SUCKER,
      functionName: 'prepare',
      args: [
        9n * 10n ** 18n,
        beneficiary,
        123_000n,
        TOKEN,
        toHex(77n, { size: 32 }),
      ],
    })
    expect(prepareData.slice(0, 10)).toBe('0xaf629bbb')
    expect(decodeFunctionData({ abi: prepare.abi, data: prepareData })).toEqual({
      functionName: 'prepare',
      args: [
        9n * 10n ** 18n,
        beneficiary,
        123_000n,
        TOKEN,
        toHex(77n, { size: 32 }),
      ],
    })

    const remoteData = encode(remote)
    expect(remote).toMatchObject({
      chainId: CHAIN_ID,
      address: SUCKER,
      functionName: 'toRemote',
      args: [TOKEN],
      value: 88_000n,
    })
    expect(remoteData.slice(0, 10)).toBe('0xb71c1179')
    expect(decodeFunctionData({ abi: remote.abi, data: remoteData })).toEqual({
      functionName: 'toRemote',
      args: [TOKEN],
    })

    const syncData = encode(sync)
    expect(sync).toMatchObject({
      chainId: CHAIN_ID,
      address: SUCKER,
      functionName: 'syncAccountingData',
      args: [],
      value: 99_000n,
    })
    expect(syncData.slice(0, 10)).toBe('0xc1ca1ec7')
    expect(decodeFunctionData({ abi: sync.abi, data: syncData })).toEqual({
      functionName: 'syncAccountingData',
      args: undefined,
    })
  })

  it('pins the full bridge claim leaf and all 32 proof siblings', () => {
    const proof = Array.from({ length: 32 }, (_, index) =>
      toHex(BigInt(index + 1), { size: 32 }),
    ) as unknown as JBClaim['proof']
    const claim: JBClaim = {
      token: TOKEN,
      leaf: {
        index: 7n,
        beneficiary: pad(BOB, { size: 32 }),
        projectTokenCount: 11n * 10n ** 18n,
        terminalTokenAmount: 456_000n,
        metadata: zeroHash,
      },
      proof,
    }
    const request = buildBridgeClaimTx({
      chainId: CHAIN_ID,
      sucker: SUCKER,
      claim,
    })
    const data = encode(request)

    expect(request).toMatchObject({
      chainId: CHAIN_ID,
      address: SUCKER,
      functionName: 'claim',
      args: [claim],
    })
    expect(data.slice(0, 10)).toBe('0xcbb2adce')
    expect(decodeFunctionData({ abi: request.abi, data })).toEqual({
      functionName: 'claim',
      args: [claim],
    })
  })
})
