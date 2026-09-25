# Kilo Runtime — Quick Start

<div align="center">

[简体中文](GUIDE.md) | **English**

</div>

> **Change config**: edit `kilo.json.tmpl` → `.\install.ps1` → reload the VS Code window.
> **Change API key**: edit `hx.key` in `~/.local/share/kilo/auth.json` (no install needed, takes effect immediately).

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
├─ provider/hx-failover                   │← Model gateway client: streaming, timeouts, auto failover,
│   src/ → build → dist/                  │   reasoning gate (rescues thinking models)
├─ plugin/ (auto-loaded; reload window after changes)
│   ├─ quality-gate                       │← 3-layer delivery gate: prevents fake completion claims
│   ├─ dual-review                        │← dual cross review: omission check × red team + verdict
│   ├─ moa                                │← multi-model cross analysis (high-risk decisions)
│   ├─ permission-guard                   │← blocks dangerous commands and secret paths
│   ├─ compaction-anchor                  │← keeps task anchors after long-session compaction
│   └─ memory-bootstrap                   │← auto-enables native memory for git projects
├─ INSTRUCTIONS.md                        │← engineering principles injected every session
└─ command/evolve.md etc.                 │← global commands (/evolve retrospective)
                                          │
                           ~/.local/share/kilo/ (data dir: sessions / memory / credentials auth.json)
```

Data flow: Kilo session → provider (gateway client) → upstream model gateway (OpenAI-compatible API).
On main-model failure it fails over through `failover.chain.models`; at delivery nodes quality-gate
triggers dual-review automatically based on risk.

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
   |                       (only accepts exit 0 after the last edit)
   v
② Delivery node (when all todos are marked completed)
   |  · High-risk files (auth / payments / migrations) or 3+ files changed
   |    -> quality-gate auto-triggers dual-review: omission check × red team
   |      in parallel + third-party model verdict (2-4 minutes)
   |  · Verdict "fail" -> delivery blocked, model must fix and re-review (max 2 rounds)
   |  · Pass -> delivered; residuals auto-saved into project memory
   v
③ You see the result: completed changes + review verdict + summary of all
   degradation/skip events
```

You only ever do two things: **describe the task** and **approve permission prompts**.
Quality control is fully automated by the plugins.

## Model configuration (all in kilo.json.tmpl)

| What to change | Where |
|---------------|-------|
| Main model | Top: `"model": "hx/glm-5.3-flash"` |
| Per-role models | `agent.code / agent.plan / ...` → `model` |
| Gateway URL | `provider.hx.options.baseURL` |
| Failover chain / review models | `provider.hx.options.failover / moa / dual_review` |

New models must be registered in `provider.hx.models` before they can be referenced.

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
- Template comments: whole-line `//` at line start only; any custom key in kilo.json invalidates the whole config
- `debug config` passing ≠ tasks actually run — always smoke-test with a real `kilo run` after changes

---

Maintainer deep-dive (architecture history / asset inventory / performance / privacy / full conventions): see [docs/HISTORY.md](HISTORY.md).