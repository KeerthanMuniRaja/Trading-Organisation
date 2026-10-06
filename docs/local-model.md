# Local model runtime — v0.1.32

The owner delegated the model choice on 6 October 2026, asking for the best option. The criteria were:
- Free: no paid API or credits.
- Runnable on the owner's laptop.
- Pinned and retained locally, so an upstream change or deletion cannot alter it (the independence requirement).
- Chosen by measurement on the organisation's own tasks.

## Hardware constraint

The laptop has an Intel Core i7-1355U (2 performance + 8 efficiency cores, 15 W), 15.7 GB RAM (about 2.5 GB free with normal applications open), no CUDA GPU and 310 GB free disk.
- **Qwen3.5-9B** at 4-bit (≈5.6 GB) would swap at that free-memory level.
- **Larger Qwen3.5 models** do not fit.

The current shortlist is **Qwen3.5-4B** and **Qwen3.5-2B**, subject to freeing and measuring RAM. It is not an exhaustive model comparison. The observed free RAM was only about 1.24 GiB during the v0.1.32 review. Weight size alone cannot establish runtime fit. See [model strategy](model-strategy.md) for the recommendation and measured 2B failures.

## Pinned artifacts

[`config/local-model.lock.json`](../config/local-model.lock.json) pins every artifact by URL, exact byte size and SHA-256:

| Artifact | Source | Size | Licence |
| --- | --- | ---: | --- |
| llama.cpp `llama-server`, build b11435, Windows CPU x64 | ggml-org/llama.cpp release asset | 19.4 MB | MIT |
| Qwen3.5-4B Q4_K_M GGUF | `unsloth/Qwen3.5-4B-GGUF` @ `e87f1764` | 2.74 GB | Apache-2.0 |
| Qwen3.5-2B Q4_K_M GGUF | `unsloth/Qwen3.5-2B-GGUF` @ `f6d5376b` | 1.28 GB | Apache-2.0 |

- **Sources:** these are straight quantisations of the official Qwen weights. Fine-tuned, "distilled" and "abliterated" variants were deliberately excluded because their training provenance is unknown.
- **Downloads:** each file streams to a `.part` file and is hashed on the fly. Only an exact size and hash match is kept; anything else is deleted.
- **Storage:** files live in ignored, private `.local/models/`. Keep them: they are the retained copies that make the deployment independent of Hugging Face and GitHub availability.

## Commands

```cmd
npm.cmd run model:local -- install runtime
npm.cmd run model:local -- install qwen3.5-4b-q4km
npm.cmd run model:local -- configure qwen3.5-4b-q4km
npm.cmd run model:local -- serve qwen3.5-4b-q4km
npm.cmd run model:local -- status
npm.cmd run model:doctor -- --probe
npm.cmd run model:benchmark -- --repeats 2 --timeout-seconds 300
```

- **`configure`:** adds or replaces only `HERMES_MODEL`, `HERMES_MODEL_BASE_URL` and `HERMES_MODEL_API_KEY` in the private `.env`. It generates a random local key once and never prints it.
- **`serve`:**
  - Binds `127.0.0.1:8080` only, with a 16k context and the web UI disabled.
  - Thinking is requested off (`--reasoning off`) to reduce generation cost; this does not guarantee strict JSON or correct answers. `--reasoning-format deepseek` routes any stray reasoning away from the reply content.
  - The key reaches the server through `LLAMA_API_KEY` in its environment, not the visible command line.
  - It runs in the foreground until Ctrl+C. Logs: `.local/models/server-<model>.log`.
- **Checked behaviour:** requests without the key, or with a wrong key, receive 401, and the server is not reachable from the machine's network address.

This sets up model *serving* only. `HERMES_ENABLED`, the Hermes checkout and the owner development policy remain unchanged, so no organisation worker uses the model until those are deliberately enabled.

## Production timeouts on slow hardware

At the measured CPU speeds, a full assessment prompt takes over a minute, longer than the original 45-second Hermes run budget. v0.1.31 adds an optional `HERMES_TIMEOUT_SECONDS` (70–540; default 70, unchanged). Each task stays capped by its ticket's lifetime:

| Task | Ticket lifetime | Timeout cap |
| --- | --- | ---: |
| Momentum candidate | 120 s job lease | 70 s |
| R&D capability | 180 s | 150 s |
| Knowledge, source lesson, assessment | 10 min or more | 540 s |

The agent run budget is the timeout minus 25 s, and each API call gets the timeout minus 30 s. At 70 s these are exactly the original 70/45/40.

## Benchmark results

The saved 2B direct run failed both source-lesson contracts and one assessment output. Corrected offline regrading found only one complete valid pair, with poor numerical scores. Newer 4B free-form and constrained direct reports are available. The constrained run passed the six tested format contracts but scored 0/16 on drawdown; production Hermes qualification is still open. See [selection evidence](model-selection.md). See [model strategy](model-strategy.md) and [verification](verification.md).

Hermes benchmark timeout overrides now reach the adapter, but the 70-second candidate and 150-second capability caps still apply. Use `--engine hermes --timeout-seconds 300` to exercise that path; the report lists effective per-task limits. No task automatically gains more authority or a longer production lease.

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
