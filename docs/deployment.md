# Deployment: the backend in a container

Part of **OPS-01** in the [remaining-work assessment](remaining-work-assessment.md). The same image runs on the owner's laptop (Docker Engine inside WSL Ubuntu 24.04) and on a future Linux VM, so moving to the VM is a copy, not a rebuild.

Files: [`Dockerfile`](../Dockerfile), [`.dockerignore`](../.dockerignore), [`compose.yaml`](../compose.yaml). Backups: [`scripts/backup.mjs`](../scripts/backup.mjs), see [security and operations](security-and-operations.md).

## Image

- **Two build stages.** TypeScript compiles in the first. The final image holds only production dependencies, the compiled `backend/dist/src` and `db/migrations`, and is about 94 MB.
- **The Node 24.21.0 base is pinned by digest.** Dependencies install from `package-lock.json` with `npm ci`.
- **The build only sees an allow-list** (`.dockerignore`). `.env`, `.local`, `.data`, integrations, keys and model weights never enter the build context.
- **It runs as the unprivileged `node` user**, with a health check on `/v1/health` and graceful shutdown on `SIGTERM`.
- **Paper mode only.** `APP_MODE=paper` is fixed, and credentials and limits come from the environment when the container starts.

## Run

From WSL or a Linux VM, in the project folder:

```bash
docker compose up -d --build      # reads .env at run time (quotes handled correctly by Compose)
docker compose ps                 # health
docker compose logs backend
docker compose down               # stop; data stays in the paper-data volume
```

**Hardening in `compose.yaml`:**
- read-only root filesystem, with a small `/tmp` held in memory;
- all Linux capabilities dropped, and `no-new-privileges`;
- process and memory limits;
- the port published on **localhost only** (`127.0.0.1:3000`).

Before exposing the API beyond the machine, put a TLS reverse proxy with its own access control in front of it.

Use Compose rather than plain `docker run --env-file .env`. Docker's env-file reader keeps quote characters, so a quoted `PRINCIPALS_JSON` would fail validation, and the backend refuses to start.

## Verified on 13 October 2026

A smoke test ran the image with **throwaway credentials** on a fresh volume, with the compose hardening:
- **Startup:** started in paper mode with live execution off. It runs as `node`, and a write to the root filesystem was refused.
- **Persistence:** wrote a record through the API and restarted the container. The data and the audit chain survived, with the same head hash before and after.
- **Credentials:** a wrong token was refused (401), and too-short credentials stop startup.

The test containers and volume were removed afterwards.

## Moving the live paper database into a container (exercised on a copy, 13 October 2026)

The steps below were run on a restored copy of the real paper database, which was created on Windows. In the Linux container it opened with all 107 audit events, a valid chain and the **same head hash** as the backup manifest (`d1c4b043…458f`). The test container, the volume and the scratch copy were then removed. So the data moves across platforms intact.

1. Stop the Windows API, then run `npm.cmd run backup -- create` and `npm.cmd run backup -- verify <backup>`.
2. Restore into a new folder: `npm.cmd run backup -- restore <backup> .local/restored-paper`.
3. Copy that folder into the volume's `/data/paper`. One way is a one-off container that mounts both, run once while the backend container is stopped.
4. Run `docker compose up -d`, then check `GET /v1/audit/integrity` against the backup's manifest head.

For the real move, take a fresh backup immediately before it and keep the Windows database untouched until the container's audit head has been checked.

## One verification gate and pinned environments (DEP-01)

`npm.cmd run verify` (`scripts/verify-all.mjs`) runs every check and reports one pass or fail. Each suite's log goes to `.local/verify/<suite>.log`. The checks are:
- the secret scan;
- the backend build;
- the full backend test suite;
- the script tests;
- the trading-desk suite (main research environment);
- the skfolio advisor tests (skfolio environment);
- the claims and fact-checker suite.

`--quick` skips the roughly 6-minute backend suite. A broken build stops the gate, and suites whose environment is not installed are reported as skipped. Run it before every push. It first passed in full on 13 October 2026: secret scan, build, 14 script tests, 106 desk tests, 4 advisor tests and 26 claims tests, alongside 165/165 backend tests.

**Pinned environments**, so another machine such as the VM can be rebuilt exactly:

| Environment | Lockfile |
| --- | --- |
| Node | `package-lock.json`; the container base image is pinned by digest |
| skfolio | `integrations/skfolio/requirements.lock` |
| Research (Python 3.12.14) | `integrations/trading-desk/requirements-replay.lock` |

## Still open in OPS-01

- metrics and alerting;
- log retention;
- automatic scheduled backups;
- off-machine backup copies;
- PostgreSQL disaster recovery;
- a TLS proxy for VM exposure.
