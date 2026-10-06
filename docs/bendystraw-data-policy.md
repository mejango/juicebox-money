# Bendystraw data policy

Every indexed read follows one production pattern:

1. Execute a committed, static GraphQL document through
   `requestBendystraw`.
   Browser reads send only a SHA-256 persisted-operation ID plus variables to
   the same-origin BFF. The server substitutes a build-registered document and
   rejects unknown IDs, raw documents, extra payload fields, oversized bodies,
   and implicit networks.
2. Resolve mainnet or testnet with the SDK from every `chainId` and
   `chainId_in` in the request. Unknown, contradictory, or mixed networks fail
   closed.
3. Validate bounded variables before sending and recursively validate the
   selected response shape before returning data to product code.
4. Scope project data with the SDK's exact versioned project-reference filters
   and verify returned identities at the response boundary.
5. Use only the SDK cache policies: `live` (15 seconds) for balances, activity,
   permissions, and mutable state; `standard` (30 seconds) for lists, search,
   and aggregates; `stable` (60 seconds) for metadata and historical records.
6. Give every browser read its page's signal: react-query's, or one the page
   aborts when it is left. The request under way then stops, is not retried,
   and none is sent after. `test/components/bendystraw-page-signals.test.ts`
   checks every use of a reader in `src/components` and `src/hooks`.

The Bendystraw transport does not cache. Writes invalidate or bypass affected
reads. An indexed read may fall back to an authoritative RPC read only when the
fallback preserves the same chain/project/account identity and the result is
marked degraded where relevant. A timeout, schema error, or malformed response
must never be converted into zero, an empty list, or a different project's
data.

CI validates every committed document against both live Bendystraw schemas.
Runtime tests must cover invalid variables, malformed nested responses, mixed
networks, unsupported chains, and any identity-scoped fallback.
