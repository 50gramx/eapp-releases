# Network metering: self-reported totals vs. a trusted total (design note)

## Current state (this repo, `tools/aggregate-founders.mjs`)

`data/founders.json`'s `totals` and `peers` blocks are sums of numbers each
node pushes about itself, over a write-only GitHub Contents API credential.
Nothing on the receiving end verifies a node actually did the work it claims:
a node could report any `inferences_served`/`tokens_served`/`receipts_verified`
value it likes. This is fine for a health/activity dashboard — it is explicitly
labeled `"sum of self-reported node counters"` on the page — but it is not
suitable as an input to anything trust-sensitive (payouts, rankings, SLAs).

## What a TRUSTED total would need

`epn-daemon`'s settlement layer (`internal/payment`) already produces
cryptographically signed, chained receipts for metered work
(`payment.NewLocalInferenceReceipt`, `ReceiptsVerified`/`ProofsIssued`
counters in `internal/metrics`). A trusted network total would sum
**receipts**, not self-reported counters:

1. Each node's `report-bootstrap-status.sh` (or a new dedicated reporter)
   would need to publish the receipt chain itself (or a Merkle root of it),
   not just a count — so a third party could independently verify the count
   matches actual signed receipts, not a hand-edited JSON field.
2. The aggregator would need to verify each published receipt/root against
   the node's known DID/public key before including it in a trusted total,
   which means fetching and pinning node identities — a real trust-anchor
   problem the current push-only, unauthenticated-read pipeline doesn't solve.
3. Cross-node receipts (settlement between two nodes) would need
   double-counting rules resolved (an inference receipt exists on both the
   server and client side in some flows) to avoid the network total drifting
   above what was actually served.

## Why this is out of scope here

All three points above are settlement/protocol-adjacent — they'd mean either
changing what the daemon publishes at a protocol level or building real
identity verification into a GitHub-Pages-hosted static aggregator, both of
which are explicitly out of scope for "make the public page honestly reflect
what it measures." The honest fix available today is labeling: this repo now
says "self-reported" everywhere a number could be mistaken for verified, and
a trusted total is left as this follow-up rather than something quietly
implied by better copy.
