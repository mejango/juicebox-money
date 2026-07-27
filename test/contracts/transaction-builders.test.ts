import {
  JBCoreContracts,
  NATIVE_TOKEN,
  jbContractAddress,
  type JBChainId,
} from "@bananapus/nana-sdk-core";
import {
  EMPTY_SINGLE_ALLOWANCE,
  buildBorrowTx,
  buildPayTx,
  buildPermit2ApproveTx,
  buildRepayLoanTx,
  buildRulesetConfiguration,
  buildSetPermissionsTx,
  buildUniswapV4ExactInputSwapTx,
} from "@bananapus/nana-sdk-core/v6";
import {
  decodeFunctionData,
  encodeFunctionData,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  buildAddToBalanceRequest,
  buildAdjustTiersRequest,
  buildErc20ApproveRequest,
  buildPermissionsAuthorityCall,
  buildQueueRulesetsRequest,
  buildSendPayoutsRequest,
  buildSplitGroupsAuthorityCall,
  buildUseAllowanceRequest,
} from "@/lib/transaction-builders";

const CHAIN_ID = 1 satisfies JBChainId;
const ALICE = "0x1111111111111111111111111111111111111111" as Address;
const BOB = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN = "0x3333333333333333333333333333333333333333" as Address;
const TERMINAL = "0x4444444444444444444444444444444444444444" as Address;
const HOOK = "0x5555555555555555555555555555555555555555" as Address;
const CONTROLLER = "0x6666666666666666666666666666666666666666" as Address;
const AUTHORITY = "0x7777777777777777777777777777777777777777" as Address;
const IPFS_URI = `0x${"ab".repeat(32)}` as Hex;

type EncodableRequest = {
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
};

function encode(request: EncodableRequest): Hex {
  return encodeFunctionData(request);
}

describe("local transaction builders", () => {
  it("pins an ERC-20 approval to the exact spender and amount", () => {
    const request = buildErc20ApproveRequest({
      chainId: CHAIN_ID,
      token: TOKEN,
      spender: TERMINAL,
      amount: 123_456n,
    });
    const data = encode(request);
    const decoded = decodeFunctionData({ abi: request.abi, data });

    expect(request).toMatchObject({
      chainId: CHAIN_ID,
      address: TOKEN,
      functionName: "approve",
      args: [TERMINAL, 123_456n],
    });
    expect(request).not.toHaveProperty("value");
    expect(data.slice(0, 10)).toBe("0x095ea7b3");
    expect(decoded).toEqual({
      functionName: "approve",
      args: [TERMINAL, 123_456n],
    });
  });

  it("pins Permit2 authorization and the direct project-token swap payload", () => {
    const expiration = 1_800_000_000;
    const permit = buildPermit2ApproveTx({
      chainId: CHAIN_ID,
      token: TOKEN,
      amount: 123_456n,
      expiration,
    });
    const permitData = encode(permit);
    const decodedPermit = decodeFunctionData({
      abi: permit.abi,
      data: permitData,
    });

    expect(permit.functionName).toBe("approve");
    expect(permit.args).toEqual([
      TOKEN,
      expect.any(String),
      123_456n,
      expiration,
    ]);
    expect(decodedPermit.functionName).toBe("approve");
    expect(decodedPermit.args[0]).toBe(TOKEN);
    expect(decodedPermit.args[1].toLowerCase()).toBe(
      String(permit.args[1]).toLowerCase(),
    );
    expect(decodedPermit.args.slice(2)).toEqual(permit.args.slice(2));

    const swap = buildUniswapV4ExactInputSwapTx({
      chainId: CHAIN_ID,
      poolKey: {
        currency0: TOKEN,
        currency1: CONTROLLER,
        fee: 10_000,
        tickSpacing: 200,
        hooks: HOOK,
      },
      zeroForOne: true,
      amountIn: 123_456n,
      minimumAmountOut: 654_321n,
      recipient: ALICE,
      deadline: 1_800_000_900n,
    });
    const swapData = encode(swap);
    const decodedSwap = decodeFunctionData({ abi: swap.abi, data: swapData });

    expect(swap).toMatchObject({
      chainId: CHAIN_ID,
      functionName: "execute",
      args: ["0x10", [expect.any(String)], 1_800_000_900n],
      value: 0n,
    });
    expect(decodedSwap).toEqual({
      functionName: "execute",
      args: swap.args,
    });
  });

  it("sets native top-up calldata and msg.value without changing either amount", () => {
    const request = buildAddToBalanceRequest({
      chainId: CHAIN_ID,
      terminal: TERMINAL,
      projectId: 17n,
      token: NATIVE_TOKEN,
      amount: 42_000n,
      memo: "keep building",
      metadata: "0x1234",
    });
    const data = encode(request);

    expect(request.address).toBe(TERMINAL);
    expect(request.args).toEqual([
      17n,
      NATIVE_TOKEN,
      42_000n,
      false,
      "keep building",
      "0x1234",
    ]);
    expect(request.value).toBe(42_000n);
    expect(data.slice(0, 10)).toBe("0x9e6eec05");
    expect(decodeFunctionData({ abi: request.abi, data })).toEqual({
      functionName: "addToBalanceOf",
      args: [17n, NATIVE_TOKEN, 42_000n, false, "keep building", "0x1234"],
    });
  });

  it("never attaches native value to an ERC-20 top-up and preserves safe defaults", () => {
    const request = buildAddToBalanceRequest({
      chainId: CHAIN_ID,
      terminal: TERMINAL,
      projectId: 18n,
      token: TOKEN,
      amount: 99n,
    });

    expect(request.args).toEqual([18n, TOKEN, 99n, false, "", "0x"]);
    expect(request.value).toBeUndefined();
    expect(encode(request).slice(0, 10)).toBe("0x9e6eec05");
  });

  it("round-trips every live tier field and the explicit removal ids", () => {
    const tiers = [
      {
        price: 1_000n,
        initialSupply: 5,
        votingUnits: 2,
        reserveFrequency: 3,
        reserveBeneficiary: BOB,
        encodedIpfsUri: IPFS_URI,
        category: 7,
        discountPercent: 4,
        flags: {
          allowOwnerMint: true,
          useReserveBeneficiaryAsDefault: true,
          transfersPausable: false,
          useVotingUnits: true,
          cantBeRemoved: true,
          cantIncreaseDiscountPercent: false,
          cantBuyWithCredits: false,
        },
        splitPercent: 500_000_000,
        splits: [
          {
            percent: 500_000_000,
            projectId: 9n,
            beneficiary: ALICE,
            preferAddToBalance: true,
            lockedUntil: 1_800_000_000,
            hook: HOOK,
          },
        ],
      },
    ] as const;
    const request = buildAdjustTiersRequest({
      chainId: CHAIN_ID,
      hook: HOOK,
      tiers,
      tierIdsToRemove: [3n, 9n],
    });
    const data = encode(request);

    expect(request).toMatchObject({
      chainId: CHAIN_ID,
      address: HOOK,
      functionName: "adjustTiers",
    });
    expect(request.args).toEqual([tiers, [3n, 9n]]);
    expect(data.slice(0, 10)).toBe("0x437aa91a");
    expect(decodeFunctionData({ abi: request.abi, data })).toEqual({
      functionName: "adjustTiers",
      args: [tiers, [3n, 9n]],
    });
  });

  it("pins payout execution to the reviewed amount, currency, and slippage floor", () => {
    const request = buildSendPayoutsRequest({
      chainId: CHAIN_ID,
      terminal: TERMINAL,
      projectId: 21n,
      token: TOKEN,
      amount: 55_000n,
      currency: 2n,
      minTokensPaidOut: 54_000n,
    });
    const data = encode(request);

    expect(request.args).toEqual([21n, TOKEN, 55_000n, 2n, 54_000n]);
    expect(data.slice(0, 10)).toBe("0xcfaf5839");
    expect(decodeFunctionData({ abi: request.abi, data })).toEqual({
      functionName: "sendPayoutsOf",
      args: [21n, TOKEN, 55_000n, 2n, 54_000n],
    });
  });

  it("pins allowance use to both beneficiaries, its memo, and slippage floor", () => {
    const request = buildUseAllowanceRequest({
      chainId: CHAIN_ID,
      terminal: TERMINAL,
      projectId: 22n,
      token: TOKEN,
      amount: 77_000n,
      currency: 2n,
      minTokensPaidOut: 76_000n,
      beneficiary: ALICE,
      feeBeneficiary: BOB,
      memo: "operations",
    });
    const data = encode(request);

    expect(request.args).toEqual([
      22n,
      TOKEN,
      77_000n,
      2n,
      76_000n,
      ALICE,
      BOB,
      "operations",
    ]);
    expect(data.slice(0, 10)).toBe("0x748e821c");
    expect(decodeFunctionData({ abi: request.abi, data })).toEqual({
      functionName: "useAllowanceOf",
      args: [22n, TOKEN, 77_000n, 2n, 76_000n, ALICE, BOB, "operations"],
    });
  });

  it("keeps the SDK queue payload exact while overriding only the verified controller", () => {
    const configuration = buildRulesetConfiguration({
      mustStartAtOrAfter: 1_800_000_000,
      duration: 604_800,
      weight: 1_000n * 10n ** 18n,
      weightCutPercent: 25_000_000,
      approvalHook: HOOK,
    });
    const request = buildQueueRulesetsRequest({
      chainId: CHAIN_ID,
      controller: CONTROLLER,
      projectId: 23n,
      rulesetConfigurations: [configuration],
      memo: "next cycle",
    });
    const data = encode(request);

    expect(request.address).toBe(CONTROLLER);
    expect(request.args).toEqual([23n, [configuration], "next cycle"]);
    expect(data.slice(0, 10)).toBe("0x3141db70");
    expect(decodeFunctionData({ abi: request.abi, data })).toEqual({
      functionName: "queueRulesetsOf",
      args: [23n, [configuration], "next cycle"],
    });
  });

  it("wraps the exact SDK split calldata for authority routing", () => {
    const splitGroups = [
      {
        groupId: BigInt(TOKEN),
        splits: [
          {
            percent: 1_000_000_000,
            projectId: 0n,
            beneficiary: ALICE,
            preferAddToBalance: false,
            lockedUntil: 0,
            hook: zeroAddress,
          },
        ],
      },
    ] as const;
    const call = buildSplitGroupsAuthorityCall({
      chainId: CHAIN_ID,
      authority: AUTHORITY,
      controller: CONTROLLER,
      projectId: 24n,
      rulesetId: 1_800_000_100n,
      splitGroups,
      gas: 654_321n,
      label: "Edit ETH payouts",
    });

    expect(call).toMatchObject({
      chainId: CHAIN_ID,
      authority: AUTHORITY,
      target: CONTROLLER,
      functionName: "setSplitGroupsOf",
      contractName: "JBController",
      gas: 654_321n,
      label: "Edit ETH payouts",
      args: [24n, 1_800_000_100n, splitGroups],
    });
    expect(call.data.slice(0, 10)).toBe("0x8a36dffd");
    expect(decodeFunctionData({ abi: call.abi!, data: call.data })).toEqual({
      functionName: "setSplitGroupsOf",
      args: [24n, 1_800_000_100n, splitGroups],
    });
  });

  it("wraps the exact SDK permission calldata for authority routing", () => {
    const call = buildPermissionsAuthorityCall({
      chainId: CHAIN_ID,
      authority: AUTHORITY,
      account: AUTHORITY,
      operator: BOB,
      projectId: 25n,
      permissionIds: [1, 4, 14],
      gas: 222_000n,
      label: "Edit permissions",
    });

    expect(call).toMatchObject({
      chainId: CHAIN_ID,
      authority: AUTHORITY,
      target: jbContractAddress["6"][JBCoreContracts.JBPermissions][CHAIN_ID],
      functionName: "setPermissionsFor",
      contractName: "JBPermissions",
      gas: 222_000n,
      label: "Edit permissions",
      args: [
        AUTHORITY,
        { operator: BOB, projectId: 25n, permissionIds: [1, 4, 14] },
      ],
    });
    expect(call.data.slice(0, 10)).toBe("0x449f24a4");
    expect(decodeFunctionData({ abi: call.abi!, data: call.data })).toEqual({
      functionName: "setPermissionsFor",
      args: [
        AUTHORITY,
        { operator: BOB, projectId: 25n, permissionIds: [1, 4, 14] },
      ],
    });
  });

  it("pins production defaults, including an empty permission replacement", () => {
    const tiers = buildAdjustTiersRequest({
      chainId: CHAIN_ID,
      hook: HOOK,
      tiers: [],
    });
    const allowance = buildUseAllowanceRequest({
      chainId: CHAIN_ID,
      terminal: TERMINAL,
      projectId: 26n,
      token: TOKEN,
      amount: 100n,
      currency: 2n,
      minTokensPaidOut: 99n,
      beneficiary: ALICE,
    });
    const splits = buildSplitGroupsAuthorityCall({
      chainId: CHAIN_ID,
      authority: AUTHORITY,
      controller: CONTROLLER,
      projectId: 26n,
      rulesetId: 27n,
      splitGroups: [],
      label: "Clear splits",
    });
    const permissions = buildPermissionsAuthorityCall({
      chainId: CHAIN_ID,
      authority: AUTHORITY,
      account: AUTHORITY,
      operator: BOB,
      projectId: 26n,
      permissionIds: [],
      label: "Revoke permissions",
    });

    expect(tiers.args).toEqual([[], []]);
    expect(allowance.args).toEqual([
      26n,
      TOKEN,
      100n,
      2n,
      99n,
      ALICE,
      ALICE,
      "",
    ]);
    expect(splits.gas).toBe(600_000n);
    expect(permissions.gas).toBe(200_000n);
    expect(permissions.args).toEqual([
      AUTHORITY,
      { operator: BOB, projectId: 26n, permissionIds: [] },
    ]);
    expect(permissions.data.slice(0, 10)).toBe("0x449f24a4");
  });
});

describe("SDK transaction builders used by wallet flows", () => {
  it.each([
    {
      label: "native",
      token: NATIVE_TOKEN,
      value: 88_000n,
    },
    {
      label: "ERC-20",
      token: TOKEN,
      value: 0n,
    },
  ])("pins $label pay calldata and msg.value", ({ token, value }) => {
    const request = buildPayTx({
      chainId: CHAIN_ID,
      terminal: TERMINAL,
      projectId: 31n,
      token,
      amount: 88_000n,
      beneficiary: ALICE,
      minReturnedTokens: 77_000n,
      memo: "hello",
      metadata: "0x1234",
    });
    const data = encode(request);

    expect(request.address).toBe(TERMINAL);
    expect(request.args).toEqual([
      31n,
      token,
      88_000n,
      ALICE,
      77_000n,
      "hello",
      "0x1234",
    ]);
    expect(request.value).toBe(value);
    expect(data.slice(0, 10)).toBe("0xfef43257");
    expect(decodeFunctionData({ abi: request.abi, data })).toEqual({
      functionName: "pay",
      args: [31n, token, 88_000n, ALICE, 77_000n, "hello", "0x1234"],
    });
  });

  it("pins borrow calldata to the revnet, floor, collateral, fee, and holder", () => {
    const request = buildBorrowTx({
      chainId: CHAIN_ID,
      revnetId: 32n,
      token: TOKEN,
      minBorrowAmount: 90_000n,
      collateralCount: 10n * 10n ** 18n,
      beneficiary: ALICE,
      prepaidFeePercent: 25n,
      holder: BOB,
    });
    const data = encode(request);

    expect(request.address).toBe(jbContractAddress["6"].REVLoans[CHAIN_ID]);
    expect(request.args).toEqual([
      32n,
      TOKEN,
      90_000n,
      10n * 10n ** 18n,
      ALICE,
      25n,
      BOB,
    ]);
    expect(request).not.toHaveProperty("value");
    expect(data.slice(0, 10)).toBe("0xa0d586b6");
    expect(decodeFunctionData({ abi: request.abi, data })).toEqual({
      functionName: "borrowFrom",
      args: [32n, TOKEN, 90_000n, 10n * 10n ** 18n, ALICE, 25n, BOB],
    });
  });

  it("pins repayment calldata, the empty Permit2 allowance, and native value", () => {
    const request = buildRepayLoanTx({
      chainId: CHAIN_ID,
      loanId: 33n,
      maxRepayBorrowAmount: 101_000n,
      collateralCountToReturn: 4n * 10n ** 18n,
      beneficiary: ALICE,
      value: 101_000n,
    });
    const data = encode(request);

    expect(request.address).toBe(jbContractAddress["6"].REVLoans[CHAIN_ID]);
    expect(request.args).toEqual([
      33n,
      101_000n,
      4n * 10n ** 18n,
      ALICE,
      EMPTY_SINGLE_ALLOWANCE,
    ]);
    expect(request.value).toBe(101_000n);
    expect(data.slice(0, 10)).toBe("0x09c58621");
    expect(decodeFunctionData({ abi: request.abi, data })).toEqual({
      functionName: "repayLoan",
      args: [33n, 101_000n, 4n * 10n ** 18n, ALICE, EMPTY_SINGLE_ALLOWANCE],
    });
  });

  it("pins direct permission replacement to its account and complete id set", () => {
    const request = buildSetPermissionsTx({
      chainId: CHAIN_ID,
      account: ALICE,
      operator: BOB,
      projectId: 34n,
      permissionIds: [1, 4, 14],
    });
    const data = encode(request);

    expect(request.address).toBe(
      jbContractAddress["6"][JBCoreContracts.JBPermissions][CHAIN_ID],
    );
    expect(request.args).toEqual([
      ALICE,
      { operator: BOB, projectId: 34n, permissionIds: [1, 4, 14] },
    ]);
    expect(request).not.toHaveProperty("value");
    expect(data.slice(0, 10)).toBe("0x449f24a4");
    expect(decodeFunctionData({ abi: request.abi, data })).toEqual({
      functionName: "setPermissionsFor",
      args: [
        ALICE,
        { operator: BOB, projectId: 34n, permissionIds: [1, 4, 14] },
      ],
    });
  });
});
