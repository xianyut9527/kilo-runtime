#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _export } from "./single-model.mjs";

const {
  applySingleModelConfig,
  validatePinnedConfig,
  normalizeModelId,
  singleModelOfOptions,
} = _export;

const base = {
  model: "openllamas/deepseek-v4.1-flash-1017",
  small_model: "openllamas/minimax-m3.1-flash",
  subagent_model: "openllamas/deepseek-v4.1-flash-1017",
  memory_model: "openllamas/minimax-m3.1-flash",
  default_agent: "code",
  enabled_providers: ["openllamas", "anthropic"],
  instructions: ["INSTRUCTIONS.md", "GLOBAL-NOTES.md"],
  skills: { paths: ["skills"] },
  permission: { bash: "allow", task: "allow", skill: "allow", kilo_memory_recall: "allow" },
  compaction: { auto: true, prune: true },
  experimental: { task_model_selection: true },
  agent: {
    code: { model: "openllamas/deepseek-v4.1-flash-1017", variant: "high" },
    plan: { model: "openllamas/kimi-k3.1-pro", variant: "max" },
    general: { model: "openllamas/deepseek-v4.1-flash-1017", variant: "max" },
  },
  provider: {
    openllamas: {
      options: {
        baseURL: "https://example.invalid/v1",
        failover: { chain: { models: ["minimax-m3.1-flash", "glm-5.3-flash"] } },
        moa: { references: ["minimax-m3.1-flash"], aggregator: "kimi-k3.1-pro", aggregator_fallbacks: ["glm-5.3-flash"] },
        dual_review: {
          positive: "minimax-m3.1-flash",
          negative: "glm-5.3-flash",
          aggregator: "kimi-k3.1-pro",
          positive_fallbacks: ["glm-5.3-flash"],
          negative_fallbacks: ["kimi-k3.1-pro"],
          aggregator_fallbacks: ["deepseek-v4.1-flash-1017"],
        },
      },
      models: {
        "deepseek-v4.1-flash-1017": {
          reasoning: true,
          variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } },
        },
        "kimi-k3.1-pro": {
          reasoning: true,
          variants: { low: { reasoningEffort: "low" }, max: { reasoningEffort: "max" } },
        },
      },
    },
  },
};

const out = applySingleModelConfig(base, { model: "kimi-k3.1-pro", variant: "max" });
assert.equal(out.model, "openllamas/kimi-k3.1-pro");
assert.equal(out.small_model, "openllamas/kimi-k3.1-pro");
assert.equal(out.subagent_model, "openllamas/kimi-k3.1-pro");
assert.equal(out.memory_model, "openllamas/kimi-k3.1-pro");
assert.equal(out.default_agent, "single");
assert.deepEqual(out.enabled_providers, ["openllamas"]);
assert.deepEqual(out.instructions, []);
assert.deepEqual(out.skills, []);
assert.equal(out.permission.task, "deny");
assert.equal(out.permission.moa, "deny");
assert.equal(out.permission.dual_review, "deny");
assert.equal(out.permission.agent_manager, "deny");
assert.equal(out.permission.todowrite, "deny");
assert.equal(out.permission.todoread, "deny");
assert.equal(out.permission.goal, "deny");
assert.equal(out.permission.goal_report, "deny");
assert.equal(out.permission.skill, "deny");
assert.equal(out.permission.kilo_memory_save, "deny");
assert.equal(out.permission.kilo_memory_recall, "deny");
for (const name of ["mem_add", "mem_search", "mem_get", "mem_cite", "mem_flag"]) {
  assert.equal(out.permission[name], "deny");
}
assert.equal(out.compaction.auto, false);
assert.equal(out.compaction.prune, true);
assert.equal(out.experimental.task_model_selection, false);
for (const agent of Object.values(out.agent)) {
  assert.equal(agent.model, "openllamas/kimi-k3.1-pro");
  assert.equal(agent.variant, "max");
}
assert.equal(out.agent.plan.mode, "subagent");
assert.equal(out.agent.plan.hidden, true);
assert.equal(out.agent.general.mode, "subagent");
assert.equal(out.agent.general.hidden, true);
for (const name of ["ask", "code", "compaction", "debug", "explore", "general", "orchestrator", "plan", "summary", "title", "verify"]) {
  assert.equal(out.agent[name].mode, "subagent", `非 single agent 未降级：${name}`);
  assert.equal(out.agent[name].hidden, true, `非 single agent 未隐藏：${name}`);
}
assert.equal(out.agent.single.mode, "primary");
assert.equal(out.agent.single.permission.task, "deny");
assert.equal(out.agent.single.permission.moa, "deny");
assert.equal(out.agent.single.permission.dual_review, "deny");
assert.equal(out.agent.single.permission.agent_manager, "deny");
assert.equal(out.agent.single.permission.todowrite, "deny");
assert.equal(out.agent.single.permission.todoread, "deny");
assert.equal(out.agent.single.permission.goal, "deny");
assert.equal(out.agent.single.permission.goal_report, "deny");
assert.equal(out.agent.single.permission.skill, "deny");
assert.equal(out.agent.single.permission.kilo_memory_recall, "deny");
assert.equal(out.agent.single.permission.mem_search, "deny");
assert.equal(out.provider.openllamas.options.singleModel, "kimi-k3.1-pro");
assert.deepEqual(out.provider.openllamas.options.failover.chain.models, []);
assert.equal(out.provider.openllamas.options.reasoningGate, false);
assert.deepEqual(out.provider.openllamas.options.moa.references, ["kimi-k3.1-pro"]);
assert.equal(out.provider.openllamas.options.moa.aggregator, "kimi-k3.1-pro");
assert.deepEqual(out.provider.openllamas.options.moa.aggregator_fallbacks, []);
assert.equal(out.provider.openllamas.options.dual_review.positive, "kimi-k3.1-pro");
assert.equal(out.provider.openllamas.options.dual_review.negative, "kimi-k3.1-pro");
assert.equal(out.provider.openllamas.options.dual_review.aggregator, "kimi-k3.1-pro");
assert.deepEqual(out.provider.openllamas.options.dual_review.positive_fallbacks, []);
assert.deepEqual(out.provider.openllamas.options.dual_review.negative_fallbacks, []);
assert.deepEqual(out.provider.openllamas.options.dual_review.aggregator_fallbacks, []);
assert.deepEqual(Object.keys(out.provider.openllamas.models), ["kimi-k3.1-pro"]);
assert.deepEqual(Object.keys(out.provider.openllamas.models["kimi-k3.1-pro"].variants), ["max"]);
assert.equal(base.model, "openllamas/deepseek-v4.1-flash-1017");
assert.equal(base.agent.code.variant, "high");
assert.equal(validatePinnedConfig(out, { model: "kimi-k3.1-pro", variant: "max" }), true);

const noVariant = applySingleModelConfig(base, { model: "kimi-k3.1-pro" });
assert.equal(noVariant.agent.code.variant, undefined);
assert.equal(noVariant.agent.single.variant, undefined);
assert.deepEqual(Object.keys(noVariant.provider.openllamas.models["kimi-k3.1-pro"].variants), []);

const minimal = {
  provider: { openllamas: { options: {}, models: { "kimi-k3.1-pro": { variants: { max: { reasoningEffort: "max" } } } } } },
};
const minimalOut = applySingleModelConfig(minimal, { model: "kimi-k3.1-pro", variant: "max" });
assert.equal(minimalOut.agent.single.model, "openllamas/kimi-k3.1-pro");
assert.equal(minimalOut.agent.single.variant, "max");
assert.equal(minimalOut.agent.verify.mode, "subagent");
assert.equal(minimalOut.agent.verify.hidden, true);

const normalWithHiddenSingle = structuredClone(base);
normalWithHiddenSingle.agent.single = {
  mode: "subagent",
  hidden: true,
  description: "单模型能力测试入口",
  permission: { task: "deny" },
};
const promoted = applySingleModelConfig(normalWithHiddenSingle, { model: "kimi-k3.1-pro", variant: "max" });
assert.equal(promoted.agent.single.mode, "primary");
assert.equal(promoted.agent.single.hidden, undefined);
assert.equal(promoted.agent.single.permission.todowrite, "deny");

assert.throws(() => applySingleModelConfig(base, { model: "missing" }), /未注册/);
assert.throws(() => applySingleModelConfig(base, { model: "kimi-k3.1-pro", variant: "high" }), /不存在 variant/);
assert.throws(() => normalizeModelId("anthropic/claude"), /只支持/);
assert.equal(normalizeModelId("openllamas/kimi-k3.1-pro"), "kimi-k3.1-pro");
assert.equal(singleModelOfOptions({ singleModel: "openllamas/kimi-k3.1-pro" }), "kimi-k3.1-pro");
assert.equal(singleModelOfOptions({ singleModel: { model: "kimi-k3.1-pro" } }), "kimi-k3.1-pro");
assert.equal(singleModelOfOptions({}), "");

const tampered = structuredClone(out);
tampered.provider.openllamas.options.failover.chain.models = ["glm-5.3-flash"];
assert.throws(() => validatePinnedConfig(tampered, { model: "kimi-k3.1-pro", variant: "max" }), /failover/);

const hiddenSingle = structuredClone(out);
hiddenSingle.agent.single.hidden = true;
assert.throws(() => validatePinnedConfig(hiddenSingle, { model: "kimi-k3.1-pro", variant: "max" }), /agent\.single\.hidden/);

const missingBuiltIn = structuredClone(out);
delete missingBuiltIn.agent.ask;
assert.throws(() => validatePinnedConfig(missingBuiltIn, { model: "kimi-k3.1-pro", variant: "max" }), /agent\.ask 必须显式存在/);

console.log("PASS single-model-config: 配置变换、内置 agent 隐藏、注册表收敛、恢复前校验");

const scriptPath = fileURLToPath(new URL("./single-model.mjs", import.meta.url));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-single-model-test-"));
const configDir = path.join(tempRoot, "config");
const dataHome = path.join(tempRoot, "data");
const configPath = path.join(configDir, "kilo.json");
const statePath = path.join(dataHome, "kilo", "single-model.json");
const originalText = `${JSON.stringify(base, null, 2)}\n`;
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(configPath, originalText, "utf8");
const env = { ...process.env, KILO_CONFIG_DIR: configDir, XDG_DATA_HOME: dataHome };
const runSingle = (args) => {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { env, encoding: "utf8" });
  if (result.error) throw result.error;
  return { ...result, output: `${result.stdout}${result.stderr}` };
};

try {
  let result = runSingle(["enter", "--model", "kimi-k3.1-pro", "--variant", "max", "--dry-run"]);
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.readFileSync(configPath, "utf8"), originalText);
  assert.equal(fs.existsSync(statePath), false);

  result = runSingle(["enter", "--model", "kimi-k3.1-pro", "--variant", "max"]);
  assert.equal(result.status, 0, result.output);
  const appliedText = fs.readFileSync(configPath, "utf8");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const backupText = fs.readFileSync(state.backupPath, "utf8");
  assert.equal(backupText, originalText);

  result = runSingle(["enter", "--model", "kimi-k3.1-pro", "--dry-run"]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /状态已存在/);

  result = runSingle(["restore", "--dry-run"]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /校验通过，未写盘/);
  assert.equal(fs.readFileSync(configPath, "utf8"), appliedText);

  fs.writeFileSync(configPath, `${appliedText}\n`, "utf8");
  result = runSingle(["restore", "--dry-run"]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /配置在 enter 之后被修改/);
  result = runSingle(["restore", "--dry-run", "--force"]);
  assert.equal(result.status, 0, result.output);

  fs.writeFileSync(configPath, appliedText, "utf8");
  fs.appendFileSync(state.backupPath, "tamper", "utf8");
  result = runSingle(["restore", "--dry-run", "--force"]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /备份文件哈希与状态不一致/);

  fs.writeFileSync(state.backupPath, backupText, "utf8");
  result = runSingle(["restore", "--force"]);
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.readFileSync(configPath, "utf8"), originalText);
  assert.equal(fs.existsSync(statePath), false);

  const orphaned = JSON.parse(originalText);
  orphaned.provider.openllamas.options.singleModel = "kimi-k3.1-pro";
  fs.writeFileSync(configPath, JSON.stringify(orphaned), "utf8");
  result = runSingle(["enter", "--model", "kimi-k3.1-pro", "--dry-run"]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /配置已存在 singleModel/);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("PASS single-model-e2e: dry-run 一致性、备份篡改拒绝、精确恢复");
