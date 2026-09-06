// Generated from the Learn/Build DOM renderer's Build tab (juicescan mirror) on 2026-08-28.
// Reference sections retained with corrections against the V6 contracts; section IDs stay stable.
import type { GuideSection } from '@/components/GuideSections'

export const LEGACY_BUILD_SECTIONS: readonly GuideSection[] = [
  {
    "id": "build-launch",
    "part": "Life of a project",
    "title": "Launch",
    "paragraphs": [
      "Everything starts with JBController.launchProjectFor(). This single call:"
    ],
    "blocks": [
      {
        "type": "steps",
        "items": [
          "Mints an ERC-721 project NFT to the owner address",
          "Configures initial rulesets (payout limits, token weights, reserved percents, etc.)",
          "Sets up terminal configurations (which tokens the project accepts)",
          "Registers the project in JBDirectory"
        ]
      },
      {
        "type": "code",
        "label": "JBController.launchProjectFor (call outline)",
        "code": "launchProjectFor(\n  owner,                    // receives the project NFT\n  projectUri,               // metadata (name, description, logo)\n  rulesetConfigurations[],  // operational parameters\n  terminalConfigurations[], // payment processing setup\n  memo                      // transaction description\n)\n// Send exactly JBProjects.creationFee() as transaction value."
      },
      {
        "type": "info",
        "text": "For omnichain projects, use JBOmnichainDeployer.launchProjectFor() instead — it launches the project and its local suckers in one transaction. Run it on each chain the project should live on."
      }
    ]
  },
  {
    "id": "build-configure",
    "part": "Life of a project",
    "title": "Configure",
    "paragraphs": [
      "After launch, inspect and understand your project’s configuration:"
    ],
    "blocks": [
      {
        "type": "table",
        "label": "READING PROJECT STATE",
        "rows": [
          [
            "JBProjects.ownerOf(projectId)",
            "Who owns the project NFT"
          ],
          [
            "JBController.uriOf(projectId)",
            "Metadata link (name, description, logo)"
          ],
          [
            "JBController.currentRulesetOf(projectId)",
            "Active ruleset and its metadata"
          ],
          [
            "JBController.upcomingRulesetOf(projectId)",
            "What comes next (auto-cycled with weight decay)"
          ],
          [
            "JBDirectory.terminalsOf(projectId)",
            "All active terminals"
          ],
          [
            "JBDirectory.primaryTerminalOf(projectId, token)",
            "Default terminal for a specific token"
          ],
          [
            "JBMultiTerminal.accountingContextsOf(projectId)",
            "Which tokens/currencies are accepted"
          ],
          [
            "JBSplits.splitsOf(projectId, rulesetId, groupId)",
            "Payout and reserved token distribution rules"
          ]
        ]
      },
      {
        "type": "table",
        "label": "FUND ACCESS LIMITS",
        "rows": [
          [
            "JBFundAccessLimits.payoutLimitOf(...)",
            "Maximum distributable per cycle per token"
          ],
          [
            "JBFundAccessLimits.surplusAllowanceOf(...)",
            "How much surplus the owner can withdraw"
          ]
        ]
      },
      {
        "type": "info",
        "text": "Empty fundAccessLimitGroups = zero payouts (NOT unlimited). Use uint224.max for unlimited payouts."
      }
    ]
  },
  {
    "id": "build-fund",
    "part": "Life of a project",
    "title": "Get funded",
    "paragraphs": [
      "Once launched, anyone can contribute to the project through its configured terminals."
    ],
    "blocks": [
      {
        "type": "code",
        "label": "JBMultiTerminal.pay (call outline)",
        "code": "pay(\n  projectId,\n  token,              // which token to pay with\n  amount,             // how much\n  beneficiary,        // who receives the minted tokens\n  minReturnedTokens,  // slippage protection\n  memo,               // message attached to the payment\n  metadata            // extra data for hooks\n)\n// Returns: number of tokens minted for the beneficiary"
      },
      {
        "type": "table",
        "label": "CHECKING BALANCES",
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
        "text": "Anyone can also inject capital without receiving tokens via addToBalanceOf(). This is useful for grants, donations, or returning funds."
      }
    ]
  },
  {
    "id": "build-tokens-mgmt",
    "part": "Life of a project",
    "title": "Manage tokens",
    "paragraphs": [
      "Tokens start as internal credits. Deploy an ERC-20 whenever you’re ready."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "TOKEN OPERATIONS",
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
        "label": "MINTING & BURNING",
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
    "title": "Distribute",
    "paragraphs": [
      "Projects distribute funds through payouts and reserved tokens. By default anyone can trigger distribution; the ownerMustSendPayouts ruleset flag restricts payouts to the owner or an operator with SEND_PAYOUTS permission."
    ],
    "blocks": [
      {
        "type": "code",
        "label": "JBMultiTerminal.sendPayoutsOf (call outline)",
        "code": "sendPayoutsOf(\n  projectId,\n  token,\n  amount,              // up to the payout limit\n  currency,\n  minTokensPaidOut     // slippage protection\n)\n// Distributes to splits, leftover to project owner\n// 2.5% protocol fee on payouts, except same-terminal project payouts and eligible feeless recipients"
      },
      {
        "type": "code",
        "label": "JBController.sendReservedTokensToSplitsOf (call outline)",
        "code": "sendReservedTokensToSplitsOf(projectId)\n// Anyone can call this at any time\n// Mints accumulated reserved tokens and distributes to splits"
      },
      {
        "type": "table",
        "label": "TRACKING USAGE",
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
        "text": "sendPayoutsOf() is permissionless by default. ownerMustSendPayouts restricts it to the owner or a SEND_PAYOUTS operator. A payout to another project through a different, non-feeless terminal still incurs the standard fee."
      }
    ]
  },
  {
    "id": "build-cashout",
    "part": "Life of a project",
    "title": "Cash out",
    "paragraphs": [
      "Token holders can cash out tokens against the project’s current surplus under its tax, hook, and fee settings. In a single accounting context, surplus is the terminal balance above the remaining payout limit. Read a hook-aware quote for the actual transaction.",
      "At 0% cash out tax the core formula returns a proportional share before fees. Higher rates reduce the amount returned to a holder cashing out part of the supply; at 100% it returns zero. The tax is separate from protocol and hook fees."
    ],
    "blocks": [
      {
        "type": "code",
        "label": "JBMultiTerminal.cashOutTokensOf (call outline)",
        "code": "cashOutTokensOf(\n  holder,\n  projectId,\n  cashOutCount,         // how many tokens to burn\n  tokenToReclaim,       // which token to receive\n  minTokensReclaimed,   // slippage protection\n  beneficiary,          // who receives the funds\n  metadata\n)"
      },
      {
        "type": "diagram",
        "label": "BONDING CURVE",
        "lines": [
          "  For taxRate below MAX:",
          "  reclaim = surplus × (cashOutCount / totalSupply)",
          "         × [(MAX - taxRate) + taxRate × (cashOutCount / totalSupply)]",
          "         ÷ MAX",
          "",
          "  taxRate = 0%    → full proportional redemption",
          "  taxRate = 100%  → returns zero (separate contract branch)"
        ],
        "description": "Below 100% tax, multiply surplus by the holder’s supply share, then by the curve adjustment shown. A 0% tax is proportional. At 100% tax the contract returns zero, and protocol or hook fees are separate."
      },
      {
        "type": "info",
        "text": "For non-feeless beneficiaries, a nonzero cash out tax normally makes the full direct reclaim eligible for the 2.5% protocol fee. At zero tax, only min(reclaimed, feeFreeSurplusOf) is eligible. Hooks and routing affect the final quote."
      }
    ]
  },
  {
    "id": "build-evolve",
    "part": "Life of a project",
    "title": "Evolve",
    "paragraphs": [
      "Projects evolve by queuing new rulesets. A timed ruleset changes at an eligible cycle boundary. A flexible ruleset can change without a cycle boundary, but any configured start time, notice, or approval still applies."
    ],
    "blocks": [
      {
        "type": "code",
        "label": "JBController.queueRulesetsOf (call outline)",
        "code": "queueRulesetsOf(\n  projectId,\n  rulesetConfigurations[],  // new parameters\n  memo\n)\n// If an approval hook is configured, it must approve\n// the changes before they can activate."
      },
      {
        "type": "table",
        "label": "INSPECTING QUEUED CHANGES",
        "rows": [
          [
            "JBController.latestQueuedRulesetOf(projectId)",
            "Latest ruleset in the queue and its approval status (may already be the active one)"
          ],
          [
            "JBController.allRulesetsOf(projectId, startingId, size)",
            "Complete ruleset history"
          ]
        ]
      }
    ]
  },
  {
    "id": "build-revnet-what",
    "part": "Life of a revnet",
    "title": "What’s a revnet?",
    "paragraphs": [
      "A revnet is a Juicebox project owned by REVOwner, which locks its staged economic parameters at launch. Its operator retains specific permissions: review these alongside the stage schedule.",
      "The token is deployed as an ERC-20 at launch. Revenue can back cash outs under the configured terms. Fixed issuance rules do not guarantee revenue or fix the token’s market price.",
      "Revnets use stages to describe their predetermined economic progression. Operator controls can still include split recipients, metadata, buyback settings, router selection, and configured NFT features."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "REVNET vs PROJECT",
        "lines": [
          "  PROJECT",
          "  • owned by a wallet or contract",
          "  • owner can change rulesets",
          "  • manual ERC-20 deploy",
          "  • flexible governance",
          "  • good for: DAOs, collectives",
          "",
          "  REVNET",
          "  • owned by REVOwner contract",
          "  • stages locked at deploy",
          "  • ERC-20 auto-deployed",
          "  • fixed staged economics",
          "  • good for: protocols, tokens"
        ],
        "description": "Projects can be owned by wallets or contracts with ruleset-dependent powers. Revnets use REVOwner, commit the core stage schedule at launch, and deploy their ERC-20 during launch while retaining limited operator controls."
      }
    ]
  },
  {
    "id": "build-revnet-deploy",
    "part": "Life of a revnet",
    "title": "Deploy a revnet",
    "paragraphs": [
      "Deploy with REVDeployer.deployFor():"
    ],
    "blocks": [
      {
        "type": "code",
        "label": "REVDeployer.deployFor (call outline)",
        "code": "deployFor(\n  revnetId,                        // project ID (or 0 for auto)\n  configuration,                   // REVConfig with stages\n  accountingContextsToAccept[],    // tokens the terminal should accept\n  suckerDeploymentConfiguration,   // cross-chain setup\n  tiered721HookConfiguration,      // optional NFT tiers\n  allowedPosts[]                   // optional croptop posts\n)\n// New revnet (revnetId == 0): include the current project creation fee.\n// Existing project ID: send no native value."
      },
      {
        "type": "text",
        "text": "A revnet uses the same core payment and cash out entrypoints as other projects, with REVOwner applying its revnet terms and fee logic. Quote through the configured hooks and inspect the operator’s retained permissions."
      }
    ]
  },
  {
    "id": "build-revnet-stages",
    "part": "Life of a revnet",
    "title": "Stages",
    "paragraphs": [
      "Stages are pre-programmed rulesets. A revnet might start with high token issuance (bootstrapping), then reduce over time (scarcity), and eventually reach a steady state.",
      "Each stage can configure: token weight, weight decay, reserved splits, cash out tax rate, and more. Once deployed, stages progress automatically at their configured boundaries."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "READING STAGE STATE",
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
    ]
  },
  {
    "id": "build-revnet-fees",
    "part": "Life of a revnet",
    "title": "Revnet fees",
    "paragraphs": [
      "Ordinary taxed revnet cash outs can incur both fees below. The revnet fee is skipped for zero-tax cash outs, feeless beneficiaries, or when the fee project has no compatible terminal."
    ],
    "blocks": [
      {
        "type": "steps",
        "items": [
          "2.5% protocol fee — taken from the reclaimed value by JBMultiTerminal, sent to the Juicebox protocol’s project",
          "2.5% revnet fee — REVOwner allocates a share of the token count to the fee calculation and sends its associated reclaim value to the revnet fee project."
        ]
      },
      {
        "type": "text",
        "text": "The protocol fee is based on reclaimed value. The revnet fee is calculated from a share of the token count; its recipient receives the associated reclaim value, not those project tokens. The rates have different bases, so do not simply subtract 5% from a core quote."
      }
    ]
  },
  {
    "id": "build-permissions",
    "part": "Ecosystem tools",
    "title": "Permissions",
    "paragraphs": [
      "Grant fine-grained access to other addresses with JBPermissions. Each permission is a bit in a 256-bit field."
    ],
    "blocks": [
      {
        "type": "code",
        "label": "JBPermissions.setPermissionsFor (call outline)",
        "code": "setPermissionsFor(\n  account,         // the address granting permission\n  permissionsData  // { operator, projectId, permissionIds[] }\n)\n// projectId = 0 is the wildcard: every project `account` controls on this chain"
      },
      {
        "type": "table",
        "label": "CHECKING PERMISSIONS",
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
        "label": "PERMISSION IDS",
        "rows": [
          [
            "1 - ROOT",
            "Grants all permissions. Use with extreme care."
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
            "Mint tokens on-demand."
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
            "Set the buyback hook’s TWAP window."
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
            "Map a token across a sucker pair."
          ],
          [
            "33 - DEPLOY_SUCKERS",
            "Deploy cross-chain suckers for the project."
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
    "title": "NFT tiers",
    "paragraphs": [
      "Deploy tiered NFTs as pay hooks using JB721TiersHook. Payers pick tiers in the pay metadata and receive the NFTs their payment covers."
    ],
    "blocks": [
      {
        "type": "code",
        "label": "JB721TiersHookProjectDeployer.launchProjectFor (call outline)",
        "code": "launchProjectFor(\n  owner,\n  deployTiersHookConfig,    // NFT name, symbol, tiers[]\n  launchProjectConfig,      // standard project config\n  controller,\n  salt                      // CREATE2 salt for a deterministic hook address (0 for none)\n)\n// Always use this deployer, even with empty tiers"
      },
      {
        "type": "table",
        "label": "TIER CONFIGURATION",
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
            "Governance weight (via JB721Checkpoints). Applies only when the tier’s flags.useVotingUnits is set — otherwise voting power tracks the tier price."
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
        "label": "READING NFT STATE",
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
        "text": "Tiers are sorted by CATEGORY, not price. The contract reverts with InvalidCategorySortOrder if submitted out of order."
      }
    ]
  },
  {
    "id": "build-hooks",
    "part": "Ecosystem tools",
    "title": "Custom hooks",
    "paragraphs": [
      "Build custom logic that executes at key moments in the payment lifecycle. Hooks are the primary extension mechanism."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "HOOK INTERFACES",
        "rows": [
          [
            "IJBRulesetDataHook",
            "Intercepts pay and cash out BEFORE state changes. Can override the weight (pay) or the cash out tax rate / effective counts (cash out), and specify pay and cash out hook specifications."
          ],
          [
            "IJBPayHook",
            "Called AFTER payment recorded and tokens minted. Use for rewards, notifications, side effects."
          ],
          [
            "IJBCashOutHook",
            "Called AFTER tokens burned and funds transferred. Use for cleanup, analytics, conditional logic."
          ],
          [
            "IJBSplitHook",
            "Called when a split routes funds to a hook address. Use for auto-investing, compounding, forwarding."
          ],
          [
            "IJBRulesetApprovalHook",
            "Gates queued rulesets. Must return APPROVED before a queued ruleset can activate."
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
        "text": "Data hooks run BEFORE state changes and can override values. Pay and cash out hooks run AFTER and are for side effects only."
      }
    ]
  },
  {
    "id": "build-distributor",
    "part": "Ecosystem tools",
    "title": "Distributor",
    "paragraphs": [
      "JBDistributor is an optional, project-deployed add-on (not part of the core protocol deployment). It distributes ERC-20 rewards to stakers in time-based rounds with linear vesting. Two implementations exist: JBTokenDistributor (for IJBActiveVotes token holders, e.g. a Juicebox JBERC20) and JB721Distributor (for NFT holders).",
      "The distributor is funded via split hooks or direct deposits. Each round, a snapshot captures the distributable balance. Stakers claim their pro-rata share, which vests linearly over a configured number of rounds."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "CORE FUNCTIONS",
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
        "label": "READ STATE",
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
        "text": "A holder’s stake comes from IVotes.getPastVotes() (token distributors) or tier voting units (721 distributors). The TOTAL-stake denominator uses IJBActiveVotes.getPastTotalActiveVotes — which excludes undelegated balances (e.g. AMM-held tokens), so holders must delegate (even to themselves) to count. Rewards are proportional to active stake at the snapshot block."
      }
    ]
  },
  {
    "id": "build-handles",
    "part": "Ecosystem tools",
    "title": "Project handles",
    "paragraphs": [
      "JBProjectHandles maps ENS names to Juicebox project IDs using bidirectional verification. Anyone can propose a handle, but only verified ones (where the ENS text record matches) are returned by handleOf().",
      "All functions take a chainId parameter — handles are chain-aware. Storage is keyed by the setter address, so multiple addresses can propose different handles for the same project."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "HANDLE FUNCTIONS",
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
    "title": "Payer address",
    "paragraphs": [
      "A JBProjectPayer address is deployed as a minimal proxy (clone). The constructor takes only a JBDirectory address. After deployment, defaults are set via initialize() or setDefaultValues().",
      "The receive path accepts the native token (ETH) only. When defaultAddToBalance is false, incoming native ETH triggers pay() — minting tokens for the beneficiary. When true, funds are added via addToBalanceOf() without minting. With no explicit or default beneficiary, the contract resolves the original payer, including supported upstream payer trackers. ERC-20 payments must call pay() or addToBalanceOf() after approval; direct ERC-20 transfers do not trigger either path."
    ],
    "blocks": [
      {
        "type": "code",
        "label": "JBProjectPayer defaults (call outline)",
        "code": "// Set via initialize() after clone deployment:\ndefaultProjectId       // which project to forward to\ndefaultBeneficiary     // who gets the tokens (0 = msg.sender)\ndefaultMemo            // attached to each payment\ndefaultMetadata        // extra data for hooks\ndefaultAddToBalance    // false = pay(), true = addToBalance()\n\n// Anyone sends ETH to the payer address:\n//   → receive() fires\n//   → looks up DIRECTORY.primaryTerminalOf(projectId, token)\n//   → calls pay() or addToBalanceOf() with defaults"
      },
      {
        "type": "info",
        "text": "Terminal lookup happens at payment time via JBDirectory, so the payer address automatically follows terminal migrations without reconfiguration."
      }
    ]
  },
  {
    "id": "build-swap-terminal",
    "part": "Ecosystem tools",
    "title": "Router terminal",
    "paragraphs": [
      "JBRouterTerminal is a universal payment terminal: it accepts any token and automatically converts it into whatever token the destination project accepts, then forwards the result to that project’s primary terminal. It’s a pass-through — it never holds a balance.",
      "There is no fixed output token. For each payment, a JBPayRouteResolver evaluates every token the destination project accepts and picks the route that yields the most project tokens for the payer — choosing among direct forwarding, a Uniswap V3 or V4 swap, a recursive cash out of JB tokens, or a combination. Pools and routes are discovered automatically, not configured per project."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "ROUTER TERMINAL FUNCTIONS",
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
        "text": "The router is reached through JBRouterTerminalRegistry, which is what a project adds to JBDirectory alongside JBMultiTerminal; the registry resolves to JBRouterTerminal. Routing is internal (JBPayRouteResolver) — there is no per-project pool configuration."
      }
    ]
  },
  {
    "id": "build-buyback",
    "part": "Ecosystem tools",
    "title": "Buyback hook",
    "paragraphs": [
      "JBBuybackHook compares the mint price against a Uniswap V4 pool price and routes payments (and cash outs) to whichever gives better value. Slippage tolerance defaults to a TWAP-based sigmoid; a payer can override it with a quote and minimum in the pay metadata."
    ],
    "blocks": [
      {
        "type": "code",
        "label": "JBBuybackHook configuration (call outline)",
        "code": "// Set up the buyback hook with a Uniswap V4 pool\nJBBuybackHook.setPoolFor(\n  projectId,\n  fee,              // Uniswap pool fee tier\n  tickSpacing,      // pool tick spacing\n  twapWindow,       // TWAP observation window (seconds)\n  terminalToken     // the terminal token to route\n)\n// The pool key is once-only; the TWAP window stays mutable via setTwapWindowOf\n// Requires SET_BUYBACK_POOL permission"
      },
      {
        "type": "diagram",
        "label": "BUYBACK DECISION FLOW",
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
        "text": "The hook also handles cash outs: if the pool offers more than the bonding curve reclaim (after fees), it routes the sell through the pool instead. Payers can bypass the TWAP by providing their own quote in payment metadata."
      }
    ]
  },
  {
    "id": "build-bendystraw",
    "part": "Build your own",
    "title": "Indexed data (Bendystraw)",
    "paragraphs": [
      "Bendystraw is the Juicebox indexer: a Ponder service that watches every V6 contract on every supported chain and serves the results over GraphQL. It is how this site lists projects, draws activity feeds and price charts, ranks trending projects, and reads LP positions — none of which are practical to assemble from RPC calls at page-load speed.",
      "Use it for anything a person reads. Use the chain for anything a wallet signs: re-read balances, rulesets, allowances, and quotes onchain right before building a transaction. The index can lag the chain by a few blocks, and a lagging index looks like empty data, not an error."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "ENDPOINTS",
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
        "label": "WHAT TO ASK IT FOR",
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
            "The AMM: pool identity, every trade’s post-trade price, and every LP range"
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
        "text": "Building with an agent? The /jb-bendystraw skill in the Juicebox V6 skills library carries the schema, the query patterns above, and the gotchas — hand it over before asking for a feed, chart, or holder table. Source: github.com/peripheralist/bendystraw."
      }
    ]
  },
  {
    "id": "build-clients",
    "part": "Build your own",
    "title": "Build from this client",
    "paragraphs": [
      "Juicebox Money is a production V6 client you can study, fork, or use as a reference for your own product. Its Next.js interface combines server-assisted indexing and IPFS services with wallet flows that build and verify Juicebox transactions from the current V6 contracts.",
      "Treat each working flow as an implementation example, not a black box. The project, account, shop, and create surfaces show how product interactions map to indexed reads, fresh onchain checks, transaction builders, ABI round trips, and clear signing previews. Give the relevant source and tests to your coding agent when you want to reuse one of those patterns."
    ],
    "blocks": [
      {
        "type": "steps",
        "items": [
          "Start from the product flow closest to yours — such as Pay, Cash Out, project creation, ruleset editing, or the Shop — and identify its component, supporting reads, and transaction builder.",
          "Give your coding agent that source, its tests, this guide’s deep link, the current V6 contract repository below, and the Juicebox V6 skills library (github.com/mejango/juicebox-skills) — a Claude Code plugin whose skills carry the addresses, ABIs, fee math, and transaction-safety rules so the agent does not reconstruct them from memory.",
          "Keep indexed data for fast discovery and display, but re-read signing-critical state onchain immediately before building and submitting a transaction.",
          "Reuse the pure transaction-builder and ABI round-trip pattern, then add product-specific invariants and browser tests before asking a wallet to sign."
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
        "text": "Use the app as a product reference and the repository as the implementation reference. Server routes improve indexing, search, media, and transaction preparation; signing remains explicit, and each wallet-bound action is decoded and checked against the V6 ABI before submission."
      }
    ]
  }
]
