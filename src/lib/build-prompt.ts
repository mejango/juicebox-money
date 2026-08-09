export const PLATFORM_BUILD_PROMPT = `I want to build a product or platform on Juicebox V6.

My product: [describe the users, the value they exchange, and the experience I want].

Act as my protocol engineer and product architect. Start by reading https://juicebox.money/learn and https://juicebox.money/build, then inspect the open-source Juicebox V6 implementation and contracts. Use only current V6 repositories (the protocol repos end in -v6); do not substitute older Juicebox versions.

Design the smallest safe architecture that gives my users a native product experience while Juicebox handles the money layer. Decide whether I need a flexible Juicebox project, an immutable revnet, or both. Map every user action to exact V6 reads and transactions, including payments, token issuance, cash outs, payouts, shops, hooks, permissions, and multichain settlement where relevant.

For each transaction, identify the contract, function, arguments, units, permissions, fees, approvals, slippage or minimum-output protection, and the state that must be re-read immediately before signing. Prefer audited SDK builders and pure transaction builders which round-trip through the ABI. Never ask me to connect a wallet or sign until you have shown me the decoded transaction and explained its effect.

Deliver: (1) a plain-language product flow, (2) the onchain architecture, (3) a threat model and trust assumptions, (4) an incremental implementation plan, (5) test cases and invariants, and (6) the first working vertical slice. Keep the interface branded as my product; treat Juicebox as open infrastructure, not a hosted dependency.`
