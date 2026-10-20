# Obsidian knowledge workspace

Vault: `C:\Users\KeerthanMuniRajaT\Documents\Codex\Knowledge`.

Open `Nexus/Home` in Obsidian. Its links connect the organisation vision, lifecycle, academy, model evaluation, wallet rules and research summaries. Graph view and backlinks use standard Obsidian links; no community plugin, account, cloud service or API key is required.

## Refresh from Command Prompt

From the Nexus project directory:

```bat
npm run knowledge:obsidian -- C:\Users\KeerthanMuniRajaT\Documents\Codex\Knowledge
```

The export is one-way and manually triggered. It copies first-party Markdown under `docs`, root overview/handover files and integration README files. It creates numeric summary cards from historical replay reports, not raw datasets, model responses or bank records. It never copies `.env`, dependencies, model weights, databases or arbitrary runtime files. Documentation itself should not contain secrets; the exporter is an allowlist, not a general secret scanner.

`Nexus/Library` preserves source document paths so Markdown documentation links retain their relative structure. Links to code or other non-exported artifacts still refer to files outside this mirror and may not resolve; those files remain in the code project. `Nexus/Research` holds historical summaries, not independently verified evidence. `Nexus/Notes` is yours to edit. Existing Obsidian settings are untouched.

Generated files are tracked by hashes in `Nexus/.sync-manifest.json`. If you edit one, the next sync reports a conflict and preserves it. Copy your additions into Notes and manually reconcile the source before refreshing. Missing source documents are not deleted automatically; old copies can remain historical. Concurrent edits during export are not coordinated; run one exporter at a time with generated notes closed. The manifest is not a security signature.

This vault is a human knowledge interface. Note edits are never automatically imported and cannot approve evidence, alter permissions, train a model or promote a bot. The existing backend remains authoritative.

## Capture organisation state

With the backend running and exactly one researcher credential configured in `.env`:

```bat
npm run knowledge:organisation -- C:\Users\KeerthanMuniRajaT\Documents\Codex\Knowledge
```

This issues only `GET /v1/bots` and `GET /v1/knowledge`. A new dated folder under `Nexus/Organisation` contains an index and linked bot, lesson and evidence notes. It exports selected identity/state fields, not raw lesson/source content, credentials, wallet balances or private database files. Obsidian graph view displays the links from bot to authored lessons and lesson to evidence. This is a core relationship projection, not the full transfer/assessment graph.

Capture time is recorded as a window because the two requests are not one transactional snapshot. Knowledge responses are capped at 200 evidence and 200 lessons by the backend. Missing related records are labelled, not invented. The exporter refuses more than 1,000 bots, excessive response sizes, unsafe HTTP origins, redirects and symlink output paths.

Snapshots are append-only. They may show knowledge that is later revoked: never use them as current authorisation. Refresh by running the command again and inspect the newest complete folder. `complete.json` is written last; a folder without it is incomplete. No automatic polling or backend mutations occur. Seven focused Obsidian tests cover the mirror, note intake and organisation export with fixture responses; fixture tests do not establish availability of your running backend.

## Prepare and submit a lesson draft

Copy `Nexus/Notes/Lesson template.md` to your own note. Use exactly these four frontmatter properties: `type: nexus-lesson`, `status: draft`, `botId: ACTIVE_BOT_ID`, `evidenceId: VERIFIED_EVIDENCE_UUID`. Values must be plain unquoted identifiers; unsupported/duplicate properties are rejected. The body is the lesson text, limited to 4,000 characters. Inline code, links and other Markdown are text, never executable instructions. The backend evidence ID is mandatory; a note cannot verify its own source.

```bat
npm run knowledge:note -- prepare C:\Users\KeerthanMuniRajaT\Documents\Codex\Knowledge my-lesson.md
```

The note path is relative to `Nexus/Notes`. Preparation is offline and produces a content-addressed snapshot in `.local/obsidian-proposals`, plus a preview of the exact lesson body. It rejects path traversal and linked note paths. Edit the original note and prepare again to create a new snapshot. Existing snapshots are not silently overwritten.

After inspecting the prepared snapshot, explicitly submit it:

```bat
npm run knowledge:note -- submit .local\obsidian-proposals\SNAPSHOT_HASH.json
```

Submission requires the configured backend and exactly one researcher credential in `.env`'s `PRINCIPALS_JSON`. It reads the frozen snapshot, not the changing live note. Only `/v1/lessons` is called. The backend checks the bot and verified supporting evidence; a separate owner/evaluator must then review the proposed lesson. Preparation and submission do not enable workflows or promote bots.

Identical lesson bodies use the same idempotency key, including after a lost response. The receipt is historical; source/evidence revocation still controls whether a reviewed lesson is usable. Hashes detect changes, not a malicious actor who can rewrite files and hashes. There is no automatic note watcher or autonomous ingestion.
