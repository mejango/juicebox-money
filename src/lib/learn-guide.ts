import type { GuideSection } from '@/components/GuideSections'

// Keep existing section IDs stable: projects and shared links point directly to these topics.
export const LEARN_SECTIONS: readonly GuideSection[] = [
  {
    "id": "learn-what",
    "title": "What is Juicebox?",
    "paragraphs": [
      "Juicebox lets people fund a project together and receive incentives in return, under rules for the money that anyone can read. Those rules run as public programs on a blockchain, called smart contracts.",
      "Incentives are tokens. Depending on the rules, holders can return them for a share of the project’s balance sheet. This is a cash out.",
      "A project’s page shows what your payment supports, what you receive, and who can change the rules."
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
            "href": "#learn-glossary",
            "label": "Look up a word"
          }
        ]
      }
    ],
    "part": "The basics"
  },
  {
    "id": "learn-how",
    "title": "How money flows",
    "paragraphs": [
      "People pay a project and receive tokens. The project sends money to its chosen recipients through payouts. Holders cash out when the rules allow."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "THE BASIC LOOP",
        "lines": [
          "  1. Someone PAYS into a project",
          "     └─▶ They receive project tokens",
          "",
          "  2. The project DISTRIBUTES payouts",
          "     └─▶ To team members, partners, other projects",
          "",
          "  3. Token holders can CASH OUT",
          "     └─▶ Return tokens for a share of the balance sheet"
        ],
        "description": "Payments create tokens, payouts send money to chosen recipients, and cash outs return tokens for a share of the balance sheet."
      },
      {
        "type": "text",
        "text": "The owner sets how much can be paid out, how many tokens a payment creates, and how cash outs work. Together these terms are a ruleset."
      },
      {
        "type": "text",
        "text": "Pay gives you tokens or items. Add to balance sends money without creating tokens."
      }
    ],
    "part": "The basics"
  },
  {
    "id": "learn-projects",
    "title": "Projects and owners",
    "paragraphs": [
      "A project has a balance sheet, terms, and an owner. Ownership is a unique token, an NFT: whoever holds it owns the project.",
      "The current ruleset decides what the owner can do: schedule new terms, change recipients, create tokens, or add extras. Upcoming terms show what can change next.",
      "The owner can give another account permission for specific tasks, like sending payouts, without handing over ownership. Some tasks, like sending scheduled payouts, are open to anyone. When ownership changes hands, permissions the previous owner gave stop working.",
      "Projects accept ETH and other currencies, including stablecoins. A project can price its terms in USD while accepting ETH; it uses a price feed to convert."
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
          "  │  sets aside funds ──▶ allows cash outs         │",
          "  │                                                │",
          "  │  public contracts enforce the rules            │",
          "  └───────────────────────────────────────────────┘"
        ],
        "description": "A project accepts payments, issues tokens, holds funds, distributes payouts, and allows cash outs. Its rules decide which actions are available."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "#learn-rulesets",
            "label": "How terms change"
          },
          {
            "href": "/build#build-permissions",
            "label": "Grant a specific permission"
          }
        ]
      }
    ],
    "part": "The basics",
    "aliases": [
      "learn-permissions",
      "learn-prices",
      "learn-architecture",
      "learn-migration"
    ]
  },
  {
    "id": "learn-before-you-pay",
    "part": "The basics",
    "title": "Before your first payment",
    "paragraphs": [
      "Start with a project you recognize."
    ],
    "blocks": [
      {
        "type": "steps",
        "items": [
          "Confirm the project, chain, and currency. A project on several chains keeps a separate balance on each.",
          "Open Rulesets, or Terms for a revnet. Check how many tokens you’ll receive, where the money goes, when you can cash out, and what can change.",
          "Read the project description and any item terms, and check who runs the project.",
          "Enter an amount and review the result. Keep some ETH for gas. Paying with a token like USDC needs an approval first.",
          "Approve in your wallet and wait for confirmation. If it stays pending, check its status before trying again."
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
            "label": "How cash outs work"
          },
          {
            "href": "#learn-tokens",
            "label": "How payment tokens are shared"
          },
          {
            "href": "#learn-rulesets",
            "label": "Which terms can change"
          }
        ]
      }
    ]
  },
  {
    "id": "learn-tokens",
    "title": "Tokens and reserved tokens",
    "paragraphs": [
      "Creating new tokens is called issuance. At 500 tokens per ETH, a 2 ETH payment creates 1,000 tokens. A rate of zero creates none.",
      "A project can set aside part of every new batch for chosen recipients. These are its reserved tokens. With 20% reserved, a payment that creates 1,000 tokens gives 800 to the payer and reserves 200, which are sent to recipients in a later transaction. Revnets call reserved tokens splits.",
      "You can hold tokens as credits inside Juicebox, or as standard ERC-20 tokens that wallets and markets use. Both count toward your balance; claiming turns credits into ERC-20 tokens one for one."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "TOKEN FLOW EXAMPLE",
        "lines": [
          "  payment: 2 ETH",
          "  rate:    500 tokens per ETH",
          "  reserved: 20%",
          "",
          "  tokens created = 1,000",
          "       │",
          "  ┌────┴─────────────────┐",
          "  │                      │",
          "  ▼                      ▼",
          "  800 tokens          200 tokens",
          "  (to payer)          (reserved for recipients)"
        ],
        "description": "At 500 tokens per ETH, paying 2 ETH creates 1,000 tokens. With 20% reserved, 800 go to the payer and 200 to reserved recipients."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "#learn-cash-outs",
            "label": "Cash outs and a worked example"
          }
        ]
      }
    ],
    "part": "Going deeper"
  },
  {
    "id": "learn-rulesets",
    "title": "Rulesets",
    "paragraphs": [
      "A project’s payment, payout, token, and cash out terms are grouped into a ruleset. The Rulesets tab shows the current terms and what comes next.",
      "A ruleset can repeat in cycles, such as every 30 days, and can create fewer tokens per payment each cycle. A ruleset with no cycle lasts until the owner replaces it.",
      "New terms often need notice or approval first, and a cycled ruleset changes only when a cycle ends. Scheduled terms take effect only when they start."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "KEY TERMS",
        "rows": [
          [
            "Cycle length",
            "How long each cycle lasts. None means the terms last until replaced."
          ],
          [
            "Tokens per payment",
            "Tokens created per ETH or USD paid, before reserved tokens."
          ],
          [
            "Cut each cycle",
            "How much tokens per payment drops each cycle."
          ],
          [
            "Reserved tokens",
            "The share of new tokens set aside for chosen recipients."
          ],
          [
            "Cash out tax",
            "How much of a cash out stays behind for remaining holders. 0% is proportional; 100% turns cash outs off."
          ],
          [
            "Pricing currency",
            "ETH or USD. It can differ from what you pay with."
          ]
        ]
      },
      {
        "type": "diagram",
        "label": "RULESET LIFECYCLE",
        "lines": [
          "  schedule terms   notice/approval    cycle ends",
          "       │              checks              │",
          "       ▼                │                  ▼",
          "   SCHEDULED ───▶ APPROVED ──────▶ ACTIVE ──repeats──▶ ACTIVE...",
          "       │                                   ▲",
          "       └── if no notice needed ────────────┘"
        ],
        "description": "Scheduled terms wait for any required notice or approval and for the current cycle to end. Once active, a cycled ruleset repeats until replaced."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "/build#founders-rules-field-by-field",
            "label": "Choose each ruleset setting"
          }
        ]
      }
    ],
    "part": "Going deeper"
  },
  {
    "id": "learn-splits",
    "title": "Payouts and splits",
    "paragraphs": [
      "A project can send money from its balance sheet to chosen recipients. These are payouts, and each recipient’s share is a split. A split can go to a wallet, another project, or a contract that does something with it. Anyone can send scheduled payouts, unless the project limits that to the owner.",
      "A payout limit caps how much can be paid out each cycle, per currency and per chain. Everything above the limit stays on the balance sheet and backs cash outs. The owner can also have an allowance to withdraw beyond payouts.",
      "A split can be locked until a date. Until then the owner can’t remove it, but can extend the lock or add new splits."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "FUND FLOW",
        "lines": [
          "  project balance sheet",
          "       │",
          "  ┌────┴──────────────────────┐",
          "  │                           │",
          "  ▼                           ▼",
          "  scheduled payouts        the rest",
          "  (sent to splits)         (backs cash outs)"
        ],
        "description": "Scheduled payouts go to splits. The rest of the balance sheet backs cash outs."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "/build#founders-running-a-project",
            "label": "Send payouts and manage funds"
          }
        ]
      }
    ],
    "part": "Going deeper"
  },
  {
    "id": "learn-cash-outs",
    "part": "Going deeper",
    "title": "Cash outs",
    "paragraphs": [
      "When you cash out, you return tokens to the project and receive a share of its balance sheet, minus anything already scheduled for payouts. The returned tokens are burned.",
      "The cash out tax leaves part of your share behind for remaining holders. At 0% you get your proportional share; at 100% cash outs are off. In between, bigger cash outs lose less of their share, because the formula also weighs how much of the supply you return."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "Worked example before fees",
        "lines": [
          "  balance 100 ETH, you hold 10% of the supply",
          "",
          "  tax  0%  → cash out returns 10.0 ETH",
          "  tax 20%  → cash out returns  8.2 ETH   (1.8 ETH stays)",
          "  tax 50%  → cash out returns  5.5 ETH   (4.5 ETH stays)",
          "  tax 80%  → cash out returns  2.8 ETH   (7.2 ETH stays)",
          "",
          "  returned = balance × share × ((1 − tax) + tax × share)"
        ],
        "description": "With a balance of 100 ETH and a cash out of 10% of total supply, a 0% tax returns 10 ETH, 20% returns 8.2 ETH, 50% returns 5.5 ETH, and 80% returns 2.8 ETH, before fees. Multiply balance by the share, then by one minus the tax plus the tax times the share."
      },
      {
        "type": "steps",
        "items": [
          "Open Cash out on the chain where you hold the tokens.",
          "Enter an amount, and check what you’ll receive and the minimum you’ll accept.",
          "Approve in your wallet and wait for confirmation."
        ]
      },
      {
        "type": "info",
        "text": "New payments, payouts, and changed terms move the quote, so check the final amount before signing."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "#learn-fees",
            "label": "Fees on cash outs"
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
    "id": "learn-fees",
    "title": "Fees",
    "paragraphs": [
      "Juicebox charges 2.5% when money leaves a project: payouts, allowance withdrawals, and cash outs with a tax above 0%. The fee is a payment into the Juicebox Protocol revnet (JBP6), so it comes back as JBP6 tokens: to the owner for payouts, to the chosen recipient for withdrawals, and to you for cash outs.",
      "Paying a project has no fee. Launching one costs a creation fee of up to 0.001 ETH per chain. A 100 ETH payout sends 2.5 ETH to JBP6 and 97.5 ETH to recipients, and the owner receives JBP6 tokens."
    ],
    "blocks": [
      {
        "type": "links",
        "items": [
          {
            "href": "/build#start-your-first-build",
            "label": "Fee details for builders"
          }
        ]
      }
    ],
    "part": "Going deeper"
  },
  {
    "id": "learn-nfts",
    "title": "Shops",
    "paragraphs": [
      "A project can sell items through a shop. Buying one gives you the item, recorded as an NFT, plus any tokens the project’s rules create.",
      "Items with the same price, supply, and terms form a tier. Some tiers reserve copies for chosen recipients or carry voting power. Owners can add or remove items and mint reserved copies when the shop’s rules allow. Anything physical depends on the seller, so read the item description."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "WHAT EACH TIER SETS",
        "rows": [
          [
            "Price",
            "The minimum payment for one item."
          ],
          [
            "Supply",
            "How many items exist. Once sold out, it’s gone."
          ],
          [
            "Reserved copies",
            "One copy for chosen recipients every N sold."
          ],
          [
            "Voting power",
            "How much each item counts in votes."
          ]
        ]
      },
      {
        "type": "text",
        "text": "Croptop lets people post content to a project’s shop for supporters to collect. The project sets who can post, the minimum price, and how many copies can be collected. Posting adds 5% of the item price, paid to the Croptop Publishing Network revnet (CPN), and the poster chooses who receives its CPN tokens."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "/build#build-nfts",
            "label": "Set up a shop"
          }
        ]
      }
    ],
    "part": "Extras",
    "aliases": [
      "learn-croptop"
    ]
  },
  {
    "id": "learn-hooks",
    "title": "Markets and buybacks",
    "paragraphs": [
      "People can deposit tokens and money into a shared market, called a liquidity pool, for others to trade against. When you pay a project that has one, it checks the pool and buys existing tokens for you when they’re cheaper than new ones. Cash outs work in reverse: if selling to the pool pays more, the cash out sells there, and the review shows the route.",
      "A project can also accept currencies it doesn’t hold directly; the payment converts them first."
    ],
    "blocks": [
      {
        "type": "info",
        "text": "A pool can be empty or too thin for your amount. Set a minimum you’ll accept; the transaction fails rather than paying you less."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "/build#build-buyback",
            "label": "Integrate the buyback"
          },
          {
            "href": "/build#build-hooks",
            "label": "Build your own extension"
          }
        ]
      }
    ],
    "part": "Extras",
    "aliases": [
      "learn-buyback"
    ]
  },
  {
    "id": "learn-omnichain",
    "title": "Projects across chains",
    "paragraphs": [
      "A project can run on Ethereum, Optimism, Base, and Arbitrum at once. Each chain has its own project ID, balance, and tokens.",
      "Moving tokens between chains takes three steps: send from one chain, wait for the bridge, then claim on the other. Your tokens carry their share of the balance with them. Keep the transaction link until you’ve claimed; a confirmed send doesn’t mean the tokens have arrived."
    ],
    "blocks": [
      {
        "type": "links",
        "items": [
          {
            "href": "/build#contracts-sharp-edges",
            "label": "Multichain integration details"
          }
        ]
      }
    ],
    "part": "Extras"
  },
  {
    "id": "learn-revnets",
    "title": "Revnets",
    "paragraphs": [
      "A revnet is a Juicebox project with its token schedule fixed at launch: tokenized incentives backed by a balance sheet. Each period in the schedule is a stage, and later stages can create fewer tokens per payment.",
      "A revnet has no owner who can change its terms. An operator can manage details like its name, recipients, and shop, but can’t change the schedule or withdraw from the balance sheet.",
      "Revnet holders can also borrow against their tokens. The tokens are burned while the loan is open and minted back when it’s repaid within 10 years. Revnets add their own fees on cash outs and loans."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "PROJECT vs REVNET",
        "lines": [
          "  PROJECT                          REVNET",
          "  owner can schedule new terms     schedule fixed at launch",
          "  payouts to a team                contributors receive tokens",
          "  cash outs if the rules allow     cash outs and loans"
        ],
        "description": "A project's owner can schedule new terms and pay a team. A revnet fixes its schedule at launch, pays contributors in tokens, and offers cash outs and loans."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "https://revnet.money/learn",
            "label": "Learn about revnets"
          },
          {
            "href": "https://revnet.money/learn#loans",
            "label": "How loans work"
          },
          {
            "href": "https://revnet.money/learn#fees",
            "label": "Revnet fees"
          }
        ]
      }
    ],
    "part": "Extras",
    "aliases": [
      "learn-loans"
    ]
  },
  {
    "id": "learn-distributor",
    "title": "Reward distributors",
    "paragraphs": [
      "A project can set up a separate contract to share rewards with holders over time. This is a distributor. Rewards come from funds deposited into it; holding tokens doesn’t create them.",
      "Each round records who qualifies at that moment, then unlocks their share gradually. Token holders must delegate their votes, even to themselves, to qualify; NFT holders qualify through eligible shop items. Claim unlocked rewards before the round expires."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "HOW DISTRIBUTION WORKS",
        "lines": [
          "  funds deposited into the distributor",
          "     │",
          "     ▼",
          "  round starts → records who qualifies",
          "     │",
          "     ▼",
          "  each participant’s share begins to unlock",
          "     └─▶ share = your eligible weight / total eligible weight",
          "     └─▶ rewards unlock gradually over time",
          "     │",
          "     ▼",
          "  collect unlocked rewards as rounds pass"
        ],
        "description": "Each round records who qualifies. Their shares unlock over time and must be claimed before expiry."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "/build#build-distributor",
            "label": "Deploy and integrate a distributor"
          }
        ]
      }
    ],
    "part": "Extras"
  },
  {
    "id": "learn-payer",
    "title": "Payment addresses and names",
    "paragraphs": [
      "A project can have its own address that turns any ETH sent to it into a payment, so anyone who can send ETH can fund it. Tokens go to the sender, or to a recipient the owner chose; the owner can also make it add to the balance without creating tokens. Send only ETH: other tokens sent directly to it don’t count as a payment.",
      "A project can use an ENS name, like myproject.eth, instead of a number. The name’s owner adds a record pointing to the project, then registers the link. Apps check the record before showing the name."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "HOW THE PAYMENT ADDRESS WORKS",
        "lines": [
          "  someone sends ETH to the payment address",
          "     │",
          "     ▼",
          "  the address finds the project’s current payment contract",
          "     │",
          "     ├─ default mode",
          "     │  └─▶ pays the project → tokens to the sender or chosen recipient",
          "     │",
          "     └─ \"add to balance\" mode",
          "        └─▶ adds funds to the balance → no tokens created"
        ],
        "description": "ETH sent to the payment address either pays the project, creating tokens for the sender or chosen recipient, or adds to its balance without creating tokens."
      },
      {
        "type": "diagram",
        "label": "SETTING UP A NAME",
        "lines": [
          "  1. own an ENS name (e.g. \"myproject.eth\")",
          "  2. add a \"juicebox\" text record: \"1:42\"  (chain:project)",
          "  3. register the name onchain for your project",
          "  4. apps verify the ENS record matches",
          "  5. your project now shows as \"myproject.eth\""
        ],
        "description": "An ENS name’s juicebox text record identifies a chain and project. Apps check that record before showing the name."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "/build#build-payer",
            "label": "Deploy a payment address"
          },
          {
            "href": "/build#build-handles",
            "label": "Set a project name"
          }
        ]
      }
    ],
    "part": "Extras",
    "aliases": [
      "learn-handles"
    ]
  },
  {
    "id": "learn-glossary",
    "part": "Keep exploring",
    "title": "Glossary and next steps",
    "paragraphs": [
      "Words you’ll see on project pages."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "Common terms",
        "rows": [
          ["Approval", "Permission for a contract to spend a set amount of your token. It’s a separate step before paying with a token like USDC."],
          ["Balance sheet / balance", "The money a project holds."],
          ["Beneficiary", "The address chosen to receive tokens, money, or another result. It can differ from the payer."],
          ["Bridge", "A way to move tokens and their share of the balance between chains."],
          ["Burn", "Destroy tokens. Cash outs burn tokens; revnet loans burn collateral until it’s repaid."],
          ["Cash out", "Return tokens for a share of the balance sheet."],
          ["Cash out tax", "How much of a cash out stays behind for remaining holders."],
          ["Chain", "A blockchain network, such as Ethereum or Base. A chain plus a project ID identifies a project."],
          ["Collateral", "Tokens a revnet holder borrows against."],
          ["Credits", "Tokens held inside Juicebox. Claiming turns them into ERC-20 tokens one for one."],
          ["ERC-20", "The standard token format that wallets and markets use."],
          ["Gas", "The network cost of processing a transaction, usually paid in ETH."],
          ["Incentives", "What a project gives people who pay in. Here, incentives are tokens."],
          ["Issuance", "Creating new tokens, also called minting."],
          ["Minimum", "The least a transaction must return to go through."],
          ["NFT", "A unique token. It can record a shop item, project ownership, or a loan."],
          ["Onchain", "Recorded or run on a blockchain."],
          ["Payout / split", "Money sent from a project, and each recipient’s share of it."],
          ["Permission", "A task the owner lets another account do, without handing over ownership."],
          ["Pool", "A shared market holding tokens and money for trades."],
          ["Price feed", "A source of exchange rates, used to price terms in USD while accepting ETH."],
          ["Reserved tokens", "The share of new tokens set aside for chosen recipients. Revnets call them splits."],
          ["Revnet / stage", "A project with its token schedule fixed at launch, and one period in that schedule."],
          ["Ruleset", "A project’s terms and when they apply."],
          ["Safe", "A shared wallet that needs several approvals. A proposal changes nothing until it’s executed."],
          ["Slippage", "The gap between a quote and the result of a trade."],
          ["Smart contract", "A public program on a blockchain that applies rules to transactions."],
          ["Snapshot / vesting", "A record of who qualifies at a set time, and a schedule that unlocks rewards gradually."],
          ["Testnet", "A network for trying transactions with test money."],
          ["Wallet", "An app that holds your assets and approves transactions."]
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
            "label": "Learn about revnets"
          }
        ]
      }
    ]
  }
]
