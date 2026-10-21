# Keeping the organisation's data on GitHub (DATA-01)

The work continues on any machine from **two repositories**:

| Repository | Holds |
| --- | --- |
| [KeerthanMuniRaja/Trading-Organisation](https://github.com/KeerthanMuniRaja/Trading-Organisation) (**public** as of 21 Oct 2026; making it private is the owner's choice, B25) | The code, docs and policies. It holds no secrets or data: a secret scan runs before every push |
| [KeerthanMuniRaja/trading-organisation-data](https://github.com/KeerthanMuniRaja/trading-organisation-data) (**private**, created 21 Oct 2026) | The collected data and the database backups |

The public [trading-desk-results](https://github.com/KeerthanMuniRaja/trading-desk-results) repository stays as the
public results page only. Licensed prices, publishers' headlines and the organisation's records never go there.

## What is exported

`scripts/export-data.mjs` copies an **allowlist** of data folders from `.local/` into the data repository's `local/`
folder:
- the newest 4 database backups;
- prices and research (`trading-desk/`), and the regime;
- news feeds, world news, claims and the model-call journal;
- cycles, digests, alerts, readiness and model evaluations;
- feed configurations, the holiday file and the verification reports;
- the organisation-starter plan and the paired-artifact fixtures;
- the state the integrations keep beside their code: `integrations/{hermes,ruflo,skfolio}/.state`. That includes the
  skfolio academy database. It is exported as `state/<name>/`.

**Never exported:**
- `.env` and its backups, `credentials.json` and the owner signing key;
- anything whose name suggests a secret or token;
- logs, the model file, virtual environments and caches;
- file locks (`*.lock`, which only mean "running");
- the knowledge index database, which is rebuilt from the rest.

Every copied text file goes through the project's secret scanner. **Any finding stops the export before anything is
written**, and the findings name the rule, never the secret. Files over 95 MB are skipped and reported, because GitHub
refuses files over 100 MB. `MANIFEST.json` lists every file with its size and SHA-256, the export time and the code
commit.

Exports on 21 Oct 2026:
- **First:** 315 files, 59 MB.
- **Second:** 387 files, 64 MB. It added the integration state, the starter plan and a fresh backup
  (`backup-2026-10-21T10-34-12-608Z`, verified: valid, 399 audit events). The previous backup was older than the
  database's last change.

The secret scan found nothing either time.

## The routine (weekly, after the backup)

```
npm run backup -- create                       (backend stopped)
npm run export-data                            dry run: what would be copied, and the secret scan
npm run export-data -- --write                 mirror into .local/data-repo
git -C .local/data-repo add -A
git -C .local/data-repo commit -m "Data export <date>"
git -C .local/data-repo push
```

The data repository is a clone in `.local/data-repo`. It is inside `.local/`, so the code repository never includes it.

## Continue on a new machine

The data repository's README gives the steps:
1. Clone both repositories.
2. Copy `local/` to `.local/`.
3. Put back your `.env`, credentials and signing key from your own safe copy.
4. Install.
5. Restore the newest backup with `node scripts/backup.mjs restore <backup> .data/paper`. It is verified first.
6. Rebuild the knowledge index.
7. Run `npm run preflight`.

**Keep a safe copy of `.env`, `.local/credentials.json` and `.local/owner-signing-key.pem` yourself,** for example in a
password manager or on an encrypted pen drive. They are deliberately in neither repository.
