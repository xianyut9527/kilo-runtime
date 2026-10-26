# Kilo Runtime — Quick Start

<div align="center">

[简体中文](GUIDE.md) | **English**

</div>

> **Change config**: edit `kilo.json.tmpl` → `.\install.ps1` → reload the VS Code window.
> **Change API key**: edit `openllamas.key` in `~/.local/share/kilo/auth.json` (no install needed, takes effect immediately).

## Architecture

```
                 ┌─────────────────────────────────────────────┐
                 │           VS Code + Kilo extension          │
                 └───────────────────┬─────────────────────────┘
                                     │ reads
                                     ▼
This repo (source of truth) ─install→ ~/.config/kilo/ (runtime copy — never edit directly)
│                                         │
├─ kilo.json.tmpl ──render──▶ kilo.json   │← All config: model routing / gateway / permissions / switches
├─ provider/hx-failover                   │← Model gateway client: streaming, 3-tier timeouts, auto failover,
│   src/ → build → dist/                  │   queued-ack interception, thinking dual safety net (protocol + reasoning gate)
├─ plugin/ (auto-loaded; reload window after changes)
│   ├─ quality-gate                       │← 3-layer delivery gate: prevents fake completion claims
│   ├─ dual-review                        │← dual cross review: omission check × red team + verdict
│   ├─ moa                                │← multi-model cross analysis (high-risk decisions)
│   ├─ permission-guard                   │← blocks dangerous commands, secret paths, lock-file write bypasses
│   ├─ compaction-anchor                  │← keeps task anchors after long-session compaction
│   ├─ memory-store                       │← global experience memory store: mem_* tools / retrieval / compiled injection
│   └─ memory-bootstrap                   │← auto-enables native memory for git projects
├─ agent/verify.md                        │← cross-source review subagent (read-only, high-risk changes)
├─ lib/hx-client.ts                       │← shared request layer for moa/dual-review: SSE streaming,
│                                         │   3-tier timeouts, overload circuit breaker, failure telemetry
├─ INSTRUCTIONS.md                        │← engineering principles injected every session
└─ command/evolve.md etc.                 │← global commands (/evolve retrospective)
                                          │
                           ~/.local/share/kilo/ (data dir: sessions / memory / credentials auth.json)
```

Data flow: Kilo session → provider (gateway client) → OpenLlamas model gateway.
On main-model failure it fails over through `failover.chain.models` (each hop injects a visible
"⚠️ [failover]" notice; the same main→standby notice is emitted once per cooldown window. The
main model itself also cools down: during sustained outages later calls start directly from an
available standby, and a fully-cooled chain fails fast until the window expires);
moa/dual-review analysis calls
go through the separate lib/hx-client request layer (circuit breaker fail-fasts when the gateway is
overloaded); at delivery nodes quality-gate triggers dual-review automatically based on risk.

## Task execution flow (what happens automatically after you submit a task)

```
You submit a task
   |
   v
① Main model takes over: break down task -> todowrite checklist -> execute step by step
   (read files / edit code / run commands; subagents fan out as needed)
   |  Plugins work automatically along the way:
   |   · permission-guard  blocks dangerous commands in real time (rm -rf, touching key files, etc.)
   |   · compaction-anchor keeps task anchors when long sessions compress, context never lost
   |   · quality-gate L1  each todo marked completed -> verified against real execution traces;
   |                       "claimed done but never done" gets flagged on the spot
   |   · quality-gate L2  code edited but no test run -> "all completed" is rejected
   |                       (only accepts exit 0 after the last edit; stale provider dist also
   |                        blocked; skipping requires explicit verify-skipped registration)
   |   · quality-gate diagnostics: TS/Python edits get background tsc/ruff (5s debounce),
   |                       backlog flushed back at the delivery node
   v
② Delivery node (when all todos are marked completed)
   |  · High-risk files (auth / payments / migrations) hit, or generic changes
   |    spanning 3+ code files (docs excluded, codeEdits rule since 2026-10-07) ->
   |    quality-gate auto-triggers dual-review: omission check × red team
   |    in parallel + verdict-seat arbitration (2-4 minutes; doc-only sessions skip)
   |  · Verdict "fail" -> delivery blocked, model must fix and re-review (max 2 rounds;
   |    accepting residual risk requires explicit "review-accepted" echo registration)
   |  · Pass -> delivered; on cap-release / explicit acceptance / upstream failure,
   |    residual must-fix items persist into project memory Open Questions
   |    (auto-injected next session)
   v
③ You see the result: completed changes + review verdict + summary of all
   degradation/skip events
```

You only ever do two things: **describe the task** and **approve permission prompts**.
Quality control is fully automated by the plugins.

## Model configuration (all in kilo.json.tmpl)

| What to change | Where |
|---------------|-------|
| Main model | Top-level `"model"` |
| Per-role models | `agent.code / agent.plan / ...` → `model` |
| Gateway URL | `provider.openllamas.options.baseURL` |
| Failover chain / review models | `provider.openllamas.options.failover / moa / dual_review` |

New models must be registered in `provider.openllamas.models` before they can be referenced.
Swapping a model touches only those fields — the docs never copy model names; config
comments only explain current tradeoffs, and the routing fields stay authoritative. The one
exception is the model-usage section in `INSTRUCTIONS.md` — a policy snapshot that must be
updated alongside a model swap.

## Models & division of labor

Upstream: OpenLlamas (<https://openllamas.com>)

Models iterate upstream continuously, so **the docs never copy model names**: role
bindings, the failover chain and the review seats live only in `kilo.json.tmpl` (single
source of truth, rendered to `kilo.json`) — swapping a model touches that one file and nothing below goes stale.

| Role | Tier | Duty |
|------|-------|------|
| Main executor | value·primary | everyday coding / commands |
| Planning | flagship·planning | solution design (other family than the executor) |
| Heavy implementation | value·heavy | high-risk / cross-file changes |
| Recon | value·light | read-only coarse scanning |
| Dispatch | value·light | task breakdown, subagent dispatch |
| Compaction | value·light | session summaries |
| Light tasks | value·light | titles / summaries |
| Subagent default | same as executor | default model for task subagents |
| Review | value·heavy (other family) | hetero read-only review |

Rule: at most 5 routed models; currently 4 = 3 value + 1 flagship planner. Other registered
models stay available as a manual-selection pool. Each role gets the model it is strongest at,
and family diversity is spent only where cross-validation actually pays (coding / planning /
review / heavy implementation / review panel).
Review panel: positive (gaps) + red team (bugs) + verdict seat; positive/red team are
cross-family from the audited subject, the verdict seat currently shares the red team's tier,
and any seat that falls back to the executor's family must be reported as a degraded review
(see config comments).
Failover chain has 3 hops, all value tier; the flagship stays registered but unrouted and can
be re-added after credits/channel recover (order in `failover.chain.models`).

## Common commands

```powershell
.\install.ps1 -DryRun   # Validate the template first (no writes)
.\install.ps1           # Deploy (auto backup)
.\install.ps1 -Check    # Drift check
```

macOS / Linux: `./install.sh --dry-run` → `./install.sh` → `./install.sh --check`.

After editing provider/hx-failover/src: `npm run build` → run `test-failover.mjs` / `test-reasoning-gate.mjs` → install → reload.

## Gotchas

- Editing `~/.config/kilo/kilo.json` directly gets overwritten by install — always edit the repo copy
- A model or variant saved by the VS Code model selector can override the template's `agent.*` route; after editing the template, verify the model and reasoning effort used by a new session. Already-open sessions are not switched back by config — change them manually
- Template comments: whole-line `//` at line start only; any custom key in kilo.json invalidates the whole config
- `debug config` passing ≠ tasks actually run — always smoke-test with a real `kilo run` after changes

---

Maintainer deep-dive (architecture history / asset inventory / performance / privacy / full conventions): see [docs/HISTORY.md](HISTORY.md).
