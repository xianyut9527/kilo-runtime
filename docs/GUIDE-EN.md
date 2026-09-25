# Quick Start

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