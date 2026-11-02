# Kilo Runtime User Guide

<div align="center">

[简体中文](GUIDE.md) | **English**

</div>

This guide is for **people using Kilo Runtime**, ordered as installation → first task → daily use → capabilities → configuration. For a shorter installation path, see the [repository README](../README.md). Architecture history and maintainer details live in [HISTORY](HISTORY.md) (Chinese).

## 1. What it is

Kilo Runtime is a global configuration and runtime enhancement package for Kilo. It is not a standalone IDE or a multi-agent orchestration UI. After installation, you can keep working in the Kilo GUI client, the VS Code Kilo extension, or Kilo CLI:

- `kilo.json.tmpl` defines models, the gateway, permissions and behavior switches;
- the installer renders and deploys repository assets to `~/.config/kilo/`;
- the provider handles model requests, streaming safeguards and failover;
- plugins handle delivery checks, reviews, dangerous-command protection and memory;
- sessions, memories and credentials live in `~/.local/share/kilo/`, outside the repository configuration.

The main rule: **the repository is the source of truth; treat the deployed directory as read-only**. Editing `~/.config/kilo/kilo.json` directly will be overwritten by the next install.

## 2. Install and run your first task

### 2.1 Prerequisites

| Component | Requirement |
|-----------|-------------|
| Kilo | Kilo GUI client, VS Code + Kilo extension, or Kilo CLI (choose one) |
| Windows | PowerShell 7+ |
| macOS / Linux | bash |
| Runtime tools | Node.js 22+; Bun is optional |
| Model provider | An [OpenLlamas](https://openllamas.com) API key |

The repository already contains the provider build, so **normal installation does not require `npm install`**. Development dependencies are needed only when rebuilding the provider. Git Bash is not required for everyday Windows use; it is needed only for bash maintenance scripts such as `cleanup.sh` and `db-maintain.sh`.

### 2.2 Preview and install

Run these commands from the repository root.

Windows:

```powershell
.\install.ps1 -DryRun   # Render, validate and list differences without writing
.\install.ps1           # Deploy; back up existing configuration before writing
.\install.ps1 -Check    # Later, check repository/deployment drift
```

macOS / Linux:

```bash
./install.sh --dry-run
./install.sh
./install.sh --check
```

The default target is `~/.config/kilo/`. Installation is idempotent: unchanged files are skipped, and a backup is created only when writes are required. If you have local customizations, inspect Dry Run first to avoid replacing managed files unexpectedly.

To use another target, run `.\install.ps1 -Target D:\path\kilo` on Windows or `./install.sh --target /path/kilo` in bash. Absolute paths in the template are rendered for the selected target.

### 2.3 Configure the OpenLlamas API key

Model requests are routed through the **OpenLlamas** gateway. Get an API key from the [OpenLlamas website](https://openllamas.com), then edit:

```text
~/.local/share/kilo/auth.json
```

Merge in `openllamas.key` without overwriting credentials for other providers:

```json
{
  "openllamas": {
    "key": "YOUR_API_KEY"
  }
}
```

The key stays in the runtime data directory and out of git. Changing it does not require another install. The shared `moa` / `dual_review` client caches configuration for up to 60 seconds and invalidates that cache immediately on a 401. If a running Kilo process still holds the old credential, reload or restart Kilo and retry.

### 2.4 Reload and verify

1. Reload or restart Kilo so the new plugins and provider are loaded; VS Code users can run `Developer: Reload Window`.
2. Open a project in your chosen client and start a new Kilo session.
3. Confirm that the default agent is `code` and the selected model belongs to `openllamas`.
4. Submit a read-only task:

   > Inspect this project and tell me how to install dependencies and run tests. Do not modify files.

Then try a small coding task:

> Fix the most relevant failing test, run that test after the change, and summarize the root cause and edits.

The read-only request validates the model path; the coding task validates editing, permissions and delivery checks. A valid configuration does not prove that tasks work, so run at least one real task after installation.

## 3. Daily use

### 3.1 The two main entry points

- **`code`**: the default execution agent for reading code, editing, running commands and delivering changes.
- **`plan`**: solution design and analysis; return to `code` after approving the approach.

For a complex task, state the goal, constraints and acceptance criteria directly. There is no need to orchestrate subagents manually:

> Add a paginated endpoint to this module. Preserve the existing API style, add tests for a normal page, an out-of-range page and an empty result, and do not change unrelated modules.

### 3.2 What happens after you submit a task

```text
You describe the task
   |
   v
The main agent analyzes and executes (reads, edits, runs commands, delegates as needed)
   |  ├─ permission-guard: blocks dangerous commands and credential writes
   |  ├─ compaction-anchor: preserves task anchors during long-session compaction
   |  └─ quality-gate: checks execution evidence, test results and unfinished todos
   v
Delivery checks
   |  ├─ Normal code changes: require a real passing verification after the last edit
   |  └─ High-risk files or 3+ code files: automatic dual_review
   |      (omission check + red team + final verdict)
   v
Changes, verification results and review/degradation/explicit-skip records
```

Documentation-only changes do not trigger the code-test gate or automatic delivery review. A failed review requires its must-fix items to be addressed. Automatic review is capped at two rounds; explicitly skipping verification or accepting residual risk leaves an auditable record.

### 3.3 Common operations

| Need | Action |
|------|--------|
| Change models or behavior | Edit `kilo.json.tmpl` → Dry Run → install |
| Check deployment completeness | `install.ps1 -Check` or `install.sh --check` |
| Enable project memory in a non-git directory | Run `/memory-setup` in Kilo |
| Review, correct and retain experience | Run `/evolve` in Kilo |
| Inspect failover events | `~/.local/share/kilo/failover-events.jsonl` |
| Cleanup and database maintenance | See the maintenance section in [HISTORY](HISTORY.md) |

## 4. Models, failover and reviews

### 4.1 One file owns model configuration

All concrete bindings live in `kilo.json.tmpl`. The models there are the author's default choices, not the only option: model selection is up to your own preference, so change any role's `model` / `variant` as needed.

| What to change | Field |
|----------------|-------|
| Default main model | Top-level `model` |
| Light-task / subagent default | `small_model` / `subagent_model` |
| Planning, execution, review and other roles | `agent.<name>.model`; reasoning effort uses `variant` |
| Gateway URL | `provider.openllamas.options.baseURL` |
| Failover backup list | `provider.openllamas.options.failover.chain.models` |
| Multi-model analysis seats | `provider.openllamas.options.moa` |
| Dual-review seats and fallbacks | `provider.openllamas.options.dual_review` |
| New model capabilities, limits and variants | `provider.openllamas.models` |

Register a new model in `provider.openllamas.models` before referencing it. This guide intentionally does not copy current model names or counts, which change frequently. Role responsibilities are:

| Role | Responsibility |
|------|----------------|
| `code` | Everyday implementation and command execution |
| `plan` | Solution design and planning |
| `general` | High-risk, cross-file or deep implementation subtasks |
| `explore` | Read-only reconnaissance and location |
| `orchestrator` | Task breakdown and delegation |
| `compaction` | Session compaction and summaries |
| `verify` | Independent, read-only cross-family verification |
| `single` | Single-model capability testing entry (not for delivery; see section 5) |

### 4.2 What the failover list means

`failover.chain.models` is not the complete call chain. It is the **backup list after the current model**. The provider prepends the model for the current request and removes duplicates, so the actual chain length and order can differ between `code`, `plan`, `verify` and other agents.

Failed models enter cooldown. During a sustained failure, later requests can skip a model already known to be unavailable. A visible failover notice is injected on a switch and deduplicated within the same cooldown window. If the whole chain is unavailable, the upstream error remains visible instead of being hidden behind a custom wrapper message.

### 4.3 Multi-model review is not run for every task

- `moa`: used on demand when several perspectives are valuable; reference models analyze independently before an aggregator synthesizes their conclusions.
- `dual_review`: triggered automatically for complex deliveries and available manually for a specific plan. Positive and negative reviews run in parallel before a verdict seat makes the final decision.
- Current seat models and fallback order come from configuration. A fallback can put a seat in the same family as the audited implementation; that result must be labeled a degraded review rather than full independent cross-family validation.
- Reviews consume extra upstream calls and time, so simple, low-risk changes do not trigger them mechanically.

## 5. Single-model capability mode

Use this mode to evaluate **one model completing a task end to end without assistance**. It is not intended for normal delivery. There are two ways in: the mode picker for everyday use, and a command-line lockdown when strict isolation is required.

### 5.1 Mode picker (everyday)

1. Select `single` in the Kilo mode picker;
2. pick the model and reasoning effort to test in the model picker;
3. send the task — the session runs on that model, with no config change or reload.

Isolation boundaries and residual effects of this path:

- The `single` agent permission denies task delegation, moa/dual_review, Agent Manager, todo/goal, skill and memory tools; quality-gate skips its exit nudge for `single` sessions, and layers 1/2/3 never fire because the todo tool is denied;
- model and effort follow the model picker, so switching models switches the test subject;
- global instructions and project memory are still injected, and the failover chain stays active — if the chosen model fails, the response starts with a visible "⚠️ [failover]" marker and switches to a backup model; discard any test run that shows that marker;
- background jobs such as session title/summary and auto-compaction use the configured light models and do not execute the task.

### 5.2 Command-line lockdown (strict isolation)

Use the lockdown mode when you need to empty the failover chain, collapse the model registry to a single model, clear instructions/skills, and bypass quality-gate entirely. Entering the mode:

- pins the main model, light tasks, subagents, project memory, every agent, failover, MoA and dual_review to the same model;
- turns other primary agents into hidden subagents, including built-ins such as `ask/debug/summary/title` that are absent from `kilo.json`, leaving only `single` in the main picker;
- clears additional `instructions` and `skills`, and denies task delegation, multi-model review, Agent Manager, todo/goal, skill and memory tools;
- disables automatic compaction, `task_model_selection` and reasoningGate.

These commands work in both PowerShell and bash:

```bash
# 1. List registered models and variants in the deployed config
node "$HOME/.config/kilo/scripts/single-model.mjs" list

# 2. Preview the transition; replace MODEL_ID / VARIANT with list output
node "$HOME/.config/kilo/scripts/single-model.mjs" enter --model MODEL_ID --variant VARIANT --dry-run

# 3. Enter the mode
node "$HOME/.config/kilo/scripts/single-model.mjs" enter --model MODEL_ID --variant VARIANT

# 4. Reload VS Code/Kilo, start a new session and check status
node "$HOME/.config/kilo/scripts/single-model.mjs" status

# 5. Restore the original configuration after testing, then reload again
node "$HOME/.config/kilo/scripts/single-model.mjs" restore
```

`enter` backs up the deployed config as `kilo.json.bak-single-*` and writes state to `~/.local/share/kilo/single-model.json`. By default, `restore` refuses to overwrite manual edits made after entering the mode; use `--force` only when those edits should be discarded, and `--keep-backup` when the backup should be retained.

While the lockdown is active, both installers refuse to overwrite the configuration. Run `restore` before returning to the normal configuration workflow.

## 6. Configuration maintenance and development

### 6.1 The template edit workflow

1. Edit only the repository's `kilo.json.tmpl`.
2. Run Dry Run and confirm rendering and JSON validation pass.
3. Install for real.
4. Reload the VS Code window after plugin/provider changes; start a new session to verify model-routing changes.
5. Run a real task rather than relying only on configuration parsing.

Template comments must be whole-line `//` comments at the start of a line. Do not add custom `"//"` keys, and do not assume Kilo expands `~`; use the existing `__KILO_HOME__` / `__KILO_CONFIG__` placeholders for paths.

A model or variant saved by the VS Code model selector can override an `agent.*` route. Existing sessions also do not automatically switch back after a template edit, which commonly explains why a correct configuration appears to have no effect.

### 6.2 After editing the provider

Run from the repository root:

```bash
# Needed only for the first build or after dependency lock changes
npm --prefix provider/hx-failover ci

# Rebuild dist after editing src/index.js, then test the dist behavior offline
npm --prefix provider/hx-failover run build
node provider/hx-failover/test-failover.mjs
node provider/hx-failover/test-reasoning-gate.mjs
```

Then Dry Run, install, reload and run a real task. The installer compares the source and dist build fingerprints, so an old dist cannot stand in for a new implementation.

See the acceptance section in [HISTORY](HISTORY.md) for the full test and plugin-contract commands.

## 7. Architecture at a glance

```text
┌─ Repository (source of truth)──────────────────────┐
│ kilo.json.tmpl / plugin / provider / agent         │
│ command / lib / INSTRUCTIONS.md / scripts          │
└──────────────────────┬─────────────────────────────┘
                       │ install (render, validate, back up, deploy)
                       v
          ~/.config/kilo/ (deployed configuration)
                       │
                       v
           Kilo GUI client / VS Code extension / CLI
                       │
                       v
           provider / lib ──▶ OpenLlamas model gateway

~/.local/share/kilo/: session DB, project/global memory, API key, failover events
```

See [HISTORY](HISTORY.md) for full asset responsibilities, historical decisions and performance measurements.

## 8. Troubleshooting and privacy

### Common problems

| Symptom | Check first |
|---------|-------------|
| Empty model list or provider initialization failure | Whether install succeeded; whether the window was reloaded; whether `provider.npm` still contains an unrendered placeholder |
| 401 / Invalid token | Whether `openllamas.key` is correct and belongs to the gateway in `baseURL` |
| A config edit has no effect | `-Check` / `--check`, window reload, a new session and model-selector overrides |
| Provider behavior is still old after an edit | Whether you rebuilt, installed and reloaded; whether src and dist fingerprints match |
| Why failover occurred | Model, status and error summary in `failover-events.jsonl` |
| Install refused during single-model lockdown | Run single-model `status`, then `restore` |

### Data and privacy

- Conversations and coding tasks are sent to the configured model gateway. `moa` / `dual_review` also send review material such as task descriptions and diffs to their configured models.
- Keep the API key only in `auth.json`; never commit it or paste it into a task.
- `failover-events.jsonl` records models, actions, statuses and error summaries, not conversation content.
- `GLOBAL-NOTES.md` is a compiled global-memory artifact and must not be edited manually. Write through `mem_add` and search through `mem_search`.
- See the privacy and security section in [HISTORY](HISTORY.md) for full network, telemetry and maintenance boundaries.
