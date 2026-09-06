import type { GuideSection } from '@/components/GuideSections'

// Keep existing section IDs stable: projects and shared links point directly to these topics.
export const LEARN_SECTIONS: readonly GuideSection[] = [
  {
    "id": "learn-what",
    "title": "What is Juicebox?",
    "paragraphs": [
      "Juicebox lets people collect and manage funds together. A project accepts blockchain payments, can issue its own tokens, and sends funds to recipients under rules that anyone can inspect.",
      "A project token records participation. It can let its holder exchange tokens for part of the project’s available funds, called a cash out. Voting, membership, and other benefits depend on what the project has actually set up; receiving a token does not automatically give you those benefits or ownership of the project.",
      "You can explore projects and read their terms without connecting a wallet. To pay or launch, connect a wallet on a supported network and keep enough of that network’s native token, such as ETH, to pay the transaction fee (gas). The payment form shows which tokens and routes that project currently accepts."
    ],
    "blocks": [
      {
        "type": "links",
        "items": [
          {
            "href": "/",
            "label": "Explore projects"
          },
          {
            "href": "#learn-before-you-pay",
            "label": "What to check before paying"
          },
          {
            "href": "/build#founders-launch-from-the-wizard",
            "label": "Launch a project without code"
          },
          {
            "href": "https://github.com/Bananapus/nana-core-v6/blob/main/USER_JOURNEYS.md",
            "label": "Protocol user journeys"
          }
        ]
      }
    ],
    "part": "The basics"
  },
  {
    "id": "learn-how",
    "title": "How it works",
    "paragraphs": [
      "A payment adds funds and may issue project tokens. Payouts send project funds to configured recipients. A cash out exchanges project tokens for funds under the current rules. These actions happen when someone submits a transaction; a payout schedule does not send money by itself."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "THE BASIC LOOP",
        "lines": [
          "  1. Someone PAYS into a project",
          "     └─▶ They may receive project tokens",
          "",
          "  2. The project DISTRIBUTES payouts",
          "     └─▶ To team members, partners, other projects",
          "",
          "  3. Token holders can CASH OUT",
          "     └─▶ Burn tokens, reclaim a share of what’s left",
          "",
          "  surplus = balance above the remaining payout limit",
          "  cash out = a share of surplus, adjusted by the rules and fees"
        ],
        "description": "A payment can issue tokens. Payouts send funds to configured recipients. Token holders can then cash out against surplus under the active terms."
      },
      {
        "type": "text",
        "text": "The project owner configures payout limits, token issuance, and cash out terms. A ruleset is a scheduled set of these terms. Owners may queue later rulesets, subject to the current duration, permissions, and any required notice or approval."
      },
      {
        "type": "text",
        "text": "Optional extensions, called hooks, can change how a payment or cash out works. For example, a shop can issue an NFT, and a buyback hook can buy existing project tokens from a trading pool."
      },
      {
        "type": "text",
        "text": "Paying a project and adding to its balance are different actions. A payment may issue project tokens or shop rewards; adding to balance funds the project without issuing project tokens. Transaction fees paid to the network are separate from Juicebox’s protocol fees."
      }
    ],
    "part": "The basics"
  },
  {
    "id": "learn-before-you-pay",
    "part": "The basics",
    "title": "Before your first payment",
    "paragraphs": [
      "Start with a project you recognize. Its payment form and current terms are the place to check what this particular payment will do."
    ],
    "blocks": [
      {
        "type": "steps",
        "items": [
          "Confirm the project, network, and payment token. A multichain project has different balances on each network; verify that the route and destination match your intent.",
          "Open Rulesets (or Terms for a revnet). Check current and upcoming issuance, the reserved-token share, payout limits, surplus allowance, cash out tax, and any delay before cash outs are available.",
          "Check who owns or operates the project and which controls remain. Read its description, payment notice, and any shop item terms to understand what the tokens or NFTs provide.",
          "Enter an amount and review the tokens or items you will receive, the minimum output, any swap, and network fees. Keep enough native currency for gas. An ERC-20 payment may first require an approval transaction.",
          "Review the wallet request, submit it, and wait for confirmation. If it fails or remains pending, check the transaction status before submitting again. Your activity and balance should update after confirmation."
        ]
      },
      {
        "type": "links",
        "items": [
          {
            "href": "/",
            "label": "Find a project"
          },
          {
            "href": "#learn-cash-outs",
            "label": "Understand cash out value"
          }
        ]
      }
    ]
  },
  {
    "id": "learn-projects",
    "title": "Projects",
    "paragraphs": [
      "A Juicebox project has an onchain balance and programmable rules. It also has a project NFT: the wallet or contract holding that NFT is the owner. This ownership NFT is separate from the project tokens that supporters receive.",
      "The owner’s powers depend on the current ruleset and permissions. They may include queuing new terms, choosing payout recipients, minting more tokens, or changing extensions. Read both the active and upcoming terms to see what the owner can change and when.",
      "Projects can hold ETH and configured ERC-20 tokens, such as stablecoins. A router can convert other supported payment tokens. Multichain projects have a separate project ID and balance on each network, linked by bridge contracts."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "WHAT A PROJECT DOES",
        "lines": [
          "  ┌───────────────────────────────────────────────┐",
          "  │  YOUR PROJECT                                  │",
          "  │                                                │",
          "  │  accepts payments ──▶ issues tokens            │",
          "  │  holds funds      ──▶ distributes payouts      │",
          "  │  tracks surplus   ──▶ enables cash outs        │",
          "  │                                                │",
          "  │  rules set by owner, enforced by protocol      │",
          "  └───────────────────────────────────────────────┘"
        ],
        "description": "A project accepts payments, issues tokens, holds funds, distributes payouts, and calculates surplus. Its rules determine which actions are available."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "#learn-rulesets",
            "label": "How rules can change"
          },
          {
            "href": "#learn-permissions",
            "label": "Owners and delegated permissions"
          },
          {
            "href": "https://github.com/Bananapus/nana-core-v6/blob/main/ADMINISTRATION.md",
            "label": "Protocol ownership and administration"
          }
        ]
      }
    ],
    "part": "The basics"
  },
  {
    "id": "learn-revnets",
    "title": "Revnets",
    "paragraphs": [
      "A revnet (revenue network) is a Juicebox project whose core economic schedule is committed at launch. Its stages define token issuance, issuance cuts, cash out tax rates, and stage timing. A contract called REVOwner holds the project NFT and restricts changes to that schedule.",
      "A stage can reduce how many tokens a payment receives over time. This fixes the issuance schedule; it does not fix a market price, guarantee future revenue, or guarantee what a token will return in a cash out.",
      "Revnets still have an operator with limited powers, such as updating metadata, directing reserved-token recipients, and managing permitted extensions. The revnet’s terms and enabled extensions show which controls remain."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "PROJECT vs REVNET",
        "lines": [
          "  PROJECT                         REVNET",
          "  owner may queue new terms       core stage schedule committed at launch",
          "  powers depend on rules          limited operator powers remain",
          "  flexible project management     predictable issuance and cash out rules"
        ],
        "description": "Project owners can change permitted terms. A revnet commits its core stage schedule at launch while retaining limited operator powers."
      },
      {
        "type": "text",
        "text": "Projects and revnets share Juicebox’s payment and cash out infrastructure. A revnet also supports loans against project tokens. Read the dedicated guide for stages, fees, operator controls, and loan repayment."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "https://revnet.money/learn",
            "label": "Learn about revnets"
          },
          {
            "href": "https://github.com/rev-net/revnet-core-v6/blob/main/src/REVOwner.sol",
            "label": "REVOwner: permitted operations"
          }
        ]
      }
    ],
    "part": "The basics"
  },
  {
    "id": "learn-rulesets",
    "title": "Rulesets",
    "paragraphs": [
      "A ruleset defines a project’s terms: token issuance, payout limits, cash out tax, and owner powers. The Rulesets tab shows the active ruleset and what is scheduled next.",
      "A ruleset with a nonzero duration repeats until an eligible replacement takes over. An optional issuance cut reduces the tokens issued per unit paid on each repeat. A duration of zero is flexible: it has no repeating cycle and continues until replaced.",
      "For a timed ruleset, replacements start at an eligible cycle boundary. A flexible ruleset can be replaced without waiting for a cycle boundary, but any configured notice or approval still applies. Queuing a ruleset does not mean it is active yet."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "KEY PARAMETERS",
        "rows": [
          [
            "duration",
            "Length of each cycle in seconds. 0 = flexible, continuing until an eligible replacement starts."
          ],
          [
            "weight",
            "Tokens issued per unit of the base currency, before the reserved share. It is an issuance rate, not a market-price promise."
          ],
          [
            "weightCutPercent",
            "How much the weight decreases each cycle (the decay rate)."
          ],
          [
            "reservedPercent",
            "Share of minted tokens set aside for the team/splits."
          ],
          [
            "cashOutTaxRate",
            "Shapes the cash out curve: 0% is proportional; 100% returns no surplus. Separate protocol or extension fees can also apply."
          ],
          [
            "baseCurrency",
            "Currency used to price issuance, commonly ETH or USD. It can differ from the payment token."
          ]
        ]
      },
      {
        "type": "diagram",
        "label": "RULESET LIFECYCLE",
        "lines": [
          "  queue ruleset    approval hook     cycle boundary",
          "       │              checks              │",
          "       ▼                │                  ▼",
          "   QUEUED ──────▶ APPROVED ──────▶ ACTIVE ──cycles──▶ ACTIVE...",
          "       │                                   ▲",
          "       └── if no approval hook ────────────┘"
        ],
        "description": "A queued ruleset waits for any required approval and an eligible start time. Once active, a timed ruleset can repeat until replaced."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "/build#founders-rules-field-by-field",
            "label": "Configure each ruleset field"
          },
          {
            "href": "https://github.com/Bananapus/nana-core-v6/blob/main/src/JBRulesets.sol",
            "label": "Ruleset scheduling source"
          }
        ]
      }
    ],
    "part": "Going deeper"
  },
  {
    "id": "learn-tokens",
    "title": "Tokens",
    "paragraphs": [
      "A payment can issue project tokens according to the ruleset’s issuance rate. For example, a rate of 500 tokens per ETH creates 1,000 tokens for a 2 ETH payment before the reserved share. A zero issuance rate creates no tokens; a buyback route may deliver existing tokens instead.",
      "The reserved percentage sends part of a new issuance to designated recipients. With a 20% reserve, the payer receives 80% and the reserved recipients are allocated 20%. Reserved balances may need a later transaction to distribute them.",
      "Tokens can be held as internal credits or as an ERC-20 token, a standard wallet-transferable token. Both count toward Juicebox balances and supply. Once the project has an ERC-20, a holder can claim their credits as that token without creating an additional economic balance."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "TOKEN FLOW EXAMPLE",
        "lines": [
          "  payment: 2 ETH",
          "  weight:  500 tokens per ETH",
          "  reserved: 20%",
          "",
          "  total minted = 1,000 tokens",
          "       │",
          "  ┌────┴─────────────────┐",
          "  │                      │",
          "  ▼                      ▼",
          "  800 tokens          200 tokens",
          "  (to payer)          (to team splits)"
        ],
        "description": "At 500 tokens per ETH, paying 2 ETH creates 1,000 tokens. A 20% reserve allocates 800 to the payer and 200 to reserved recipients."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "#learn-cash-outs",
            "label": "Cash out value and a worked example"
          },
          {
            "href": "https://github.com/Bananapus/nana-core-v6/blob/main/src/JBTokens.sol",
            "label": "Credits and ERC-20 accounting"
          }
        ]
      }
    ],
    "part": "Going deeper"
  },
  {
    "id": "learn-cash-outs",
    "part": "Going deeper",
    "title": "Cash outs: what you can receive",
    "paragraphs": [
      "Cashing out burns project tokens in exchange for the currently available surplus under the project’s rules. It is not a refund of the original payment. No surplus, a disabled cash out, or an unfinished delay can mean there is nothing available to receive.",
      "For the standard core calculation, let S be surplus, x your fraction of the total token supply, and t the cash out tax written as a fraction. The amount before protocol fees is S × x × (1 − t + t × x). At a 100% tax, the contract returns zero. A data hook can change the inputs or route."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "Example: 10 ETH surplus, 1,000 total tokens, cash out 100 tokens",
        "rows": [
          [
            "Your share",
            "100 ÷ 1,000 = 10% of supply."
          ],
          [
            "At 0% cash out tax",
            "10 × 0.10 = 1 ETH before any applicable protocol fee."
          ],
          [
            "At 30% cash out tax",
            "10 × 0.10 × (0.70 + 0.30 × 0.10) = 0.73 ETH before fees."
          ],
          [
            "After a standard 2.5% protocol fee",
            "0.73 × 0.975 = 0.71175 ETH. This example has no additional hook or revnet fee."
          ]
        ]
      },
      {
        "type": "text",
        "text": "The cash out tax leaves more funds for the remaining token supply. It is a curve parameter, so a 30% setting is not simply a flat 30% deduction from every holder’s proportional share. Payouts, new payments, minting, other cash outs, and changing terms can all change your next quote."
      },
      {
        "type": "steps",
        "items": [
          "Open the project’s cash out action on the network where you hold tokens.",
          "Enter the token amount and check the available surplus, tax, fees, recipient, and minimum output. Credits and ERC-20 balances may both count toward your holding.",
          "Submit the reviewed transaction and wait for confirmation. A market-sale route and a protocol cash out can produce different settlement and fee behavior."
        ]
      },
      {
        "type": "links",
        "items": [
          {
            "href": "https://github.com/Bananapus/nana-core-v6/blob/main/src/libraries/JBCashOuts.sol",
            "label": "Cash out formula in the core contract"
          },
          {
            "href": "#learn-fees",
            "label": "Understand protocol and extension fees"
          },
          {
            "href": "/build#build-cashout",
            "label": "Integrate a cash out"
          }
        ]
      }
    ]
  },
  {
    "id": "learn-splits",
    "title": "Splits & payouts",
    "paragraphs": [
      "Splits direct percentages of payouts or reserved project tokens to a wallet, another project, or a custom contract. A recipient list describes where a distribution goes; someone must still submit the transaction that sends it.",
      "A payout limit caps distributions per ruleset cycle, accounting token, terminal, and chain. Surplus is the balance above the unused payout limit, after currency conversion where needed. Cash outs draw on that surplus. An enabled surplus allowance can also let the owner withdraw from it.",
      "A split locked until a future date must be preserved until its lock expires. Owners can extend its lock and add other splits within the remaining percentage. Inspect locked recipients, payout limits, and allowances together to understand how much money can leave a project."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "FUND FLOW",
        "lines": [
          "  project balance",
          "       │",
          "  ┌────┴──────────────────────┐",
          "  │                           │",
          "  ▼                           ▼",
          "  payout limit             surplus",
          "  (distributed to splits)  (available for cash outs)"
        ],
        "description": "The remaining payout limit reserves part of the balance for payouts. Funds above that limit are surplus, available under the cash out and allowance rules."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "/build#founders-running-a-project",
            "label": "Send payouts and manage funds"
          },
          {
            "href": "https://github.com/Bananapus/nana-core-v6/blob/main/src/JBFundAccessLimits.sol",
            "label": "Payout limits and allowances"
          },
          {
            "href": "https://github.com/Bananapus/nana-core-v6/blob/main/src/JBSplits.sol",
            "label": "Locked split rules"
          }
        ]
      }
    ],
    "part": "Going deeper"
  },
  {
    "id": "learn-fees",
    "title": "Fees",
    "paragraphs": [
      "A normal payment into a project has no core Juicebox protocol fee. Network gas, token swaps, shops, or other extensions may add costs. Launching a project also has a configurable creation fee, at most 0.001 ETH per chain, plus gas.",
      "The core protocol generally charges 2.5% on payouts and surplus-allowance withdrawals. Transfers within the same terminal and eligible fee-exempt recipients are exceptions. Fees fund the Juicebox fee project; token rewards go to the operation’s designated beneficiary when the fee is processed as a payment.",
      "Cash outs with a tax rate above 0% generally incur a 2.5% protocol fee on the reclaimed amount. With a 0% tax, the fee applies only to the portion that arrived through certain fee-exempt project transfers, tracked as feeFreeSurplusOf. A zero cash out tax therefore does not always mean a zero protocol fee. Revnet or other extension fees are additional.",
      "With holdFees enabled, eligible payout and allowance fees are held for 28 days. Adding funds back with the return-held-fees option can return a matching portion. Once the holding period ends, a transaction must process the fees; the passage of time alone does not send them. Cash out fees are never held."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "FEE EXAMPLE",
        "lines": [
          "  100 ETH payout",
          "     └─▶ 2.5 ETH fee",
          "     └─▶ 97.5 ETH distributed to splits",
          "",
          "  if holdFees is on:  fee held 28 days, refundable",
          "  if holdFees is off: fee processed immediately"
        ],
        "description": "For a fully fee-bearing 100 ETH payout, 2.5 ETH is the fee and 97.5 ETH reaches recipients. Eligible held fees can be returned when funds are added back."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "/build#founders-fees",
            "label": "Fee details for project builders"
          },
          {
            "href": "https://github.com/Bananapus/nana-core-v6/blob/main/src/JBMultiTerminal.sol",
            "label": "Fee charging and exceptions"
          },
          {
            "href": "https://github.com/Bananapus/nana-core-v6/blob/main/src/JBProjects.sol",
            "label": "Creation fee cap"
          }
        ]
      }
    ],
    "part": "Going deeper"
  },
  {
    "id": "learn-architecture",
    "title": "Architecture",
    "paragraphs": [
      "Everything you’ve read about so far — projects, rulesets, tokens, splits, fees — each lives in its own smart contract. These contracts are organized in layers.",
      "Surface contracts are what users interact with: the controller orchestrates project operations, and the terminal handles money in and out. Core contracts store the underlying data: who owns what, what the rules are, where funds go. Omnichain contracts move tokens and funds across blockchains."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "CONTRACT LAYERS",
        "lines": [
          "┌──────────────────────────────────────────────────────────────┐",
          "│  SURFACE — what users interact with                          │",
          "│  JBController · JBMultiTerminal · JBTerminalStore            │",
          "├──────────────────────────────────────────────────────────────┤",
          "│  CORE — stores protocol state                                │",
          "│  JBProjects · JBDirectory · JBPermissions · JBTokens         │",
          "│  JBRulesets · JBSplits · JBPrices · JBFundAccessLimits       │",
          "│  JBFeelessAddresses                                          │",
          "├──────────────────────────────────────────────────────────────┤",
          "│  OMNICHAIN — cross-chain connectivity                        │",
          "│  JBSucker · JBSuckerDeployer · JBSuckerRegistry              │",
          "└──────────────────────────────────────────────────────────────┘"
        ],
        "description": "The controller and terminal handle operations; core contracts store identity, permissions, rules, and accounting; sucker contracts connect deployments across chains."
      },
      {
        "type": "table",
        "label": "WHAT EACH CONTRACT DOES",
        "rows": [
          [
            "JBController",
            "The orchestrator. Deploys projects, queues rulesets, mints and burns tokens."
          ],
          [
            "JBMultiTerminal",
            "Handles accepted accounting tokens: payments, cash outs, payouts, and balance additions. A project must configure which tokens it holds."
          ],
          [
            "JBTerminalStore",
            "The bookkeeper. Tracks balances, payout limits, surplus, and cash out math."
          ],
          [
            "JBProjects",
            "Each project is an NFT. Whoever holds the NFT controls the project."
          ],
          [
            "JBDirectory",
            "A phonebook that maps projects to their controller and terminals."
          ],
          [
            "JBPermissions",
            "Fine-grained access control. Grant specific abilities to other addresses."
          ],
          [
            "JBTokens",
            "Tracks project tokens as internal credits and, when deployed, an ERC-20 token."
          ],
          [
            "JBRulesets",
            "Stores and schedules rulesets. Handles cycling, decay, and approval hooks."
          ],
          [
            "JBSplits",
            "Stores payout and reserved token distribution rules."
          ],
          [
            "JBPrices",
            "Converts between currencies (e.g. ETH to USD) using price feeds."
          ],
          [
            "JBFundAccessLimits",
            "Enforces payout limits and surplus allowances."
          ],
          [
            "JBFeelessAddresses",
            "Registry of addresses exempt from protocol fees."
          ]
        ]
      },
      {
        "type": "links",
        "items": [
          {
            "href": "https://github.com/Bananapus/nana-core-v6/blob/main/ARCHITECTURE.md",
            "label": "Architecture and accounting reference"
          },
          {
            "href": "/build#start-the-contracts",
            "label": "Contract roles and deployment addresses"
          }
        ]
      }
    ],
    "part": "Under the hood"
  },
  {
    "id": "learn-hooks",
    "title": "Hooks & extensions",
    "paragraphs": [
      "A \"hook\" is a custom contract that plugs into the protocol at a specific moment — like a callback. When a payment comes in, when tokens are cashed out, or when a ruleset changes, the protocol can call your hook to run custom logic.",
      "Projects can add features like NFT rewards, automatic market buybacks, content publishing, and approval gates without modifying the core protocol. Hooks are optional and composable."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "TYPES OF HOOKS",
        "rows": [
          [
            "Data hook",
            "Intercepts payments or cash outs BEFORE they happen. Can modify amounts, redirect funds, or override behavior."
          ],
          [
            "Pay hook",
            "Runs after a payment is recorded. Can receive allocated funds and perform actions such as minting NFTs."
          ],
          [
            "Cash out hook",
            "Runs after the cash out is recorded and tokens are burned. Can receive allocated funds and perform additional settlement before the transaction completes."
          ],
          [
            "Split hook",
            "Runs when a payout split sends funds to a contract instead of a wallet. Good for auto-investing."
          ],
          [
            "Approval hook",
            "Gates queued rulesets — the hook must approve changes before they can activate."
          ]
        ]
      },
      {
        "type": "table",
        "label": "BUILT-IN EXTENSIONS",
        "rows": [
          [
            "Buyback hook",
            "Automatically buys tokens from a DEX when the market price is better than the mint price."
          ],
          [
            "721 tiers hook",
            "Distributes tiered NFTs to contributors based on payment amount."
          ],
          [
            "Swap terminal",
            "A router terminal converts a supported incoming token into one the project accepts. Available routes depend on configured tokens, pools, and liquidity."
          ],
          [
            "Project handles",
            "Gives projects human-readable names via ENS (Ethereum Name Service)."
          ]
        ]
      },
      {
        "type": "links",
        "items": [
          {
            "href": "/build#build-hooks",
            "label": "Build a custom hook"
          },
          {
            "href": "https://github.com/Bananapus/nana-core-v6/blob/main/src/interfaces/IJBRulesetDataHook.sol",
            "label": "Data hook interface"
          }
        ]
      }
    ],
    "part": "Under the hood"
  },
  {
    "id": "learn-omnichain",
    "title": "Projects across chains",
    "paragraphs": [
      "A project can run on multiple blockchains, such as Ethereum, Optimism, Base, and Arbitrum. Each chain has its own project ID, token contract, and balances. A linked project does not give every address or balance the same meaning on every chain.",
      "Bridge contracts called suckers move project tokens together with a proportional share of backing funds. Native bridges and Chainlink CCIP provide different supported routes. A transfer involves preparation, bridge delivery, and a claim on the receiving chain; it is not instant.",
      "Once a token mapping has been used for a bridge transfer, it cannot be remapped to a different remote token. It can be disabled. Available local liquidity, token mappings, bridge delivery, and the project’s configuration all affect whether a transfer can complete.",
      "If a bridge is deprecated, a configured delay and emergency-exit process can let eligible holders reclaim funds locally. Recovery depends on the bridge’s state and the required transactions. Before moving tokens, check the route, destination, expected delay, and where you will claim them."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "CROSS-CHAIN FLOW",
        "lines": [
          "  Ethereum funds ◄──── sucker ────► Optimism funds",
          "       │                                    │",
          "       └── tokens bridged ──────────────────┘",
          "           funds move proportionally"
        ],
        "description": "Sucker contracts bridge project tokens and a proportional amount of backing between linked deployments. Delivery and claims take separate steps."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "https://github.com/Bananapus/nana-suckers-v6",
            "label": "Sucker bridge source"
          },
          {
            "href": "/build#contracts-sharp-edges",
            "label": "Multichain integration details"
          }
        ]
      }
    ],
    "part": "Under the hood"
  },
  {
    "id": "learn-prices",
    "title": "Price feeds",
    "paragraphs": [
      "Price feeds translate between the currency used to price a project’s terms and the token being paid or withdrawn. For example, a USD issuance rate can be used with an ETH payment if a usable ETH/USD feed is available.",
      "A JBPrices feed registration cannot be overwritten once set. Projects can add project-specific feeds that take priority over protocol defaults, subject to the project’s rules and permissions. Inverse prices allow a feed in one direction to serve the other direction too.",
      "JBPrices tries applicable project and default feeds and fails the dependent transaction when none provides a usable price. A reverted or zero-valued feed may fall through to another configured feed; it should not be displayed as a zero price.",
      "Sequencer-aware feeds on supported L2 deployments also check whether the network’s sequencer is down or still within its recovery grace period. During those periods, transactions requiring that price can be unavailable."
    ],
    "blocks": [
      {
        "type": "links",
        "items": [
          {
            "href": "https://github.com/Bananapus/nana-core-v6/blob/main/src/JBPrices.sol",
            "label": "Price resolution source"
          }
        ]
      }
    ],
    "part": "Under the hood"
  },
  {
    "id": "learn-permissions",
    "title": "Permissions",
    "paragraphs": [
      "Owners can grant specific abilities to other addresses, such as queuing new rulesets or updating metadata, without transferring the project NFT. Some operations, including payouts when the rules permit it, can already be called by anyone.",
      "Each ability has a permission ID. SEND_PAYOUTS is #5 and is required when the ownerMustSendPayouts ruleset flag restricts distributions. ROOT (#1) grants all Juicebox permissions in its scope; it still does not bypass the project’s rules.",
      "Permissions are per-project. Granting someone access to project #5 doesn’t give them any access to project #6. Granting with project ID 0 is the wildcard: it applies to every project the GRANTING account controls on that chain — not to every project the operator touches."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "COMMON PERMISSIONS",
        "rows": [
          [
            "ROOT",
            "All Juicebox permission IDs for the granting account and project scope. It does not transfer the ownership NFT or bypass ruleset restrictions."
          ],
          [
            "QUEUE_RULESETS",
            "Can schedule new rulesets for the project."
          ],
          [
            "MINT_TOKENS",
            "Can mint tokens on-demand (if the ruleset allows it)."
          ],
          [
            "SET_SPLIT_GROUPS",
            "Can change how payouts and reserved tokens are distributed."
          ],
          [
            "SET_PROJECT_URI",
            "Can update the project’s name, description, and logo."
          ],
          [
            "SEND_PAYOUTS",
            "Can trigger payout distributions."
          ],
          [
            "SET_TERMINALS",
            "Can replace the project’s terminal list (ADD_TERMINALS only appends)."
          ]
        ]
      },
      {
        "type": "info",
        "text": "Permissions are granted by a specific account, and every check asks whether the CURRENT owner granted them. If the project NFT moves to a new owner, operators the old owner granted lose their power over the project; the old grants only linger under the old owner’s account."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "/build#build-permissions",
            "label": "Grant a specific permission"
          },
          {
            "href": "https://github.com/Bananapus/nana-core-v6/blob/main/src/JBPermissions.sol",
            "label": "Permission checks"
          }
        ]
      }
    ],
    "part": "The ecosystem"
  },
  {
    "id": "learn-nfts",
    "title": "NFT rewards",
    "paragraphs": [
      "A project’s shop can offer NFTs organized into tiers. Each tier has a price, supply, and category. Selecting an item adds tier-selection metadata to the payment; whether a payment mints an NFT also depends on that tier’s availability and the hook’s settings.",
      "Tiers are grouped by category, and categories must be defined in ascending order. Each tier can also have governance weight (voting power per NFT), reserved NFTs that accrue to a reserve beneficiary as others are minted, and, if the tier allows it, owner minting without payment.",
      "The NFT artwork and metadata can live on IPFS (a decentralized file system) or onchain. This system is powered by a pay hook called JB721TiersHook that automatically mints NFTs when payments come in."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "WHAT EACH TIER DEFINES",
        "rows": [
          [
            "price",
            "Minimum payment to receive this tier’s NFT."
          ],
          [
            "supply",
            "How many NFTs are available in this tier. Once sold out, it’s gone."
          ],
          [
            "category",
            "A grouping number. Tiers must be submitted with categories in ascending order."
          ],
          [
            "reserve frequency",
            "Automatically reserve 1 NFT for the project every N minted. 0 = no reserves."
          ],
          [
            "voting power",
            "How much governance weight each NFT in this tier carries."
          ],
          [
            "metadata",
            "A link to the NFT’s artwork and description (usually an IPFS content hash)."
          ]
        ]
      },
      {
        "type": "info",
        "text": "NFT tiers can be configured at launch and, where the hook and tier rules permit it, adjusted later. Owners may add or remove eligible tiers and mint accrued reserved copies. Read the item’s description and terms to see what collecting it provides."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "https://github.com/Bananapus/nana-721-hook-v6",
            "label": "NFT tier hook source"
          },
          {
            "href": "/build#build-nfts",
            "label": "Configure NFT tiers"
          }
        ]
      }
    ],
    "part": "The ecosystem"
  },
  {
    "id": "learn-croptop",
    "title": "Croptop",
    "paragraphs": [
      "Croptop adds content publishing to a project configured with its posting permissions. Posts become NFT tiers that supporters can collect; availability depends on the project’s posting rules.",
      "The project owner sets rules for what can be posted: minimum price, supply limits, and optionally an allowlist of who can post. Within those rules, posting is open to everyone. Each post creates a new NFT tier, and supporters mint copies by paying into the project.",
      "The publisher takes a 5% fee from the posting payment; the remainder is paid to the project. When an existing tier matches the post’s reuse conditions, it can be reused rather than creating a duplicate. Ordinary later purchases of a tier follow the shop’s payment path."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "HOW CROPTOP WORKS",
        "lines": [
          "  someone publishes content + pays the mint price",
          "     │",
          "     ├─▶ content validated against project’s posting rules",
          "     ├─▶ new NFT tier created for this content",
          "     ├─▶ 5% fee to Croptop protocol",
          "     └─▶ remaining payment → project funds",
          "         └─▶ poster receives the first NFT"
        ],
        "description": "A posting payment is checked against publishing rules, creates or reuses a tier, pays the publisher fee, and sends the remainder to the project. The poster receives the initial NFT."
      },
      {
        "type": "text",
        "text": "Croptop can be combined with projects or revnets. The configured posting rules decide who may publish and what price and supply limits their posts must follow."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "https://github.com/mejango/croptop-core-v6",
            "label": "Croptop source"
          }
        ]
      }
    ],
    "part": "The ecosystem"
  },
  {
    "id": "learn-buyback",
    "title": "Buyback hook",
    "paragraphs": [
      "A buyback hook can route a payment through a configured Uniswap V4 pool to buy existing project tokens when its quote is better than issuing new ones. Any unspent portion can follow the normal issuance path.",
      "A usable pool, liquidity, price observations, and the supplied transaction limits determine which route is available. The hook compares supported routes; it does not search every market or guarantee the best price everywhere.",
      "The hook can also route a cash out through a market sale when the supported pool offers a better result than the protocol cash out. An app should show the expected route and enforce the minimum amount the holder agreed to receive."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "BUYBACK DECISION",
        "lines": [
          "  incoming payment",
          "     │",
          "     ├─ market gives more tokens than minting?",
          "     │  └─▶ swap on the trading pool",
          "     │      └─▶ any leftover amount still minted normally",
          "     │",
          "     └─ minting gives equal or more tokens?",
          "        └─▶ normal mint (no swap needed)"
        ],
        "description": "The hook compares its supported market route with token issuance. It can buy existing tokens when the configured pool gives a better quote and issue tokens with any remaining payment."
      },
      {
        "type": "text",
        "text": "Slippage is the difference between a quote and the price when a transaction executes. The hook has automatic price bounds, and apps can supply explicit minimum outputs. Review the minimum you will receive: a quote is an estimate, while an enforced minimum can make the transaction revert if the result is too low."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "https://github.com/Bananapus/nana-buyback-hook-v6#integration-traps",
            "label": "Buyback routing and minimum outputs"
          },
          {
            "href": "/build#build-buyback",
            "label": "Integrate the buyback hook"
          }
        ]
      }
    ],
    "part": "The ecosystem"
  },
  {
    "id": "learn-loans",
    "title": "Loans",
    "paragraphs": [
      "Eligible revnet token holders can borrow from the revnet using project tokens as collateral. While the loan is open, those tokens are burned. Repayment can restore them; they are not a spendable token balance during the loan.",
      "The loan is represented by a transferable NFT that tracks the debt and collateral. The available amount depends on the revnet’s current cash out terms, available funds, source token, and any cash out delay.",
      "Borrowing deducts the core protocol fee, a 1% REV fee when applicable, and a source-revnet prepaid fee selected between 2.5% and 50%. The minimum 2.5% is part of that selected prepaid fee, not an additional fee on top. A larger prepayment buys a longer period without an additional time-based source fee.",
      "After the prepaid period, the repayment fee grows with time. Repay before the 10-year expiry to recover the applicable collateral. After expiry, anyone can clean up the expired loan and the collateral remains burned. Compare net proceeds, total repayment, and expiry with the cash out quote before choosing either action."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "LOAN LIFECYCLE",
        "lines": [
          "  borrow",
          "     └─▶ your tokens are burned as collateral",
          "     └─▶ funds sent to you from the project (minus fees)",
          "     └─▶ you receive a loan NFT as your receipt",
          "",
          "  repay (before 10-year expiry)",
          "     └─▶ return the funds + any time-based fee",
          "     └─▶ your collateral tokens are re-minted back to you",
          "",
          "  liquidation (after 10 years)",
          "     └─▶ loan written off — collateral stays burned",
          "     └─▶ the borrowed funds are not automatically returned"
        ],
        "description": "Borrowing burns collateral tokens and sends funds after fees. Repayment before expiry can restore the collateral. An expired loan leaves the collateral burned."
      },
      {
        "type": "text",
        "text": "A loan preserves the possibility of recovering tokens through repayment. It does not guarantee a better result than a cash out: fees, the repayment date, and the revnet’s current terms determine the comparison."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "https://revnet.money/learn#loans",
            "label": "Revnet loan walkthrough"
          },
          {
            "href": "https://github.com/rev-net/revnet-core-v6/blob/main/src/REVLoans.sol",
            "label": "Loan fee and repayment source"
          }
        ]
      }
    ],
    "part": "The ecosystem"
  },
  {
    "id": "learn-migration",
    "title": "Migration",
    "paragraphs": [
      "A project can move to compatible controllers or terminals when its current rules and permissions allow it. A controller manages project rules and tokens; a terminal manages accepted funds and payments.",
      "A controller migration runs a handoff between the old and new contracts. A terminal migration moves a balance to a terminal accepting the same token. Compatibility checks are part of the process, but they do not make an arbitrary replacement contract trustworthy or preserve every old accounting setting.",
      "The owner or an authorized operator initiates migration. Changing controllers uses JBDirectory.setControllerOf; moving funds uses JBMultiTerminal.migrateBalanceOf. Check the destination contracts, accounting configuration, and any fee before authorizing the move."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "MIGRATION FLOW",
        "lines": [
          "  CONTROLLER",
          "  1. JBDirectory.setControllerOf(newController)",
          "  2. new controller runs its \"before receive\" check",
          "  3. old controller hands its state over (migrate)",
          "  4. new controller runs its \"after receive\" check",
          "",
          "  TERMINAL",
          "  1. JBMultiTerminal.migrateBalanceOf(to)",
          "  2. balance moves to a terminal that accepts the same token",
          "     (2.5% fee unless the new terminal is feeless)"
        ],
        "description": "Controller migration performs compatibility handoff calls. Terminal migration moves the balance to a compatible terminal and may incur a protocol fee."
      },
      {
        "type": "text",
        "text": "The new controller checks the handoff on both sides, so a controller migration only completes if the receiver accepts it. Terminal migration is a plain balance move."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "https://github.com/Bananapus/nana-core-v6/blob/main/src/JBDirectory.sol",
            "label": "Controller handoff"
          },
          {
            "href": "https://github.com/Bananapus/nana-core-v6/blob/main/src/JBMultiTerminal.sol",
            "label": "Terminal balance migration"
          }
        ]
      }
    ],
    "part": "The ecosystem"
  },
  {
    "id": "learn-distributor",
    "title": "Distributor",
    "paragraphs": [
      "A distributor is an optional extension for sharing funded rewards among eligible participants. It must be deployed, funded, and configured separately; holding a project token alone does not automatically create a reward stream.",
      "Distributions run in rounds with snapshots and gradual vesting. Eligibility depends on the distributor: the ERC-20 version uses delegated voting-power checkpoints, while the NFT version uses qualifying NFT tiers. Check delegation and snapshot requirements before assuming a wallet is eligible.",
      "Rewards unlock over configured rounds, and participants submit a claim to collect them. Check the distributor’s address, funded reward token, round schedule, vesting, and claim expiry."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "HOW DISTRIBUTION WORKS",
        "lines": [
          "  funds deposited into the distributor",
          "     │",
          "     ▼",
          "  round starts → snapshot of eligible checkpoints",
          "     │",
          "     ▼",
          "  participants begin vesting their share",
          "     └─▶ share = your eligible weight / total eligible weight",
          "     └─▶ rewards unlock gradually over time",
          "     │",
          "     ▼",
          "  collect unlocked rewards as rounds pass"
        ],
        "description": "Funds are assigned to reward rounds. Eligible checkpointed participants vest a share over time, then claim before expiry."
      },
      {
        "type": "text",
        "text": "If an NFT is burned while rewards are still vesting, anyone can release the forfeited portion back into the current round — it doesn’t disappear. Unclaimed rounds do expire."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "https://github.com/Bananapus/nana-distributor-v6",
            "label": "Distributor eligibility and claims"
          },
          {
            "href": "/build#build-distributor",
            "label": "Deploy and integrate a distributor"
          }
        ]
      }
    ],
    "part": "The ecosystem"
  },
  {
    "id": "learn-handles",
    "title": "Project handles",
    "paragraphs": [
      "Instead of referring to projects by number (\"project #47\"), you can give yours a human-readable name like \"myproject.eth\" using ENS — the Ethereum Name Service, which works like a phonebook for blockchain addresses.",
      "To set up a handle, you need two things: an ENS name you own, and a text record on that name pointing to your project. This two-way link proves that the name owner actually wants the association — anyone can propose a name for a project, but it only counts if the ENS name confirms it.",
      "Multiple people can propose different names for the same project. Frontends (apps and websites) decide which proposer to trust. This open design means no single gatekeeper controls naming."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "SETTING UP A HANDLE",
        "lines": [
          "  1. own an ENS name (e.g. \"myproject.eth\")",
          "  2. add a \"juicebox\" text record: \"1:42\"  (chain:project)",
          "  3. register the name onchain for your project",
          "  4. apps verify the ENS record matches",
          "  5. your project now shows as \"myproject.eth\""
        ],
        "description": "An ENS name’s juicebox text record identifies a chain and project. A registered handle is verified against that record before an app trusts it."
      },
      {
        "type": "text",
        "text": "Subdomains work too, stored innermost-last: \"sub.myproject.eth\" is stored as [\"myproject\", \"sub\"] — the contract joins the parts in reverse and appends .eth, then verifies the result against the ENS registry."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "https://github.com/Bananapus/nana-project-handles-v6",
            "label": "ENS handle registration"
          },
          {
            "href": "/build#build-handles",
            "label": "Set a project handle"
          }
        ]
      }
    ],
    "part": "The ecosystem"
  },
  {
    "id": "learn-payer",
    "title": "Payer address",
    "paragraphs": [
      "A payer address is a dedicated native-token (ETH) deposit address for your project. Native ETH sent directly to it is automatically forwarded into your project — no extra steps for the sender. ERC-20 tokens sent directly to the address do not trigger a payment.",
      "In payment mode, project tokens go to the configured beneficiary, or to the original payer when no beneficiary is set. In add-to-balance mode, funds enter the project without issuing project tokens. The payer address’s owner can change these defaults, including the destination project: verify its current settings before sending.",
      "The payer address resolves the project’s current terminal, so compatible terminal migrations do not require a new deposit address. Direct ERC-20 transfers do not call its payment logic; integrations must use its explicit pay or addToBalanceOf function for those tokens."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "HOW THE PAYER ADDRESS WORKS",
        "lines": [
          "  someone sends ETH to the payer address",
          "     │",
          "     ▼",
          "  payer address looks up the project’s current terminal",
          "     │",
          "     ├─ default mode",
          "     │  └─▶ pays the project → tokens for the configured beneficiary or payer",
          "     │",
          "     └─ \"add to balance\" mode",
          "        └─▶ adds funds to balance → no tokens minted"
        ],
        "description": "An ETH transfer to the payer address looks up the project’s terminal and either pays the project or adds to its balance, according to the payer address’s configuration."
      },
      {
        "type": "text",
        "text": "This is especially useful for integrations. Any contract, wallet, or payment flow that can send ETH to an address can now fund your project — they don’t need to know anything about Juicebox."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "https://github.com/Bananapus/nana-project-payer-v6",
            "label": "Payer address source"
          },
          {
            "href": "/build#build-payer",
            "label": "Deploy a payer address"
          }
        ]
      }
    ],
    "part": "The ecosystem"
  },
  {
    "id": "learn-glossary",
    "part": "Keep exploring",
    "title": "Glossary and next steps",
    "paragraphs": [
      "Use these definitions when reading a project page or the developer guide."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "Common terms",
        "rows": [
          [
            "Wallet",
            "An app or account used to hold assets and authorize transactions. Connecting it lets the site read your address; signing authorizes a specific action."
          ],
          [
            "Network / chain",
            "A blockchain with its own transactions, balances, and gas. Chain ID plus project ID identifies a Juicebox project deployment."
          ],
          [
            "Gas",
            "The network fee for processing a transaction, normally paid in the chain’s native token."
          ],
          [
            "Ruleset / stage",
            "A set of project terms and its timing. Revnet stages commit an economic schedule at launch."
          ],
          [
            "Issuance / reserved share",
            "New project tokens created by an action, and the part allocated to designated recipients."
          ],
          [
            "Surplus / cash out",
            "Funds above remaining payout limits, and the action that exchanges project tokens for available funds under the rules."
          ],
          [
            "Credit / ERC-20",
            "Two forms of a project-token balance: internal protocol accounting and a standard token contract."
          ],
          [
            "Hook / terminal",
            "An extension contract that adds behavior, and a contract that accepts and manages payments."
          ],
          [
            "Indexer / RPC / SDK",
            "An indexer organizes blockchain data for browsing. An RPC endpoint reads or submits to a chain. An SDK is a software library for building integrations."
          ],
          [
            "Slippage / minimum output",
            "How execution can differ from a quote, and the minimum result a transaction must deliver to succeed."
          ]
        ]
      },
      {
        "type": "links",
        "items": [
          {
            "href": "/",
            "label": "Explore projects"
          },
          {
            "href": "/create",
            "label": "Create a project"
          },
          {
            "href": "/build",
            "label": "Build an app or extension"
          },
          {
            "href": "/audit",
            "label": "Inspect source and audit prompts"
          },
          {
            "href": "https://revnet.money/learn",
            "label": "Explore revnet economics"
          }
        ]
      }
    ]
  }
]
