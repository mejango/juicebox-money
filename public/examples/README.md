# Examples

The tutorial at `/build/first-payment` displays `read-project.mjs` and
`preview-payment.mjs` exactly as they are here. Edit them here to keep both
copies in sync. The Build guide links to `launch-project.mjs` and `MyPayHook.sol`.

The read example uses Base Sepolia project 1 by default. The simulation example
uses the same project, test ETH, and a public payer address. It sets a minimum of
99% of the quoted tokens, or of the minted tokens if the market price can't load.
The launch example builds a project launch for a public owner address and
simulates it on Base Sepolia, with a balance override that covers the creation
fee in the simulation only. No script signs or sends a transaction. Do not add
private-key handling or a write command to these examples.

To send a payment from an app, pass a fresh simulation's request to the user's
wallet client. The Build guide has the four lines at
`/build#apps-accept-payments`.

## Check the example

Use Node.js 22 or newer and the pinned package versions:

```sh
npm install --save-exact @bananapus/nana-sdk-core@6.5.0 viem@2.55.19
node read-project.mjs
JB_PAYER=0xYourPublicWalletAddress node preview-payment.mjs
JB_OWNER=0xYourPublicWalletAddress node launch-project.mjs
```

Set `BASE_SEPOLIA_RPC_URL` to override the public read gateway. `JB_PROJECT_ID`
can select another project on that network. Show a failed read as a failure;
do not treat it as an empty project.

Before changing package versions or the example project, run all three scripts and
check the chain, controller, ruleset, terminal, minimum output, and decoded call.
The launch example must print `"state": "simulated-only"`, a `nativeValue` equal
to `creationFee`, and a `simulatedProjectId`.
Update the tutorial's verification note with the package versions and observed
block. A successful trial does not mean a payment was sent. The app must refresh
and review its own request before signing.

The app's guide browser tests cover the tutorial at narrow and desktop widths,
including keyboard navigation and reading without JavaScript.

## The hook example

`MyPayHook.sol` is a data hook and a pay hook in one contract. It keeps issuance
unchanged and counts each payer's payments, accepting calls only from a terminal
of its project. It is unaudited example code. Build it with Foundry:

```sh
npm install @bananapus/core-v6
printf '[profile.default]\nsolc = "0.8.28"\nevm_version = "cancun"\nlibs = ["node_modules"]\n' > foundry.toml
mkdir -p src && mv MyPayHook.sol src/ && forge build
```

Rebuild it after changing the contract or the core package version.
