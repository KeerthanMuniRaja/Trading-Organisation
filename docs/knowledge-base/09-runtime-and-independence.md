# Runtime and Operational Independence

> [Current implementation, validation and limits](../current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

[Home](README.md) · [Repository map](07-repository-map.md) · [Recovery](10-autonomous-recovery-and-notifications.md)

## Owner clarification

We may use open-source projects. The required independence is the ability to run our retained deployment without being stopped solely by deletion of an upstream repository or loss of access to that repository.

This supersedes the earlier possible interpretation that the owner wanted to exclude all open-source infrastructure. We are not required to build every component from scratch.

## Different kinds of dependency

| Dependency | Example | Consequence if unavailable |
|---|---|---|
| Upstream source distribution | Original GitHub repository. | Existing retained code can run; obtaining fresh copies or updates becomes harder. |
| Build/install distribution | Package registry, container registry, native binary download. | A running deployment may continue, while rebuild or restart can fail if artifacts were not retained. |
| Local runtime | Installed framework, database, model files, libraries. | These remain software dependencies, but we operate our own copies. |
| Hosted model service | External inference API. | Affected agents cannot infer unless an approved alternative is available. |
| Market/data service | News feed, exchange, broker, blockchain RPC. | Affected observations or actions become unavailable or uncertain. |
| Infrastructure | Host, network, storage, identity service. | Requires a recovery plan appropriate to that dependency. |

A fork alone is insufficient if normal startup still downloads missing packages, models, plugins, or configuration. A local deployment also does not automatically imply that data stays local: tools and model providers may send requests externally.

## Proposed retention and restoration approach

- Pin tested source, framework, plugin, model, and dependency versions.
- Keep source copies, lockfiles, required binaries, model artifacts where permitted, and deployable images.
- Preserve licences and required notices; check separate component, model, and data terms.
- Record which network connections are needed at build, startup, and normal operation.
- Avoid unreviewed automatic upgrades and runtime downloads for required components.
- Maintain approved update, migration, backup, and rollback procedures.
- Test cold restart and rebuild with upstream repository access unavailable.
- Separately test failure of each runtime service and document the resulting degraded behaviour.

Independence is demonstrated by restore tests, not just by having a GitHub fork.

## Hermes and Ruflo: intended evaluation

The owner accepts both projects as potential building blocks. The recommended starting design from the discussion is Hermes for agent execution and selected Ruflo functionality for coordination or routing. This is an architectural proposal, not a completed integration or final dependency selection.

Hermes offers tools, skills, memory, delegation, and programmatic interfaces for external applications. Ruflo contributes coordination and feedback mechanisms. They overlap in scheduling, task management, memory, and delegation, so the integration must assign a single authority for each shared responsibility.

Hermes can consume MCP tools and Ruflo exposes an MCP server. That is a plausible interface route, not proof of end-to-end compatibility.

Our application would own the organisation-specific user experience, evidence schema, qualification records, recovery state, and policy decisions. Framework-specific details should sit behind interfaces where practical, allowing replacement if a dependency becomes unsuitable.

Sources: [Hermes architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture), [application interfaces](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration), [MCP integration](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp), [Ruflo](https://github.com/ruvnet/ruflo).

## Models and proprietary knowledge

Using a framework does not determine which model we use or make its base model unique. We can combine existing models with our own workflows, knowledge, evaluations, and eventually qualified custom model versions.

Do not confuse local framework operation with local inference. Model hosting, data privacy, provider terms, and retained training artifacts are separate open decisions.

## Evaluation before adoption

Compare a small team with and without additional coordination features on the same research task. Measure evidence quality, task completion, cost, latency, duplicate work, state recovery, and permission enforcement.

Test actual negative and positive feedback behaviour before using it for fitness decisions. Treat a framework's scores and learning features as mechanisms to verify, not a substitute for our academy or court.

## Licence references

The reviewed Hermes and Ruflo licence files use MIT terms. Required notices remain part of retained distributions. A maintainer ceasing work does not repair bugs in our copy; we must plan maintenance.

Sources: [Hermes licence](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE), [Ruflo licence](https://github.com/ruvnet/ruflo/blob/main/LICENSE).

Detailed repository observations, including the historical Ruflo audit and its recorded remediation, are in the [repository map](07-repository-map.md).

<!-- documentation-navigation -->
[Documentation index](../documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
