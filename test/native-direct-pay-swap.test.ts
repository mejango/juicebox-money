import {
  buildDirectPaySwapTx,
  NATIVE_SWAP_BY_CHAIN,
  restampDirectSwapDeadline,
  type DirectPaySwapQuote,
} from "@/lib/direct-pay-swap";
import { decodeAbiParameters, type Address } from "viem";
import { describe, expect, it } from "vitest";

const RECIPIENT = "0x3333333333333333333333333333333333333333" as Address;
const MAINNET_CHAIN_IDS = [1, 10, 8453, 42161] as const;

describe("native direct-pay routing", () => {
  it("chains Base ETH through USDC into the hooked V4 pool atomically", () => {
    const quote: DirectPaySwapQuote = {
      kind: "direct-swap",
      poolKey: {
        currency0: "0x2222222222222222222222222222222222222222",
        currency1: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        fee: 10_000,
        tickSpacing: 200,
        hooks: "0x4444444444444444444444444444444444444444",
      },
      zeroForOne: false,
      quotedTokenCount: 101n,
      minimumTokenCount: 100n,
      beneficiaryTokenCount: 100n,
      reservedTokenCount: 0n,
      inputRoute: {
        kind: "native-v3-v4",
        wrappedNative: "0x4200000000000000000000000000000000000006",
        bridgeToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        bridgeTokenSymbol: "USDC",
        bridgeTokenDecimals: 6,
        v3Fee: 500,
        quotedBridgeAmount: 25_000_000n,
      },
    };
    const request = buildDirectPaySwapTx({
      chainId: 8453,
      quote,
      amount: 10_000_000_000_000_000n,
      recipient: RECIPIENT,
      deadline: 1_800_000_000n,
    });

    expect(request.args[0]).toBe("0x0b0010");
    expect(request.args[1]).toHaveLength(3);
    expect(request.value).toBe(10_000_000_000_000_000n);
    const [actions] = decodeAbiParameters(
      [{ type: "bytes" }, { type: "bytes[]" }],
      request.args[1][2],
    );
    expect(actions).toBe("0x0b060e");
  });

  it("chains Base USDC through ETH into a native-paired hooked V4 pool atomically", () => {
    const quote: DirectPaySwapQuote = {
      kind: "direct-swap",
      poolKey: {
        currency0: "0x0000000000000000000000000000000000000000",
        currency1: "0x2222222222222222222222222222222222222222",
        fee: 10_000,
        tickSpacing: 200,
        hooks: "0x4444444444444444444444444444444444444444",
      },
      zeroForOne: true,
      quotedTokenCount: 101n,
      minimumTokenCount: 100n,
      beneficiaryTokenCount: 100n,
      reservedTokenCount: 0n,
      inputRoute: {
        kind: "erc20-v3-native-v4",
        inputToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        wrappedNative: "0x4200000000000000000000000000000000000006",
        bridgeTokenSymbol: "ETH",
        bridgeTokenDecimals: 18,
        v3Fee: 500,
        quotedBridgeAmount: 10_000_000_000_000_000n,
      },
    };
    const request = buildDirectPaySwapTx({
      chainId: 8453,
      quote,
      amount: 25_000_000n,
      recipient: RECIPIENT,
      deadline: 1_800_000_000n,
    });

    expect(request.args[0]).toBe("0x000c10");
    expect(request.args[1]).toHaveLength(3);
    expect(request.value).toBe(0n);
    const [actions] = decodeAbiParameters(
      [{ type: "bytes" }, { type: "bytes[]" }],
      request.args[1][2],
    );
    expect(actions).toBe("0x0b060e");
  });

  it("builds both bridge directions on every supported mainnet", () => {
    for (const chainId of MAINNET_CHAIN_IDS) {
      const config = NATIVE_SWAP_BY_CHAIN[chainId];
      expect(config, `missing bridge config for chain ${chainId}`).toBeDefined();
      if (!config) continue;

      const nativeQuote: DirectPaySwapQuote = {
        kind: "direct-swap",
        poolKey: {
          currency0: "0x2222222222222222222222222222222222222222",
          currency1: config.bridgeToken,
          fee: 10_000,
          tickSpacing: 200,
          hooks: "0x4444444444444444444444444444444444444444",
        },
        zeroForOne: false,
        quotedTokenCount: 101n,
        minimumTokenCount: 100n,
        beneficiaryTokenCount: 100n,
        reservedTokenCount: 0n,
        inputRoute: {
          kind: "native-v3-v4",
          wrappedNative: config.wrappedNative,
          bridgeToken: config.bridgeToken,
          bridgeTokenSymbol: "USDC",
          bridgeTokenDecimals: 6,
          v3Fee: 500,
          quotedBridgeAmount: 25_000_000n,
        },
      };
      const nativeRequest = buildDirectPaySwapTx({
        chainId,
        quote: nativeQuote,
        amount: 10_000_000_000_000_000n,
        recipient: RECIPIENT,
        deadline: 1_800_000_000n,
      });
      expect(nativeRequest.chainId).toBe(chainId);
      expect(nativeRequest.args[0]).toBe("0x0b0010");

      const erc20Quote: DirectPaySwapQuote = {
        ...nativeQuote,
        poolKey: {
          ...nativeQuote.poolKey,
          currency0: "0x0000000000000000000000000000000000000000",
          currency1: "0x2222222222222222222222222222222222222222",
        },
        zeroForOne: true,
        inputRoute: {
          kind: "erc20-v3-native-v4",
          inputToken: config.bridgeToken,
          wrappedNative: config.wrappedNative,
          bridgeTokenSymbol: "ETH",
          bridgeTokenDecimals: 18,
          v3Fee: 500,
          quotedBridgeAmount: 10_000_000_000_000_000n,
        },
      };
      const erc20Request = buildDirectPaySwapTx({
        chainId,
        quote: erc20Quote,
        amount: 25_000_000n,
        recipient: RECIPIENT,
        deadline: 1_800_000_000n,
      });
      expect(erc20Request.chainId).toBe(chainId);
      expect(erc20Request.args[0]).toBe("0x000c10");
    }
  });

  it("re-stamps only the deadline of a reviewed swap, keeping amounts and minimums frozen", () => {
    // The request is built at dialog-open with a 20-minute EOA deadline;
    // confirming later made simulation revert on every retry. The fix stamps
    // a fresh deadline immediately before send — nothing else may change.
    const quote: DirectPaySwapQuote = {
      kind: "direct-swap",
      poolKey: {
        currency0: "0x2222222222222222222222222222222222222222",
        currency1: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        fee: 10_000,
        tickSpacing: 200,
        hooks: "0x4444444444444444444444444444444444444444",
      },
      zeroForOne: false,
      quotedTokenCount: 101n,
      minimumTokenCount: 100n,
      beneficiaryTokenCount: 100n,
      reservedTokenCount: 0n,
      inputRoute: {
        kind: "native-v3-v4",
        wrappedNative: "0x4200000000000000000000000000000000000006",
        bridgeToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        bridgeTokenSymbol: "USDC",
        bridgeTokenDecimals: 6,
        v3Fee: 500,
        quotedBridgeAmount: 25_000_000n,
      },
    };
    const request = buildDirectPaySwapTx({
      chainId: 8453,
      quote,
      amount: 10_000_000_000_000_000n,
      recipient: RECIPIENT,
      deadline: 1_800_000_000n,
    });

    const restamped = restampDirectSwapDeadline(request, 1_900_000_000n);

    expect(restamped.args[2]).toBe(1_900_000_000n);
    // The reviewed commands and encoded inputs (amounts, slippage floor)
    // must be byte-identical — the deadline lives ONLY in execute()'s third
    // argument, never inside the inputs.
    expect(restamped.args[0]).toBe(request.args[0]);
    expect(restamped.args[1]).toBe(request.args[1]);
    expect(restamped.value).toBe(request.value);
    expect(restamped.address).toBe(request.address);
    // The original reviewed request is not mutated.
    expect(request.args[2]).toBe(1_800_000_000n);
  });

  it("passes an unexpected request shape through unchanged instead of corrupting it", () => {
    const notASwap = {
      functionName: "pay",
      args: [1n, 2n] as readonly unknown[],
    };
    expect(restampDirectSwapDeadline(notASwap, 1_900_000_000n)).toBe(notASwap);
  });
});
