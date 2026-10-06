# Security boundaries and operations

> Documentation refreshed for v0.1.21 (5 October 2026). [Current implementation, validation and limits](current-status.md). Dated milestones and design proposals retain their original scope.

## Artifact operations through v0.1.21

The optional Docker adapter requests restrictive Linux execution controls and validates its runtime guard; live verification is explicitly deferred. Its durable ownership registry prevents unrelated-container deletion and blocks uncertain cleanup, but is not a continuous reaper or remote attestation service. Trusted local execution remains suitable only for reviewed code.

Migration 015 stores immutable scoped worker observations separately from backend facts. Codes exclude raw exceptions. Recovery verifies origin/credential/experiment identity and reuses the original submission key; it grants no execution permission. Read-only inspection never contacts the backend. Batch recovery is explicit and finite (up to ten journals), continues past individual failures, and signals unresolved items. Recovery does not imply container cleanup. Preserve private state and see [the operations guide](artifact-recovery.md).

## Enforced by this build

The API denies routes unless a role is explicitly allowed. Configured tokens must be long, unique and assigned to unique identities; exactly one owner is required. A trader identity is bound to one bot. HTTP bodies, identifiers, quantities and monetary values are validated. Helmet headers, non-cacheable responses, request IDs and a per-process rate limit are enabled.

Financial authorisation is outside the learning loop. Owner monetary commands require a separate Ed25519 proof for the exact transaction and a one-time, two-minute challenge. Bots cannot request owner challenges, change ratios, edit budgets or withdraw to the bank. The protected wallet is a separate account in the ledger, not an actual independently custodied wallet yet.

Journal and audit records are append-only at the database trigger level. The application verifies balanced postings and wallet non-negativity; the database also rejects unbalanced journals on commit. A hash chain can detect changes against the recorded chain. A database administrator could replace the whole chain or truncate its tail: external checkpoints and immutable backups are still needed for stronger tamper evidence.

## Isolation that still belongs to deployment

The local `.env` contains all development role credentials and `.local` contains the demo signing key. They are convenient for integration tests, not a production multi-factor authentication system. Filesystem modes on Windows do not substitute for NTFS ACLs. The local owner process and host administrator are trusted.

Research and evaluator workers receive different API credentials. Hermes receives no organisation token; Ruflo's child receives neither organisation nor model credentials. Environment sanitisation and disabled agent tools reduce accidental access, but **same-user subprocesses are not a sandbox**. A malicious dependency could access files the OS identity can read. Production needs separate identities/containers, read-only code images, no core database/owner-key mounts, CPU/memory quotas, and explicit outbound network policy. Docker was not available as a running daemon here, so those boundaries have not been exercised.

For production authentication, replace shared local configuration with a secret manager and independently provisioned short-lived service credentials. Keep the owner signing device outside workers, add hardware-backed user confirmation, plan rotation/revocation, terminate TLS and test the reverse-proxy/rate-limit configuration. Never grant a research worker a DB URL or a credential carrying several roles.

## Evidence and learning threats

Internet text is data, not an instruction source. The current API records source identity, publication time, hash, author and reviewer but does not browse or execute source content. Evidence and lesson authors cannot review their own submissions. Reviewer credentials remain trusted; source approval is not a factual correctness guarantee.

Researchers cannot fetch evaluator holdout data through their API role. This is an API boundary, not a claim that a worker with owner filesystem access cannot read the local database. Evaluation metrics currently trust the provisioned deterministic evaluator. Cross-bot dataset overlap detection, adversarial evaluators, signed dataset manifests, embargoes and external result reproduction are future controls.

Failed and revoked knowledge remains in records; retrieval excludes it from usable lessons/evidence. Retirement marks a bot inactive and preserves its reviewed contributions. No model-generated arbitrary Python/TypeScript strategy is executed in this release.

## Incidents, halts and notifications

Every audited business event also creates a durable owner inbox entry in the same transaction. Fetch `/v1/operations` with the owner role and acknowledge relevant entries. There is no email, Slack, mobile push or autonomous external message sender configured.

A critical incident halts new paper risk. Cancelling reservations and closing existing positions remain possible subject to valid quotes and evidence. Resolution requires verified evidence; resuming is a separate owner action and is refused while critical incidents remain open. Job lease recovery and bounded HTTP retries run automatically. Arbitrary source patching, self-redeployment, incident-court verdicts and permission changes do not.

For a stalled research job, inspect its experiment and incident records; a later matching worker can reclaim an expired lease until the attempt budget is exhausted. Do not replay completed financial work with invented new source references. Reuse the original idempotency key after an uncertain response.

## Local data and backups

Stop the API cleanly before copying a PGlite database directory. Back up the entire directory together with the matching source/migration version, never just balance rows. Store credentials and signing material separately using access controls appropriate to their authority. A local durable restart test has passed; backup restore drills and live PostgreSQL disaster recovery remain untested.

For PostgreSQL, provision a least-privilege application identity and a separate migration role before deployment. The current application runs migrations at startup; multi-instance startup and migration coordination need validation. Retain migration checksums and append a new migration instead of modifying an applied one.

## Dependency controls

Root dependencies and optional integrations are pinned with lockfiles. Ruflo is in a separate package tree; its TOML parser has an explicit reviewed security override. Install with lifecycle scripts disabled for this foundation. No running bot performs `npm install`, downloads a strategy, changes an upstream pin or updates itself.

The production dependency audits recorded in the validation report passed at the time of the build. That is a point-in-time package-advisory check, not a complete code/security audit. Recheck before releasing new images and retain required upstream notices. Optional/native packages omitted from Ruflo's installation were not exercised.
