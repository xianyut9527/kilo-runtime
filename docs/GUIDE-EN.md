# Quick Start

> **Change config**: edit `kilo.json.tmpl` → `.\install.ps1` → reload the VS Code window.
> **Change API key**: edit `hx.key` in `~/.local/share/kilo/auth.json` (no install needed).

## Architecture

```
This repo ─install→ ~/.config/kilo/ (runtime copy — edit nothing there; changes get overwritten)

kilo.json.tmpl    → kilo.json   All config: model routing / gateway / permissions / switches
provider/hx-failover           Model gateway client: streaming, timeouts, auto failover, reasoning gate
plugin/                        quality-gate delivery checks · dual-review cross review ·
                               moa multi-model analysis · permission-guard dangerous-command blocking
INSTRUCTIONS.md                Engineering principles injected into every session
```

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

Maintainer deep-dive (architecture history / asset inventory / performance / privacy / full conventions): see [docs/HISTORY.md](docs/HISTORY.md).
中文版见 [docs/GUIDE.md](docs/GUIDE.md)。