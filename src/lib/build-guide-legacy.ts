// Contract operation references retained from the original Build guide.
// Overlapping introductions now live in build-guide.ts; old links use its aliases.
import type { GuideSection } from '@/components/GuideSections'

export const LEGACY_BUILD_SECTIONS: readonly GuideSection[] = [
  {
    "id": "build-fund",
    "part": "Life of a project",
    "title": "Get funded",
    "paragraphs": [
      "A project receives payments through its payment contracts, called terminals. Use the current terms and a fresh quote to show the tokens the payer will receive."
    ],
    "blocks": [
      {
        "type": "code",
        "label": "JBMultiTerminal.pay (call outline)",
        "code": "pay(\n  projectId,\n  token,              // which token to pay with\n  amount,             // how much\n  beneficiary,        // who receives the minted tokens\n  minReturnedTokens,  // minimum amount the recipient must receive\n  memo,               // message attached to the payment\n  metadata            // extra data for hooks\n)\n// Returns: number of tokens minted for the beneficiary"
      },
      {
        "type": "table",
        "label": "Checking balances",
        "rows": [
          [
            "JBTerminalStore.balanceOf(terminal, projectId, token)",
            "Terminal balance for a specific token"
          ],
          [
            "JBTerminalStore.currentSurplusOf(...)",
            "Surplus across specified terminals and tokens"
          ],
          [
            "JBTerminalStore.currentTotalSurplusOf(...)",
            "Surplus aggregated across ALL terminals"
          ]
        ]
      },
      {
        "type": "info",
        "text": "Use addToBalanceOf() to add funds without receiving tokens, such as a grant, donation, or returned funds."
      }
    ]
  },
  {
    "id": "build-tokens-mgmt",
    "part": "Life of a project",
    "title": "Manage tokens",
    "paragraphs": [
      "Juicebox can track token balances itself; these balances are called credits. A project can also create a separate token contract using the ERC-20 standard. Holders can then move credits into that contract. Count both forms when showing a holder’s total balance."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "Token operations",
        "rows": [
          [
            "JBController.deployERC20For(projectId, name, symbol, salt)",
            "Deploy the project’s ERC-20 token"
          ],
          [
            "JBTokens.tokenOf(projectId)",
            "Get the ERC-20 address (zero if not yet deployed)"
          ],
          [
            "JBTokens.totalBalanceOf(holder, projectId)",
            "Complete holdings (credits + ERC-20)"
          ],
          [
            "JBTokens.creditBalanceOf(holder, projectId)",
            "Internal credits only"
          ],
          [
            "JBController.claimTokensFor(holder, projectId, count, beneficiary)",
            "Convert credits into ERC-20 tokens"
          ]
        ]
      },
      {
        "type": "table",
        "label": "Minting & burning",
        "rows": [
          [
            "JBController.mintTokensOf(projectId, tokenCount, beneficiary, memo, useReservedPercent)",
            "Owner mints tokens on-demand (if ruleset allows)"
          ],
          [
            "JBController.burnTokensOf(holder, projectId, tokenCount, memo)",
            "Holder burns their own tokens"
          ]
        ]
      }
    ]
  },
  {
    "id": "build-distribute",
    "part": "Life of a project",
    "title": "Send funds and reserved tokens",
    "paragraphs": [
      "Payouts send funds to the project’s chosen recipients. Reserved tokens are new tokens set aside for other recipients. Anyone can normally trigger these distributions, but the ownerMustSendPayouts setting can restrict payouts to the owner or an operator with SEND_PAYOUTS permission."
    ],
    "blocks": [
      {
        "type": "code",
        "label": "JBMultiTerminal.sendPayoutsOf (call outline)",
        "code": "sendPayoutsOf(\n  projectId,\n  token,\n  amount,              // up to the payout limit\n  currency,\n  minTokensPaidOut     // minimum amount the recipient must receive\n)\n// Distributes to splits, leftover to project owner\n// Review the final amount each recipient will receive"
      },
      {
        "type": "code",
        "label": "JBController.sendReservedTokensToSplitsOf (call outline)",
        "code": "sendReservedTokensToSplitsOf(projectId)\n// Anyone can call this at any time\n// Mints accumulated reserved tokens and distributes to splits"
      },
      {
        "type": "table",
        "label": "Tracking usage",
        "rows": [
          [
            "JBTerminalStore.usedPayoutLimitOf(...)",
            "How much of the payout limit has been used this cycle"
          ],
          [
            "JBTerminalStore.usedSurplusAllowanceOf(...)",
            "How much surplus allowance has been used"
          ],
          [
            "JBController.pendingReservedTokenBalanceOf(projectId)",
            "Undistributed reserved tokens"
          ]
        ]
      },
      {
        "type": "info",
        "text": "Recipients and their shares are stored as splits. Calling sendPayoutsOf() sends funds to those recipients; any leftover goes to the project owner."
      }
    ]
  },
  {
    "id": "build-cashout",
    "part": "Life of a project",
    "title": "Cash out",
    "paragraphs": [
      "Holders can exchange tokens for available project funds, called surplus. With one asset in one terminal, surplus is the balance above the remaining payout limit. A cash out removes the exchanged tokens from supply.",
      "The cash out tax controls how much stays for remaining holders. At 0%, the base formula returns a proportional share. Higher rates return less when only part of the supply is exchanged; 100% returns zero. Use a quote that includes the project’s extensions to find the final amount."
    ],
    "blocks": [
      {
        "type": "code",
        "label": "JBMultiTerminal.cashOutTokensOf (call outline)",
        "code": "cashOutTokensOf(\n  holder,\n  projectId,\n  cashOutCount,         // how many tokens to burn\n  tokenToReclaim,       // which token to receive\n  minTokensReclaimed,   // minimum amount the recipient must receive\n  beneficiary,          // who receives the funds\n  metadata\n)"
      },
      {
        "type": "info",
        "text": "Set minTokensReclaimed to the minimum the recipient accepts. The contract must enforce the same minimum shown in the review."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "/learn#learn-cash-outs",
            "label": "Cash out formula and worked example"
          }
        ]
      }
    ]
  },
  {
    "id": "build-revnet-deploy",
    "part": "Life of a revnet",
    "title": "Deploy a revnet",
    "paragraphs": [
      "Create a revnet and its stage schedule with REVDeployer.deployFor().",
      "Stages set how a revnet’s terms change over time. For example, an early stage can create more tokens per payment, followed by stages that gradually create fewer.",
      "Each stage sets the new-token rate, scheduled cuts, reserved share, and cash out tax. Stages begin automatically at their scheduled times."
    ],
    "blocks": [
      {
        "type": "code",
        "label": "REVDeployer.deployFor (call outline)",
        "code": "deployFor(\n  revnetId,                        // project ID (or 0 for auto)\n  configuration,                   // REVConfig with stages\n  accountingContextsToAccept[],    // tokens the terminal should accept\n  suckerDeploymentConfiguration,   // cross-chain setup\n  tiered721HookConfiguration,      // optional NFT tiers\n  allowedPosts[]                   // optional croptop posts\n)\n// New revnet (revnetId == 0): include the current project creation fee.\n// Existing project ID: send no native value."
      },
      {
        "type": "text",
        "text": "A revnet uses the same payment and cash out calls as other projects. REVOwner applies its terms through an extension. Include that extension when requesting a quote, and check the operator’s remaining permissions."
      },
      {
        "type": "table",
        "label": "Reading stage state",
        "rows": [
          [
            "JBController.currentRulesetOf(projectId)",
            "Active stage parameters"
          ],
          [
            "JBController.upcomingRulesetOf(projectId)",
            "Next ruleset, including an automatic cycle of the current stage; empty only when no ruleset follows."
          ],
          [
            "JBController.allRulesetsOf(projectId, startingId, size)",
            "Complete stage history"
          ]
        ]
      }
    ],
    "aliases": [
      "build-revnet-stages"
    ]
  },
  {
    "id": "build-permissions",
    "part": "Ecosystem tools",
    "title": "Permissions",
    "paragraphs": [
      "Give another address permission for a specific action with JBPermissions. Choose only the permissions it needs and the project they apply to. The contract stores each permission as one bit in a 256-bit field."
    ],
    "blocks": [
      {
        "type": "code",
        "label": "JBPermissions.setPermissionsFor (call outline)",
        "code": "setPermissionsFor(\n  account,         // the address granting permission\n  permissionsData  // { operator, projectId, permissionIds[] }\n)\n// projectId = 0 is the wildcard: every project `account` controls on this chain"
      },
      {
        "type": "table",
        "label": "Checking permissions",
        "rows": [
          [
            "JBPermissions.hasPermission(operator, account, projectId, permissionId, includeRoot, includeWildcard)",
            "Check a single permission"
          ],
          [
            "JBPermissions.hasPermissions(operator, account, projectId, permissionIds[], includeRoot, includeWildcard)",
            "Check multiple permissions at once"
          ],
          [
            "JBPermissions.WILDCARD_PROJECT_ID()",
            "Returns 0 — the wildcard project ID"
          ]
        ]
      },
      {
        "type": "table",
        "label": "Permission ids",
        "rows": [
          [
            "1 - ROOT",
            "Grants every permission. Prefer the specific actions needed."
          ],
          [
            "2 - QUEUE_RULESETS",
            "Queue new rulesets for the project."
          ],
          [
            "3 - LAUNCH_RULESETS",
            "Launch the project’s first rulesets."
          ],
          [
            "4 - CASH_OUT_TOKENS",
            "Cash out (redeem) project tokens on a holder’s behalf."
          ],
          [
            "5 - SEND_PAYOUTS",
            "Trigger payout distributions."
          ],
          [
            "6 - MIGRATE_TERMINAL",
            "Migrate funds to a new terminal."
          ],
          [
            "7 - SET_PROJECT_URI",
            "Update project metadata."
          ],
          [
            "8 - DEPLOY_ERC20",
            "Deploy the project’s ERC-20 token."
          ],
          [
            "9 - SET_TOKEN",
            "Set a custom token for the project."
          ],
          [
            "10 - MINT_TOKENS",
            "Create tokens without a payment."
          ],
          [
            "11 - BURN_TOKENS",
            "Burn tokens from another holder."
          ],
          [
            "12 - CLAIM_TOKENS",
            "Claim credits into ERC-20 tokens for a holder."
          ],
          [
            "13 - TRANSFER_CREDITS",
            "Transfer a holder’s unclaimed credits."
          ],
          [
            "14 - SET_CONTROLLER",
            "Change the project controller."
          ],
          [
            "15 - SET_TERMINALS",
            "Set the project’s terminals."
          ],
          [
            "16 - ADD_TERMINALS",
            "Add terminals to the project."
          ],
          [
            "17 - SET_PRIMARY_TERMINAL",
            "Set the primary terminal for a token."
          ],
          [
            "18 - USE_ALLOWANCE",
            "Withdraw surplus via the surplus allowance."
          ],
          [
            "19 - SET_SPLIT_GROUPS",
            "Modify payout and reserved token splits."
          ],
          [
            "20 - ADD_PRICE_FEED",
            "Add a price feed for a currency pair."
          ],
          [
            "21 - ADD_ACCOUNTING_CONTEXTS",
            "Add accounting contexts (accepted tokens) to a terminal."
          ],
          [
            "22 - SET_TOKEN_METADATA",
            "Set the project token’s name and symbol."
          ],
          [
            "23 - SIGN_FOR_ERC20",
            "Sign ERC-20 permit approvals on the project’s behalf."
          ],
          [
            "24 - ADJUST_721_TIERS",
            "Add or remove tiers on a 721 hook."
          ],
          [
            "25 - SET_721_METADATA",
            "Update a 721 hook’s metadata (base URI, resolver, contract URI)."
          ],
          [
            "26 - MINT_721",
            "Mint NFTs directly, without a payment."
          ],
          [
            "27 - SET_721_DISCOUNT_PERCENT",
            "Set the 721 hook’s discount percent."
          ],
          [
            "28 - SET_BUYBACK_TWAP",
            "Set the period used to calculate the buyback market’s average price (TWAP)."
          ],
          [
            "29 - SET_BUYBACK_POOL",
            "Set the buyback hook’s Uniswap pool."
          ],
          [
            "30 - SET_BUYBACK_HOOK",
            "Set which buyback hook the registry routes the project to."
          ],
          [
            "31 - SET_ROUTER_TERMINAL",
            "Configure the project’s router terminal."
          ],
          [
            "32 - MAP_SUCKER_TOKEN",
            "Link matching assets across a pair of bridge contracts (suckers)."
          ],
          [
            "33 - DEPLOY_SUCKERS",
            "Create bridge contracts between the project’s chains."
          ],
          [
            "34 - SET_SUCKER_PEER",
            "Set a sucker’s cross-chain peer."
          ],
          [
            "35 - SUCKER_SAFETY",
            "Emergency token recovery on a sucker."
          ],
          [
            "36 - SET_SUCKER_DEPRECATION",
            "Deprecate a sucker."
          ],
          [
            "37 - OPEN_LOAN",
            "Open a REVLoans loan against project tokens."
          ],
          [
            "38 - REALLOCATE_LOAN",
            "Move collateral into a new loan and borrow its current capacity. The operator chooses where new proceeds go."
          ],
          [
            "39 - REPAY_LOAN",
            "Repay or release collateral on a holder’s behalf. The operator chooses where returned collateral goes."
          ]
        ]
      },
      {
        "type": "info",
        "text": "Permissions are per-operator, per-project. Granting QUEUE_RULESETS to address X for project 5 doesn’t give X any access to project 6."
      }
    ]
  },
  {
    "id": "build-nfts",
    "part": "Ecosystem tools",
    "title": "Sell collectibles and memberships",
    "paragraphs": [
      "A project shop can sell uniquely identified tokens, called NFTs. Items are grouped into tiers with a price and supply. The JB721TiersHook extension delivers the selected items when a payment covers their price."
    ],
    "blocks": [
      {
        "type": "code",
        "label": "JB721TiersHookProjectDeployer.launchProjectFor (call outline)",
        "code": "launchProjectFor(\n  owner,\n  deployTiersHookConfig,    // NFT name, symbol, tiers[]\n  launchProjectConfig,      // standard project config\n  controller,\n  salt                      // CREATE2 salt for a deterministic hook address (0 for none)\n)\n// Always use this deployer, even with empty tiers"
      },
      {
        "type": "table",
        "label": "Tier configuration",
        "rows": [
          [
            "price",
            "What one NFT of this tier costs."
          ],
          [
            "initialSupply",
            "Max NFTs available. Must be at least 1; capped at 999,999,999. 0 is rejected."
          ],
          [
            "category",
            "Grouping ID. Tiers MUST be sorted by category (ascending)."
          ],
          [
            "reserveFrequency",
            "Mint 1 reserved NFT every N minted."
          ],
          [
            "reserveBeneficiary",
            "Who receives reserved NFTs."
          ],
          [
            "votingUnits",
            "Voting weight through JB721Checkpoints. Used only when flags.useVotingUnits is set; otherwise the tier’s price sets its voting weight."
          ],
          [
            "encodedIpfsUri",
            "IPFS content hash for metadata."
          ],
          [
            "flags.cantBeRemoved",
            "If true, tier is permanent (one of the nested flags: allowOwnerMint, useVotingUnits, transfersPausable, cantBeRemoved, …)."
          ]
        ]
      },
      {
        "type": "table",
        "label": "Reading nft state",
        "rows": [
          [
            "JB721TiersHookStore.tiersOf(hook, categories[], includeResolvedUri, startId, size)",
            "List tiers with optional filters"
          ],
          [
            "JB721TiersHookStore.tierOf(hook, tierId, includeResolvedUri)",
            "Single tier details"
          ],
          [
            "JB721TiersHook.balanceOf(owner)",
            "NFTs held by an address"
          ],
          [
            "JB721TiersHook.cashOutWeightOf(tokenIds[])",
            "Cash out weight of specific NFTs (divide by totalCashOutWeight() for the surplus fraction)"
          ]
        ]
      },
      {
        "type": "info",
        "text": "Sort tiers by category. An out-of-order list fails with InvalidCategorySortOrder."
      }
    ]
  },
  {
    "id": "build-hooks",
    "part": "Ecosystem tools",
    "title": "Add custom behavior with hooks",
    "paragraphs": [
      "An extension can change a payment’s token output, send rewards, or check a rule change. These extensions are called hooks. Choose the interface for the moment when your code needs to run."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "Hook interfaces",
        "rows": [
          [
            "IJBRulesetDataHook",
            "Runs before a payment or cash out is recorded. Can change the new-token rate, cash out inputs, and which later hooks run."
          ],
          [
            "IJBPayHook",
            "Runs after a payment is recorded and tokens are created. Can deliver rewards or trigger other actions."
          ],
          [
            "IJBCashOutHook",
            "Runs after a cash out is recorded. Can receive funds and run additional actions."
          ],
          [
            "IJBSplitHook",
            "Runs when a recipient’s share is sent to an extension. Can forward or use the funds."
          ],
          [
            "IJBRulesetApprovalHook",
            "Approves new project terms before they can take effect. Must return APPROVED."
          ]
        ]
      },
      {
        "type": "code",
        "label": "IJBPayHook interface (call outline)",
        "code": "function afterPayRecordedWith(\n  JBAfterPayRecordedContext calldata context\n) external payable;\n\n// context includes:\n//   payer, projectId, rulesetId, amount,\n//   forwardedAmount, weight, newlyIssuedTokenCount,\n//   beneficiary, hookMetadata, payerMetadata"
      },
      {
        "type": "info",
        "text": "Use a data hook to change the values recorded by the payment or cash out. Use later hooks to receive funds or trigger additional actions."
      }
    ]
  },
  {
    "id": "build-distributor",
    "part": "Ecosystem tools",
    "title": "Share rewards over time",
    "paragraphs": [
      "A distributor shares reward tokens with eligible holders over time. Rewards unlock gradually, called vesting. Deploy this optional extension for your project; it is separate from the shared core contracts.",
      "JBTokenDistributor supports tokens with IJBActiveVotes, such as Juicebox JBERC20. JB721Distributor supports NFT holders. Fund either through project distributions or direct deposits. Each round records the available rewards and holders’ eligible balances, then unlocks their shares evenly over the configured rounds."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "Core functions",
        "rows": [
          [
            "fund(hook, token, amount)",
            "Directly deposit reward tokens for a specific hook’s staker pool"
          ],
          [
            "beginVesting(hook, tokenIds[], tokens[])",
            "Snapshot and begin vesting for the specified token IDs"
          ],
          [
            "collectVestedRewards(hook, tokenIds[], tokens[], beneficiary)",
            "Collect unlocked vested tokens (auto-vests current round too)"
          ],
          [
            "releaseForfeitedRewards(hook, tokenIds[], tokens[], beneficiary)",
            "Return unvested rewards from burned tokens to the pool"
          ],
          [
            "poke()",
            "Record the snapshot block for the current round early"
          ]
        ]
      },
      {
        "type": "table",
        "label": "Read state",
        "rows": [
          [
            "balanceOf(hook, token)",
            "Balance held for a hook’s staker pool"
          ],
          [
            "collectableFor(hook, tokenId, token)",
            "How much is unlocked and ready to collect right now"
          ],
          [
            "claimedFor(hook, tokenId, token)",
            "Total uncollected amount (vesting + vested-but-uncollected)"
          ],
          [
            "currentRound()",
            "The current round number"
          ],
          [
            "roundSnapshotBlock(round)",
            "The block number used for stake weight lookups"
          ]
        ]
      },
      {
        "type": "info",
        "text": "Reward shares use voting weight at a recorded block. Token distributors read IVotes.getPastVotes(); NFT distributors use tier voting units. Token holders must assign their votes, even to themselves, to count. IJBActiveVotes.getPastTotalActiveVotes excludes balances whose votes are unassigned."
      }
    ]
  },
  {
    "id": "build-handles",
    "part": "Ecosystem tools",
    "title": "Give a project a name",
    "paragraphs": [
      "A project can use a readable Ethereum Name Service (ENS) name. JBProjectHandles checks that the name’s record also points back to the project before returning it from handleOf().",
      "Anyone can propose a name. The registry stores each proposal by its setter, chain ID, and project ID. Apps should also check that the project’s current owner or operator claimed the name."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "Handle functions",
        "rows": [
          [
            "setEnsNamePartsFor(chainId, projectId, parts[])",
            "Associate ENS name parts with a project. Anyone can call this — no access control."
          ],
          [
            "ensNamePartsOf(chainId, projectId, setter)",
            "Get the stored name parts as set by a specific setter address."
          ],
          [
            "handleOf(chainId, projectId, setter)",
            "Returns the verified handle string, or empty if ENS text record doesn’t match."
          ],
          [
            "TEXT_KEY",
            "The ENS text record key: \"juicebox\". Expected value: \"{chainId}:{projectId}\"."
          ]
        ]
      },
      {
        "type": "text",
        "text": "Name parts are in reverse order. handleOf returns the dot-joined labels without a .eth suffix; the suffix is only added when computing the namehash for verification. `_formatHandle` (JBProjectHandles.sol:220-232) walks the array from the LAST element to the first, so the innermost label goes last. For \"myproject.eth\" → [\"myproject\"]. For \"sub.myproject.eth\" → [\"myproject\", \"sub\"]. Parts cannot contain dots, ASCII control characters, DEL, \"eth\", or be empty. Unicode normalization (ENSIP-15) is the caller/client’s responsibility, not the contract’s."
      }
    ]
  },
  {
    "id": "build-payer",
    "part": "Ecosystem tools",
    "title": "Create an address that forwards payments",
    "paragraphs": [
      "A payer address forwards incoming ETH to a project. Deploy JBProjectPayer as a small copy of a shared implementation, called a clone. Its constructor takes JBDirectory; set defaults through initialize() or setDefaultValues().",
      "When defaultAddToBalance is false, incoming ETH calls pay() and delivers project tokens to the beneficiary. When true, it adds funds without creating tokens. With no chosen beneficiary, the contract finds the original payer, including through supported forwarding contracts. ERC-20 payments need an explicit pay() or addToBalanceOf() call after approval; sending those tokens directly will not trigger a payment."
    ],
    "blocks": [
      {
        "type": "code",
        "label": "JBProjectPayer defaults (call outline)",
        "code": "// Set via initialize() after clone deployment:\ndefaultProjectId       // which project to forward to\ndefaultBeneficiary     // who gets the tokens (0 = msg.sender)\ndefaultMemo            // attached to each payment\ndefaultMetadata        // extra data for hooks\ndefaultAddToBalance    // false = pay(), true = addToBalance()\n\n// Anyone sends ETH to the payer address:\n//   → receive() fires\n//   → looks up DIRECTORY.primaryTerminalOf(projectId, token)\n//   → calls pay() or addToBalanceOf() with defaults"
      },
      {
        "type": "info",
        "text": "The payer address looks up the project’s current payment contract through JBDirectory each time it receives a payment."
      }
    ]
  },
  {
    "id": "build-swap-terminal",
    "part": "Ecosystem tools",
    "title": "Accept payments in other assets",
    "paragraphs": [
      "A router can convert a payment into an asset the project accepts. JBRouterTerminal finds a supported route, makes the conversion, and forwards the result to the project’s payment contract. It does not keep a project balance.",
      "JBPayRouteResolver compares available routes by the tokens the payer would receive. A route may forward an accepted asset, swap through Uniswap V3 or V4, cash out other Juicebox tokens, or combine these steps. Availability depends on the project, asset, and market; check previewPayFor before offering the route."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "Router terminal functions",
        "rows": [
          [
            "pay(...)",
            "Same IJBTerminal interface as JBMultiTerminal — resolves the best route, converts the input, then calls pay() on the destination terminal."
          ],
          [
            "addToBalanceOf(...)",
            "Same as pay() but forwards via addToBalanceOf() on the destination terminal (no token minting)."
          ],
          [
            "previewPayFor(...)",
            "Preview the chosen route and expected output for a payment without executing it."
          ],
          [
            "bestPoolLiquidityOf(tokenA, tokenB)",
            "Report the deepest-liquidity Uniswap pool the router would use for a pair."
          ]
        ]
      },
      {
        "type": "text",
        "text": "Projects attach JBRouterTerminalRegistry to JBDirectory alongside JBMultiTerminal. Read terminalOf(projectId) to find the selected route: current deployments use JBRouterTerminalGateway → ROUTER(), while unmigrated projects can still select the previous router. The gateway takes custody before routing. Eligible failed fee routes remain pending for retry instead of being settled or forgiven; finalization can refund the source project after qualified failures. Use canonical deployment records per chain: a proposed mainnet deployment is not a live gateway."
      }
    ]
  },
  {
    "id": "build-buyback",
    "part": "Ecosystem tools",
    "title": "Buy existing tokens when they offer more",
    "paragraphs": [
      "A payment can create new tokens or buy existing ones from a market. JBBuybackHook compares both and uses the configured Uniswap V4 pool when it gives the payer more tokens. It can also route cash outs.",
      "To limit price changes during a swap, the hook uses an average price over time, called TWAP, to calculate its default minimum. Buyback 1.4.0 falls back to minting when the swap cannot meet that floor. Pay metadata under getId(\"pay\", hook) must encode (amountToSwapWith, minimumSwapAmountOut, skipSplits); the third word is a bool, and a two-word quote reverts."
    ],
    "blocks": [
      {
        "type": "code",
        "label": "JBBuybackHook configuration (call outline)",
        "code": "// Set up the buyback hook with a Uniswap V4 pool\nJBBuybackHook.setPoolFor(\n  projectId,\n  fee,              // Uniswap pool fee tier\n  tickSpacing,      // pool tick spacing\n  twapWindow,       // TWAP observation window (seconds)\n  terminalToken     // the terminal token to route\n)\n// The pool key is once-only; the TWAP window stays mutable via setTwapWindowOf\n// Requires SET_BUYBACK_POOL permission"
      },
      {
        "type": "diagram",
        "label": "Buyback decision flow",
        "lines": [
          "  payment arrives",
          "     │",
          "     ▼",
          "  query TWAP oracle for market price",
          "     │",
          "     ├─ pool gives more tokens than minting",
          "     │  └─▶ swap on Uniswap V4, mint any unswapped remainder",
          "     │",
          "     └─ minting gives equal or more tokens",
          "        └─▶ normal mint flow (weight × amount)"
        ]
      },
      {
        "type": "info",
        "text": "For cash outs, the hook can sell tokens through the pool when that returns more than the project’s cash out quote. Callers can supply their own quote and minimum in the transaction metadata."
      }
    ]
  },
  {
    "id": "build-bendystraw",
    "part": "Build your own",
    "title": "Search project data with Bendystraw",
    "paragraphs": [
      "Bendystraw gathers Juicebox chain records into a searchable database. This service, called an indexer, supplies project lists, activity, charts, and market positions through GraphQL queries.",
      "Use it for fast browsing. Before signing, read balances, terms, spending approvals, and quotes directly from the chain again. The index can be a few blocks behind, so missing activity does not prove that a transaction failed."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "Endpoints",
        "rows": [
          [
            "https://bendystraw.up.railway.app/graphql",
            "Mainnets: Ethereum, Optimism, Base, Arbitrum. No API key needed"
          ],
          [
            "https://testnet.bendystraw.xyz/graphql",
            "Testnets: Sepolia and the L2 Sepolias"
          ],
          [
            "…/schema",
            "A playground with the schema explorer; POST an introspection query to the graphql URL for codegen (same schema on both databases)"
          ]
        ]
      },
      {
        "type": "code",
        "label": "A first query (call outline)",
        "code": "POST https://bendystraw.up.railway.app/graphql\n{\n  projects(where: { chainId: 8453, version: 6 }, orderBy: \"balance\", orderDirection: \"desc\", limit: 10) {\n    items { projectId chainId name balance suckerGroupId }\n    totalCount\n  }\n}"
      },
      {
        "type": "table",
        "label": "What to ask it for",
        "rows": [
          [
            "projects / project(chainId, projectId, version: 6)",
            "Name, metadata URI, balance, token, owner, and the sucker group that links its chains"
          ],
          [
            "payEvents, cashOutTokensEvents, activityEvents",
            "The feed behind any project page; filter by projectId or suckerGroupId"
          ],
          [
            "participants",
            "Token holders and their balances, per project or per sucker group"
          ],
          [
            "buybackPools, swapEvents, buybackPoolPositions",
            "Market pools, prices after trades, and the price ranges funded by liquidity providers"
          ],
          [
            "loans, borrowLoanEvents",
            "Revnet loans and their collateral"
          ],
          [
            "nftTiers, mintNftEvents",
            "721 shop tiers and purchases"
          ],
          [
            "suckerTransactions",
            "Cross-chain moves and where each one is in its lifecycle"
          ]
        ]
      },
      {
        "type": "steps",
        "items": [
          "Every V6 row is versioned: filter with version: 6, and key a project by chainId + projectId, never projectId alone — the same number exists on every chain.",
          "Numeric arguments on singular queries are Float!, not Int! (Ponder’s choice). Declare variables as Float! or the request fails validation with no data.",
          "Lists page with limit and offset and return totalCount; loop until you have them all rather than trusting one page.",
          "suckerGroupId is as-of-event: when chains are linked later, old event rows keep the group id they were written with. Query by every project in the group when you need the full history.",
          "The SDK’s requestBendystraw(endpoint, query, variables) handles the POST, error surfacing, and endpoint normalisation; selectBendystrawEndpoint picks mainnet vs testnet from a chainId."
        ]
      },
      {
        "type": "info",
        "text": "Give your assistant the /jb-bendystraw skill for help with queries, charts, and holder lists. It is part of the Juicebox V6 skills library. Bendystraw source: github.com/peripheralist/bendystraw."
      }
    ]
  },
  {
    "id": "build-clients",
    "part": "Build your own",
    "title": "Use this app as a reference",
    "paragraphs": [
      "Use Juicebox Money’s source to build your own product. Its Next.js app shows how to find projects, load details and media, and prepare transactions against the current V6 contracts.",
      "Start with a flow close to yours, such as Pay, Cash Out, Create, or Shop. Read its source and tests to see how it checks current data, prepares a request, and shows what the user will sign."
    ],
    "blocks": [
      {
        "type": "steps",
        "items": [
          "Start from the product flow closest to yours — such as Pay, Cash Out, project creation, ruleset editing, or the Shop — and identify its component, supporting reads, and transaction builder.",
          "Give your assistant the relevant source, tests, guide link, V6 contracts, and Juicebox V6 skills library (github.com/mejango/juicebox-skills) to help it explain anything Juicebox.",
          "Use indexed data for browsing. Refresh the chain data the transaction depends on just before building and sending it.",
          "Prepare one request and check that encoding and decoding preserves its fields. Test the behavior your product depends on before asking a wallet to sign."
        ]
      },
      {
        "type": "links",
        "items": [
          {
            "href": "https://github.com/mejango/juicebox-money",
            "label": "Juicebox Money’s repo (source + tests)"
          },
          {
            "href": "https://github.com/Bananapus/version-6",
            "label": "V6 contracts (version-6)"
          }
        ]
      },
      {
        "type": "text",
        "text": "Use the app to study the experience and its source to see how it works. The server helps with search, media, and request preparation. The wallet signs only after the action is shown and checked against the V6 contract format."
      }
    ]
  }
]
