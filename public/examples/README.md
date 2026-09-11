# First payment examples

The tutorial at `/build/first-payment` displays these exact downloadable files.
Edit them here to keep both copies in sync.

The read example uses Base Sepolia project 1 by default. The simulation example
uses the same project, test ETH, and a public payer address. It sets a minimum of
99% of the quoted tokens. Neither script signs or sends a payment. Do not add private-key
handling or a write command to these examples.

## Check the example

Use Node.js 22 or newer and the pinned package versions:

```sh
npm install --save-exact @bananapus/nana-sdk-core@2.3.2 viem@2.55.19
node read-project.mjs
JB_PAYER=0xYourPublicWalletAddress node preview-payment.mjs
```

Set `BASE_SEPOLIA_RPC_URL` to override the public read gateway. `JB_PROJECT_ID`
can select another project on that network. Show a failed read as a failure;
do not treat it as an empty project.

Before changing package versions or the example project, run both scripts and
check the chain, controller, ruleset, terminal, minimum output, and decoded call.
Update the tutorial's verification note with the package versions and observed
block. A successful trial does not mean a payment was sent. The app must refresh
and review its own request before signing.

The app's guide browser tests cover the tutorial at narrow and desktop widths,
including keyboard navigation and reading without JavaScript. Center's inspection
route follows the same published Juicescan deployment as its directory; deploy
the new Center route before publishing links that depend on it.
