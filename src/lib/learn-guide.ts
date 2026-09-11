import type { GuideSection } from '@/components/GuideSections'

// Keep existing section IDs stable: projects and shared links point directly to these topics.
export const LEARN_SECTIONS: readonly GuideSection[] = [
  {
    "id": "learn-what",
    "title": "What is Juicebox?",
    "paragraphs": [
      "Juicebox lets people fund a project together and set rules for the money. Those rules run as public programs on a blockchain, called smart contracts. Anyone can check them.",
      "A project can give tokens to people who pay. Depending on its rules, holders can exchange those tokens for part of the project’s available funds. This is called a cash out. Other benefits, such as voting or membership, depend on what the project offers. Tokens do not automatically give ownership of the project.",
      "Start with a project’s description and terms. They explain what your payment supports, what you receive, and who can change the rules."
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
            "label": "More ways to use Juicebox"
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
    "title": "How it works",
    "paragraphs": [
      "People pay a project and may receive project tokens. The project sends funds to its chosen recipients through payouts. Token holders can cash out when the rules allow it. Each action needs a transaction; a schedule alone does not send money."
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
          "     └─▶ Give up tokens for available project funds",
          "",
          "  the rules decide how much stays available for cash outs",
          "  check the current quote before cashing out"
        ],
        "description": "Payments can create tokens, payouts send project funds, and cash outs exchange tokens for available funds under the rules."
      },
      {
        "type": "text",
        "text": "The owner sets how much can be paid out, how many tokens payments create, and how cash outs work. These terms and their schedule form a ruleset. The current rules decide which changes the owner can make and when."
      },
      {
        "type": "text",
        "text": "Projects can add features, such as a shop or a way to buy existing tokens from a market. These extensions can change what a payment or cash out does."
      },
      {
        "type": "text",
        "text": "Choose Pay to receive any tokens or items offered. Add to balance puts money into the project without creating project tokens."
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
          "Confirm the project, network, and currency. A project on several networks keeps a separate balance on each one.",
          "Open Rulesets, or Terms for a revnet. Check how many tokens you receive, how the money can be spent, when you can cash out, and which terms can change.",
          "Read the project description and any item terms. Check who manages the project and what your tokens or purchase provide.",
          "Enter an amount and review the result. Keep enough of the network’s currency, such as ETH, to process the transaction. This network cost is called gas. Some payment currencies need a separate spending approval first.",
          "Review the request in your wallet, submit it, and wait for confirmation. If it fails or stays pending, check its status before trying again."
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
    "id": "learn-projects",
    "title": "Projects",
    "paragraphs": [
      "A project has a balance, payment terms, and an owner. Ownership is recorded by a unique token called the project NFT. The wallet or contract holding it owns the project. Supporters’ project tokens are separate.",
      "The current rules decide the owner’s powers. These may include scheduling new terms, choosing recipients, creating more tokens, or changing extensions. Check upcoming terms too: they show what can change next.",
      "Projects can accept ETH and other supported currencies, including stablecoins. A payment may exchange your currency for one the project accepts. A project on several networks has a separate ID and balance on each, with bridges connecting them."
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
            "label": "Who can manage a project"
          },
          {
            "href": "https://github.com/Bananapus/nana-core-v6/blob/main/ADMINISTRATION.md",
            "label": "Who controls the underlying contracts"
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
      "A revnet, short for revenue network, is a Juicebox project that fixes its main financial terms at launch. It commits to a schedule for how many tokens payments create and how cash outs work. Each period in that schedule is a stage.",
      "Later stages can give fewer tokens for the same payment. That fixes the creation rate, not what tokens trade for or what future cash outs will return.",
      "A revnet still has a manager, called its operator, with limited powers. These can include editing its description, choosing recipients for the tokens set aside, and managing allowed extensions. Check its terms to see which controls remain."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "PROJECT vs REVNET",
        "lines": [
          "  PROJECT                         REVNET",
          "  owner can schedule new terms    main financial schedule fixed at launch",
          "  powers depend on rules          limited operator powers remain",
          "  flexible project management     fixed token and cash out schedule"
        ],
        "description": "Project owners can change permitted terms. A revnet commits its core stage schedule at launch while retaining limited operator powers."
      },
      {
        "type": "text",
        "text": "Revnets use Juicebox payments and cash outs. They can also let holders borrow against their tokens. The revnet guide explains its stages, loans, and remaining controls."
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
    "id": "learn-tokens",
    "title": "Tokens",
    "paragraphs": [
      "Creating new project tokens is called issuance, or minting. At a rate of 500 tokens per ETH, a 2 ETH payment creates 1,000 tokens. A zero rate creates none. A market purchase may give you existing tokens instead.",
      "A project can set aside some new tokens for chosen recipients. This is its reserved share. With a 20% share, a payment that creates 1,000 tokens gives 800 to the payer and sets aside 200. Sending those 200 may need a later transaction.",
      "Juicebox can track your tokens directly as credits, or through a transferable token contract using the ERC-20 standard. Both count toward your balance. Once that contract exists, claiming credits converts them to ERC-20 tokens; it does not double your holding."
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
          "  (to payer)          (set aside for recipients)"
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
    "id": "learn-rulesets",
    "title": "Rulesets",
    "paragraphs": [
      "A project’s payment, payout, token, and cash out terms are grouped into a ruleset. Open the Rulesets tab to see the terms in use and what comes next.",
      "A ruleset can repeat in timed cycles. It can give fewer tokens per payment on each repeat. A duration of zero means no repeating cycle: the terms continue until an allowed replacement starts.",
      "New terms wait for any required notice or approval. Timed rulesets also wait for an eligible cycle boundary. Scheduling a change does not make it active."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "KEY PARAMETERS",
        "rows": [
          [
            "Cycle length (duration)",
            "Length of each cycle in seconds. 0 = flexible, continuing until an eligible replacement starts."
          ],
          [
            "Tokens per payment (weight)",
            "Tokens issued per unit of the base currency, before the reserved share. It is an issuance rate, not a market-price promise."
          ],
          [
            "Reduction each cycle (weightCutPercent)",
            "How much the token creation rate decreases each cycle."
          ],
          [
            "Share set aside (reservedPercent)",
            "Share of new tokens set aside for the chosen recipients."
          ],
          [
            "Cash out adjustment (cashOutTaxRate)",
            "Controls how much stays for other holders when someone cashes out. At 0%, the calculation is proportional; at 100%, it returns nothing. See the cash out example below."
          ],
          [
            "Pricing currency (baseCurrency)",
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
      },
      {
        "type": "text",
        "text": "An owner can let another account do a specific task without giving it ownership. That grant is a permission, and the account receiving it is an operator. Some actions, such as sending payouts when the rules allow it, are already open to anyone."
      },
      {
        "type": "text",
        "text": "Permissions have exact names and numbered IDs. For example, SEND_PAYOUTS is #5. ROOT is #1 and grants every Juicebox permission within its scope, but still cannot bypass the project’s rules."
      },
      {
        "type": "text",
        "text": "A grant usually applies to one project. Project ID 0 instead covers every project that the granting account controls on that network. It does not grant power over other owners’ projects."
      },
      {
        "type": "info",
        "text": "Grants belong to the owner who made them. When project ownership changes, the previous owner’s grants no longer give access to that project."
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
    "part": "Going deeper",
    "aliases": [
      "learn-permissions"
    ]
  },
  {
    "id": "learn-cash-outs",
    "part": "Going deeper",
    "title": "Cash outs: what you can receive",
    "paragraphs": [
      "A cash out gives up project tokens for available project funds. Giving up the tokens removes them from the supply; this is called burning. The result depends on today’s balance and terms, so it may differ from what you originally paid.",
      "The funds above the project’s remaining payout limit are its surplus. Cash outs draw from that amount. The rules can leave some of your proportional share for the remaining holders, using a setting called the cash out tax. This amount stays in the project.",
      "For the standard calculation, let S be surplus, x the share of all tokens you are cashing out, and t the tax rate as a fraction. The gross amount is S × x × (1 − t + t × x). At a 100% tax, the contract returns zero. An extension can change the calculation or use a market sale. Use the final quote to see what reaches you."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "Gross calculation: 10 ETH surplus, 1,000 tokens, cash out 100",
        "rows": [
          [
            "Your share",
            "100 ÷ 1,000 = 10% of supply."
          ],
          [
            "At 0% cash out tax",
            "10 × 0.10 = 1 ETH gross."
          ],
          [
            "At 30% cash out tax",
            "10 × 0.10 × (0.70 + 0.30 × 0.10) = 0.73 ETH gross."
          ]
        ]
      },
      {
        "type": "text",
        "text": "A 30% cash out tax is not a flat 30% deduction: the share of tokens being given up also matters. New payments, payouts, token creation, cash outs, and changed terms can all change the next quote. Cash outs may be delayed or disabled, and need available funds."
      },
      {
        "type": "steps",
        "items": [
          "Open Cash out on the network where you hold the tokens.",
          "Enter an amount. Check what you give up, what reaches you, the recipient, and the minimum you will accept. Your holding can include both credits and ERC-20 tokens.",
          "Review the request, submit it, and wait for confirmation. Check whether it exchanges tokens with the project or sells them on a market."
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
            "label": "How the gross amount becomes the final amount"
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
    "title": "Sharing funds: splits and payouts",
    "paragraphs": [
      "A project can share payouts or reserved tokens among chosen recipients. Each recipient’s share is a split. It can go to a wallet, another project, or a contract that takes a further action. Someone must submit the transaction to send it.",
      "A payout limit caps how much can leave through payouts. Limits apply separately to each cycle, currency, payment contract, and network. Funds above the unused limit are surplus. The owner may also have permission to withdraw from surplus, called a surplus allowance.",
      "A recipient’s share can be locked until a date. The owner must preserve it until then, but can extend the lock or add shares within the remaining percentage. Read locked shares, payout limits, and owner allowances together."
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
    "title": "Fees: where they go and what comes back",
    "paragraphs": [
      "Juicebox and Revnet fees are payments to revnets that share their tokens with the people and projects paying them. These tokens can be held or cashed out under the receiving revnet’s terms. The amount depends on its rules and payment route.",
      "The Juicebox fee revnet is project 1, called Juicebox Protocol V6 (JBP6). Revnet’s additional fees support the Revnet Network (REV). The contracts choose who receives tokens for each kind of payment, as shown below.",
      "A normal direct payment has no core Juicebox charge. Network gas and outside exchange costs are separate; they do not automatically pay these revnets. A shop or other extension may add its own costs."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "The charge and who receives its revnet tokens",
        "rows": [
          [
            "Create a project",
            "The current creation charge, up to 0.001 ETH per network, pays the Juicebox fee revnet. Its tokens go to the account paying that charge. Read the current amount before launching."
          ],
          [
            "Send payouts",
            "Usually 2.5% of the amount subject to a fee pays the Juicebox fee revnet. Its tokens go to the project owner."
          ],
          [
            "Use an owner’s surplus allowance",
            "Usually 2.5% of the amount subject to a fee pays the Juicebox fee revnet. Its tokens go to the chosen fee recipient."
          ],
          [
            "Cash out",
            "Usually 2.5% of the amount subject to a fee pays the Juicebox fee revnet. Its tokens go to the cash-out recipient, which can differ from the holder."
          ],
          [
            "Cash out from a revnet",
            "When its cash out tax is above zero, an additional amount pays REV. This is calculated from 2.5% of the tokens cashed out. REV tokens go to the holder."
          ],
          [
            "Borrow from a revnet",
            "The quote includes the core withdrawal charge, a 1% REV charge when applicable, and a chosen prepayment of 2.5–50% to the lending revnet. Resulting tokens go to the chosen loan recipient."
          ],
          [
            "Post through Croptop",
            "Except when posting to CPN itself, posting adds 5% of the items’ total price, paid to the Croptop Publishing Network (CPN) revnet. Its tokens go to the chosen fee recipient. Ordinary later shop purchases do not use this posting charge."
          ],
          [
            "Move funds to another payment terminal",
            "The move can incur the core 2.5% charge unless an exemption applies. Check the receiving terminal and quoted result."
          ]
        ]
      },
      {
        "type": "text",
        "text": "The cash out tax is different: it determines how much stays in the original project for remaining holders. A protocol fee pays another revnet. The extra Revnet cash-out fee uses a token amount, while the core fee uses outgoing funds, so they are not a flat 5% combined."
      },
      {
        "type": "table",
        "label": "Worked examples",
        "rows": [
          [
            "A 100 ETH payout, all subject to the core fee",
            "2.5 ETH pays the Juicebox fee revnet and 97.5 ETH goes to payout recipients. The fee payment can return JBP6 tokens to the project owner."
          ],
          [
            "A core cash out quoted at 0.73 ETH gross",
            "If the full amount has a 2.5% charge, 0.01825 ETH pays the fee revnet and 0.71175 ETH reaches the cash-out recipient. This example has no additional extension charge. The earlier cash out section explains the gross calculation."
          ]
        ]
      },
      {
        "type": "text",
        "text": "A fee payment may create revnet tokens or buy existing ones. Some newly created tokens can be set aside for other recipients under that revnet’s rules. Receiving tokens is not a refund or a promise that their value equals the fee."
      },
      {
        "type": "text",
        "text": "Some transfers are exempt, including eligible payments between projects using the same terminal and approved addresses. A transfer immediately forwarded to a non-exempt extension can still be charged. A zero cash out tax can also incur a core charge on funds that arrived through earlier fee-free project payouts. The contract tracks those funds as feeFreeSurplusOf; JBFeelessAddresses records address exemptions."
      },
      {
        "type": "text",
        "text": "An owner can hold eligible payout and allowance fees for 28 days by enabling holdFees. Returning funds with the return-held-fees option can recover a matching part. After the delay, someone must process the remaining fees; time alone does not send them. Revnet tokens arrive when the fee payment is processed. Cash-out fees are never held."
      },
      {
        "type": "text",
        "text": "For a loan, the minimum 2.5% is included in the chosen prepayment, not added again. A larger prepayment buys more time before further time-based charges begin. Repayment costs rise after that period. Check the amount received, total repayment, and 10-year deadline together."
      },
      {
        "type": "text",
        "text": "The recipient must be set for a fee payment to return tokens. A zero recipient means no token reward; a failed core fee payment can credit the funds back to the source project. Read the completed payment to see the actual token result."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "#learn-cash-outs",
            "label": "How the gross cash out amount is calculated"
          },
          {
            "href": "https://revnet.money/learn#fees",
            "label": "Revnet cash out and loan examples"
          },
          {
            "href": "https://github.com/Bananapus/nana-core-v6/blob/main/src/JBMultiTerminal.sol",
            "label": "Core fee rules and recipients"
          },
          {
            "href": "https://github.com/Bananapus/nana-core-v6/blob/main/src/JBProjects.sol",
            "label": "Creation charge and cap"
          },
          {
            "href": "https://github.com/Bananapus/deploy-all-v6/blob/main/script/Deploy.s.sol",
            "label": "Fee revnet configuration"
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
      "Juicebox is a set of public programs, called smart contracts. Different contracts keep track of project ownership, rules, tokens, and money.",
      "The controller manages project rules and tokens. A terminal accepts and manages payments. Other contracts store records, check permissions, or move funds between networks. Their exact names matter when you build an integration."
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
            "Launches projects, schedules rules, and creates or removes tokens."
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
            "Records which accounts can perform each task."
          ],
          [
            "JBTokens",
            "Tracks project tokens as internal credits and, when deployed, an ERC-20 token."
          ],
          [
            "JBRulesets",
            "Stores rules, repeat cycles, token-rate reductions, and required approvals."
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
      },
      {
        "type": "text",
        "text": "A project may move to new contracts when its rules allow it. This is migration. It can replace the controller that manages rules and tokens, or move funds to a different payment terminal."
      },
      {
        "type": "text",
        "text": "The old and new controllers run checks before a handoff completes. A terminal move sends the balance to a contract that accepts the same currency. These checks do not prove the new contract is trustworthy or preserve every old setting."
      },
      {
        "type": "text",
        "text": "The owner or an account with permission starts the move. Check the receiving contract, its settings, and the quoted amount before approving it. Developers use JBDirectory.setControllerOf for a controller and JBMultiTerminal.migrateBalanceOf for a balance."
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
          },
          {
            "href": "#learn-fees",
            "label": "Costs of moving a balance"
          }
        ]
      }
    ],
    "part": "Under the hood",
    "aliases": [
      "learn-migration"
    ]
  },
  {
    "id": "learn-hooks",
    "title": "Extra features: hooks and extensions",
    "paragraphs": [
      "An extension can add a shop, buy tokens from a market, or require approval before rules change. The contract that runs an extension at one of these points is called a hook.",
      "Hooks run within the same transaction as the action they extend. Their powers depend on the hook type and the project’s settings. Check what an enabled hook can change before using the project."
    ],
    "blocks": [
      {
        "type": "table",
        "label": "TYPES OF HOOKS",
        "rows": [
          [
            "Data hook",
            "Helps calculate a payment or cash out before it is recorded. Can change allowed inputs and allocate funds to other hooks."
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
            "Receives a recipient’s share and can use it in another action."
          ],
          [
            "Approval hook",
            "Checks whether scheduled terms may take effect."
          ]
        ]
      },
      {
        "type": "table",
        "label": "BUILT-IN EXTENSIONS",
        "rows": [
          [
            "Buyback hook",
            "Can buy existing tokens from a supported trading pool when its quote beats creating new tokens."
          ],
          [
            "721 tiers hook",
            "Creates collectible shop items when a payment meets their terms."
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
      },
      {
        "type": "text",
        "text": "A payment can buy existing project tokens when that gives you more than creating new ones. The buyback hook compares the normal payment with a supported Uniswap V4 trading pool, where people supply tokens for others to trade."
      },
      {
        "type": "text",
        "text": "The pool needs enough tokens and a usable price history. The hook checks its supported route, not every market. Money left after the purchase can follow the normal token-creation path."
      },
      {
        "type": "text",
        "text": "A cash out can also sell tokens through the supported pool when that gives a better result. The form should show which path it uses and the minimum amount you agree to receive."
      },
      {
        "type": "text",
        "text": "The price can move between your quote and the completed trade. This difference is called slippage. A minimum output sets the least you will accept; the transaction fails if it cannot meet that minimum. A quote alone does not enforce it."
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
    "part": "Under the hood",
    "aliases": [
      "learn-buyback"
    ]
  },
  {
    "id": "learn-omnichain",
    "title": "Projects across chains",
    "paragraphs": [
      "A project can run on Ethereum, Optimism, Base, Arbitrum, or several of them. Each network has its own project ID, token contract, and balance. Always check which network a record belongs to.",
      "To connect networks, bridge contracts move project tokens together with a matching share of the funds backing them. Juicebox calls these contracts suckers. Transfers take separate preparation, delivery, and claim steps.",
      "A transfer needs a supported route and enough available funds. The route fixes which currency on one network matches which currency on the other. Once used, that pairing can be disabled but cannot be changed to a different currency.",
      "Some disabled bridges allow eligible holders to recover funds locally after a delay. Check the route, expected wait, destination claim, and available recovery steps before transferring."
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
      "A project can price its terms in dollars while accepting ETH. It needs an exchange rate to make that conversion. A price feed supplies this rate.",
      "The JBPrices contract looks for a usable project-specific or default feed. A registered feed cannot be replaced; projects may add their own feeds where the rules allow it. A rate in one direction can also be used in reverse.",
      "If no feed provides a usable rate, the action cannot complete. A failed lookup is not a price of zero.",
      "Some networks use a service called a sequencer to order transactions. Feeds that monitor it can pause price-dependent actions during an outage and for a recovery period afterwards."
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
    "id": "learn-nfts",
    "title": "NFT rewards",
    "paragraphs": [
      "A shop can offer unique digital tokens called NFTs. An NFT can record a collectible or access to something the project offers. Read the item’s description to understand what it includes.",
      "Items with the same price, supply, and terms form a tier. A payment creates an item only when its tier is available and the shop’s rules allow it. Some tiers also set aside copies for chosen recipients or carry voting power in a separate voting system.",
      "Artwork and descriptions can be stored on the blockchain or on a shared file network called IPFS. The shop contract, JB721TiersHook, creates the NFTs as part of the payment."
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
            "A link to the artwork and description, often stored on IPFS."
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
      },
      {
        "type": "text",
        "text": "Croptop lets people post content to a project’s shop for supporters to collect as NFTs."
      },
      {
        "type": "text",
        "text": "The project sets who can post, the minimum price, and how many copies can be collected. A post creates a shop tier, or reuses one when its settings match. The poster pays for the first copy; later purchases use the shop’s payment flow."
      },
      {
        "type": "links",
        "items": [
          {
            "href": "https://github.com/mejango/croptop-core-v6",
            "label": "Croptop source"
          },
          {
            "href": "#learn-fees",
            "label": "How posting payments are shared"
          }
        ]
      }
    ],
    "part": "The ecosystem",
    "aliases": [
      "learn-croptop"
    ]
  },
  {
    "id": "learn-loans",
    "title": "Loans",
    "paragraphs": [
      "Eligible revnet holders can borrow funds using their project tokens as security, called collateral. Borrowing removes those tokens from the supply. Repaying before the deadline can restore them.",
      "The loan has its own transferable NFT, which records the debt and the right to recover tokens. The amount you can borrow depends on the revnet’s cash out terms, available funds, currency, and any waiting period.",
      "The quote shows what you receive now and what repayment will cost. Part of the cost is paid up front; choosing a longer prepaid period delays further time-based charges. See the fee section for the calculation and where each part goes.",
      "Repay before the 10-year deadline to recover the applicable tokens. After that, the loan can be closed and those tokens remain removed. Compare the amount you receive, repayment cost, and deadline with a cash out before choosing."
    ],
    "blocks": [
      {
        "type": "diagram",
        "label": "LOAN LIFECYCLE",
        "lines": [
          "  borrow",
          "     └─▶ your tokens are burned as collateral",
          "     └─▶ quoted amount sent to you",
          "     └─▶ you receive a loan NFT as your receipt",
          "",
          "  repay (before 10-year expiry)",
          "     └─▶ return the funds + any time-based fee",
          "     └─▶ the applicable project tokens are restored",
          "",
          "  expiry (after 10 years)",
          "     └─▶ loan written off — collateral stays burned",
          "     └─▶ the borrowed funds are not automatically returned"
        ],
        "description": "Borrowing burns collateral tokens and sends funds after fees. Repayment before expiry can restore the collateral. An expired loan leaves the collateral burned."
      },
      {
        "type": "text",
        "text": "A loan lets you recover tokens through repayment. Whether it suits you better than a cash out depends on the quote, the terms, and when you plan to repay."
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
          },
          {
            "href": "#learn-fees",
            "label": "Loan costs and where they go"
          }
        ]
      }
    ],
    "part": "The ecosystem"
  },
  {
    "id": "learn-distributor",
    "title": "Sharing rewards: distributors",
    "paragraphs": [
      "A project can set up a separate contract to share funded rewards with eligible participants. This is a distributor. Holding project tokens alone does not create rewards.",
      "Each round records who qualifies at a set time, called a snapshot. Rewards then unlock gradually, called vesting. Token-based distributors use records of delegated voting power; NFT-based ones use eligible shop tiers. Check those requirements before assuming you qualify.",
      "You claim unlocked rewards with a transaction. Check the reward currency, available funding, schedule, and claim deadline."
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
    "id": "learn-payer",
    "title": "Project names and payment addresses",
    "paragraphs": [
      "A project can have a dedicated address that forwards ETH sent to it. This is a payer address. Sending other tokens directly to it does not trigger a payment.",
      "The address can pay the project and send project tokens to the chosen recipient, or to the original payer if none is chosen. It can instead add funds without creating tokens. Its owner can change these settings and the destination project, so check them before sending.",
      "The address looks up the project’s current payment terminal. Developers accepting ERC-20 tokens must use its pay or addToBalanceOf function rather than send those tokens directly."
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
      },
      {
        "type": "text",
        "text": "A project can use a name such as myproject.eth instead of only a number. These names come from the Ethereum Name Service, or ENS."
      },
      {
        "type": "text",
        "text": "Use a name you own and add a text record pointing to the project. Then register the link. Anyone can suggest a name, but the name’s record must confirm it."
      },
      {
        "type": "text",
        "text": "Several people can suggest names for the same project. Each app chooses which suggestions to trust."
      },
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
    "part": "The ecosystem",
    "aliases": [
      "learn-handles"
    ]
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
            "ABI",
            "The format software uses to encode contract calls and read their results."
          ],
          [
            "Beneficiary",
            "The address chosen to receive funds, tokens, or another result. It can differ from the payer."
          ],
          [
            "Bridge",
            "A way to move tokens or funds between networks. Delivery and claiming can take separate steps."
          ],
          [
            "Burn",
            "Remove tokens from the supply. Cashing out burns tokens; some loans can restore them after repayment."
          ],
          [
            "Cash out",
            "Give up project tokens for available project funds under the current rules."
          ],
          [
            "Cash out tax",
            "A setting that leaves more funds for remaining holders. It stays in the project; it is not a government tax."
          ],
          [
            "Collateral",
            "Tokens committed to a loan that can be recovered by repaying under its terms."
          ],
          [
            "Controller",
            "The contract that manages a project’s rules and tokens."
          ],
          [
            "Credits",
            "Project tokens tracked directly by Juicebox. They can be transferred within Juicebox when the rules allow, or claimed as ERC-20 tokens once that token contract exists."
          ],
          [
            "ERC-20",
            "A common standard for transferable tokens that wallets and apps can use."
          ],
          [
            "Gas",
            "The network cost of processing a transaction, usually paid in its native currency such as ETH."
          ],
          [
            "Hook",
            "An extension contract that runs during an action, such as a payment or cash out."
          ],
          [
            "Indexer",
            "A service that organizes blockchain records so apps can search and display them."
          ],
          [
            "IPFS",
            "A shared file network where files are identified by their content."
          ],
          [
            "Issuance / minting",
            "Creating new tokens. The issuance rate sets how many a payment creates before any reserved share."
          ],
          [
            "Liquidity / pool",
            "Funds available to trade or withdraw. A trading pool holds tokens for people to exchange."
          ],
          [
            "Metadata",
            "Descriptive information, such as a project’s name, artwork, and links."
          ],
          [
            "Minimum output",
            "The least a transaction must return to succeed. A quote is only an estimate until this limit is enforced."
          ],
          [
            "Network / chain",
            "A blockchain with its own records and balances. A chain ID plus project ID identifies a Juicebox project on it."
          ],
          [
            "NFT",
            "A unique token that can record an item, project ownership, or a loan. Its rights depend on what created it."
          ],
          [
            "Onchain",
            "Recorded or run on a blockchain."
          ],
          [
            "Operator / permission",
            "An account allowed to perform a task, and the grant that allows it."
          ],
          [
            "Payout / split",
            "Funds sent from a project, and the share assigned to each recipient."
          ],
          [
            "Protocol",
            "The shared contracts and rules that apps use to work with Juicebox."
          ],
          [
            "Reserved share",
            "The part of new project tokens set aside for chosen recipients."
          ],
          [
            "Revnet / stage",
            "A project with its main financial schedule fixed at launch, and a period within that schedule."
          ],
          [
            "RPC",
            "A connection that software uses to read a network or submit a transaction."
          ],
          [
            "Ruleset",
            "A project’s terms and the schedule for when they apply."
          ],
          [
            "Safe",
            "A shared wallet that can require several approvals. A proposal must be executed before it changes balances."
          ],
          [
            "SDK",
            "A software library with helpers for building an app."
          ],
          [
            "Slippage",
            "The difference between a quote and the result when a trade completes."
          ],
          [
            "Smart contract",
            "A public program on a blockchain that applies rules to transactions."
          ],
          [
            "Snapshot / vesting",
            "A record of who qualifies at a set time, and a schedule that gradually unlocks rewards."
          ],
          [
            "Surplus",
            "Project funds above the remaining payout limit. Cash outs and any owner surplus allowance draw from it."
          ],
          [
            "Terminal",
            "A contract that accepts and manages a project’s payments and funds."
          ],
          [
            "Testnet",
            "A network for trying transactions with test funds."
          ],
          [
            "Wallet",
            "An app or account used to manage assets and approve requests. Connecting shows your address; a signature approves a particular message or transaction."
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
