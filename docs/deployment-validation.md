# Deployment configuration validation

`npm run env:check:all` checks the environment inherited by its Node process. It
does not automatically load `.env` files. The release workflow supplies the
public settings from GitHub repository variables and sets `NEXT_PUBLIC_VERSION`
to `github.sha`. The Docker build supplies the same settings as build arguments;
its revision can also come from `RAILWAY_GIT_COMMIT_SHA`.

`.env.example` contains the public indexer endpoints and development Para
configuration. Its localhost site URL and `local` version are deliberate
development defaults. Production validation requires an HTTPS site origin and
an identifiable revision. Next's development environment loading does not turn
these defaults into a release configuration.

For a local configuration check of the Juicebox deployment, load the example
defaults, overlay local settings, and supply the production origin already
declared in `src/providers/para-config.ts` and `src/providers/wallet-connectors.ts`:

```sh
NEXT_PUBLIC_SITE_URL=https://juicebox.money \
NEXT_PUBLIC_VERSION="$(git rev-parse HEAD)" \
node --env-file=.env.example --env-file-if-exists=.env \
  scripts/check-deployment-env.mjs all
```

Process environment values take precedence over the files. This command checks
configuration without changing either file or contacting the configured
services. It does not verify that credentials are accepted by those services.
For a different deployment, supply its configured HTTPS origin. A release should
use the public settings supplied by its deployment platform and the revision
being built.
