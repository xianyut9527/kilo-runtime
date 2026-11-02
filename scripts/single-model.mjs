#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_DIR = process.env.KILO_CONFIG_DIR ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "kilo");
const CONFIG_PATH = path.join(CONFIG_DIR, "kilo.json");
const DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "kilo");
const STATE_PATH = path.join(DATA_DIR, "single-model.json");
const LOCK_PATH = path.join(DATA_DIR, "single-model.lock");
const AUDIT_PATH = path.join(DATA_DIR, "single-model.log");
const AGENT_NAME = "single";
const PROVIDER_ID = "openllamas";
const STATE_VERSION = 1;
// Kilo 7.8.18 实测：未写入 kilo.json 的内置 agent 也会出现在 agent list。
// 必须显式补写，否则 ask/debug/summary/title 会保持 primary，绕过 default_agent=single。
const BUILT_IN_AGENTS = [
  "ask", "code", "compaction", "debug", "explore",
  "general", "orchestrator", "plan", "summary", "title",
];
// verify 来自本仓库 agent/verify.md，不是内置 agent；single 是测试入口，单独提升为 primary。
// 自定义 agent 文件即使未在 kilo.json 配键也会被 Kilo 加载，因此 verify 同样必须显式补写。
const CUSTOM_HIDDEN_AGENTS = ["verify"];
const HIDDEN_AGENTS = [...BUILT_IN_AGENTS, ...CUSTOM_HIDDEN_AGENTS];
const SINGLE_DENY_TOOLS = [
  "task", "moa", "dual_review", "agent_manager", "todowrite", "todoread", "goal", "goal_report", "skill",
  "kilo_memory_save", "kilo_memory_recall",
  "mem_add", "mem_search", "mem_get", "mem_cite", "mem_flag",
];
const SINGLE_DENY_PERMISSIONS = Object.fromEntries(SINGLE_DENY_TOOLS.map((name) => [name, "deny"]));

function sha256Text(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function readJson(file) {
  const text = readText(file);
  try {
    return { text, value: JSON.parse(text) };
  } catch (e) {
    throw new Error(`配置不是合法 JSON：${file}：${e?.message ?? e}`);
  }
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
    throw e;
  }
}

function writeState(state) {
  atomicWrite(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function loadState() {
  try {
    return JSON.parse(readText(STATE_PATH));
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw new Error(`状态文件不可读：${STATE_PATH}：${e?.message ?? e}`);
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function acquireLock(action, force) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_PATH, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, action, at: nowIso() }), "utf8");
      } finally {
        fs.closeSync(fd);
      }
      return;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      let info = null;
      try { info = JSON.parse(readText(LOCK_PATH)); } catch { /* malformed lock */ }
      if (info && Number.isInteger(info.pid) && isPidAlive(info.pid)) {
        throw new Error(`另一个单模型操作正在运行（pid=${info.pid}, action=${info.action ?? "?"}）`);
      }
      if (!force && info && !Number.isInteger(info.pid)) {
        throw new Error(`锁文件损坏：${LOCK_PATH}；确认无进程运行后加 --force`);
      }
      try { fs.unlinkSync(LOCK_PATH); } catch { /* stale lock already gone */ }
    }
  }
  throw new Error(`无法获取单模型操作锁：${LOCK_PATH}`);
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch { /* already released */ }
}

function audit(action, detail = {}) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_PATH, `${JSON.stringify({ at: nowIso(), action, ...detail })}\n`, { mode: 0o600 });
  } catch { /* audit is best-effort */ }
}

function createBackup() {
  const stamp = nowIso().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  for (let n = 0; n < 100; n++) {
    const suffix = n === 0 ? "" : `-${n}`;
    const file = path.join(CONFIG_DIR, `kilo.json.bak-single-${stamp}-${process.pid}${suffix}`);
    try {
      fs.copyFileSync(CONFIG_PATH, file, fs.constants.COPYFILE_EXCL);
      try { fs.chmodSync(file, 0o600); } catch { /* Windows ACL */ }
      return file;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
    }
  }
  throw new Error(`无法创建唯一备份文件：${CONFIG_DIR}`);
}

function normalizeModelId(id) {
  const raw = String(id ?? "").trim();
  if (!raw) throw new Error("模型 id 不能为空");
  const bare = raw.startsWith(`${PROVIDER_ID}/`) ? raw.slice(PROVIDER_ID.length + 1) : raw;
  if (!bare || bare.includes("/")) {
    throw new Error(`只支持 ${PROVIDER_ID}/<id> 或裸模型 id：${raw}`);
  }
  return bare;
}

function singleModelOfOptions(options) {
  const raw = options?.singleModel;
  const id = typeof raw === "string" ? raw : raw?.model;
  if (typeof id !== "string") return "";
  const value = id.trim();
  if (!value) return "";
  return value.startsWith(`${PROVIDER_ID}/`) ? value.slice(PROVIDER_ID.length + 1) : value;
}

function applySingleModelConfig(base, { model, variant } = {}) {
  const bare = normalizeModelId(model);
  const selectedVariant = variant ? String(variant).trim() : "";
  const cfg = structuredClone(base);
  const provider = cfg?.provider?.[PROVIDER_ID];
  if (!provider || typeof provider !== "object") {
    throw new Error(`配置缺少 provider.${PROVIDER_ID}`);
  }
  const models = provider.models;
  const target = models && typeof models === "object" && Object.prototype.hasOwnProperty.call(models, bare)
    ? models[bare]
    : undefined;
  if (!target || typeof target !== "object") {
    throw new Error(`模型未注册：${PROVIDER_ID}/${bare}`);
  }
  const variants = target.variants && typeof target.variants === "object" ? target.variants : {};
  if (selectedVariant && !Object.prototype.hasOwnProperty.call(variants, selectedVariant)) {
    throw new Error(`模型 ${bare} 不存在 variant：${selectedVariant}`);
  }

  const full = `${PROVIDER_ID}/${bare}`;
  cfg.model = full;
  cfg.small_model = full;
  cfg.subagent_model = full;
  cfg.memory_model = full;
  cfg.default_agent = AGENT_NAME;
  cfg.enabled_providers = [PROVIDER_ID];
  // 纯模型能力测试：去掉全局工程原则、全局经验与技能注入，避免规划/检查脚手架影响结果。
  cfg.instructions = [];
  cfg.skills = [];
  cfg.permission = {
    ...(cfg.permission && typeof cfg.permission === "object" ? cfg.permission : {}),
    ...SINGLE_DENY_PERMISSIONS,
  };
  cfg.compaction = {
    ...(cfg.compaction && typeof cfg.compaction === "object" ? cfg.compaction : {}),
    auto: false,
  };
  cfg.experimental = {
    ...(cfg.experimental && typeof cfg.experimental === "object" ? cfg.experimental : {}),
    task_model_selection: false,
  };

  cfg.agent = cfg.agent && typeof cfg.agent === "object" ? cfg.agent : {};
  for (const name of HIDDEN_AGENTS) {
    if (!Object.prototype.hasOwnProperty.call(cfg.agent, name)) cfg.agent[name] = {};
  }
  for (const [name, agent] of Object.entries(cfg.agent)) {
    if (!agent || typeof agent !== "object") continue;
    agent.model = full;
    if (selectedVariant) agent.variant = selectedVariant;
    else delete agent.variant;
    if (name !== "single") {
      agent.mode = "subagent";
      agent.hidden = true;
    }
  }
  // 自定义 agent 文件（agent/single.md）只提供提示词；模型/variant/权限必须在这里
  // 显式落配置，否则 default_agent=single 会退回全局 model 且拿不到所选 variant。
  const singleAgent = cfg.agent.single && typeof cfg.agent.single === "object" ? cfg.agent.single : {};
  cfg.agent.single = {
    ...singleAgent,
    mode: "primary",
    description: singleAgent.description ||
      "单模型能力测试入口；只使用当前配置的唯一模型，禁止委派、多模型审查与规划代理切换。",
    model: full,
    permission: {
      ...(singleAgent.permission && typeof singleAgent.permission === "object" ? singleAgent.permission : {}),
      ...SINGLE_DENY_PERMISSIONS,
    },
  };
  if (selectedVariant) cfg.agent.single.variant = selectedVariant;
  else delete cfg.agent.single.variant;
  delete cfg.agent.single.hidden;

  const options = provider.options && typeof provider.options === "object" ? provider.options : {};
  const failover = options.failover && typeof options.failover === "object" ? options.failover : {};
  const moa = options.moa && typeof options.moa === "object" ? options.moa : {};
  const dual = options.dual_review && typeof options.dual_review === "object" ? options.dual_review : {};
  provider.options = {
    ...options,
    singleModel: bare,
    reasoningGate: false,
    failover: {
      ...failover,
      chain: {
        ...(failover.chain && typeof failover.chain === "object" ? failover.chain : {}),
        models: [],
      },
    },
    moa: {
      ...moa,
      references: [bare],
      aggregator: bare,
      aggregator_fallbacks: [],
    },
    dual_review: {
      ...dual,
      positive: bare,
      negative: bare,
      aggregator: bare,
      positive_fallbacks: [],
      negative_fallbacks: [],
      aggregator_fallbacks: [],
    },
  };

  const targetCopy = structuredClone(target);
  targetCopy.variants = selectedVariant
    ? { [selectedVariant]: structuredClone(variants[selectedVariant]) }
    : {};
  provider.models = { [bare]: targetCopy };

  validatePinnedConfig(cfg, { model: bare, variant: selectedVariant });
  return cfg;
}

function validatePinnedConfig(cfg, { model, variant } = {}) {
  const bare = normalizeModelId(model);
  const full = `${PROVIDER_ID}/${bare}`;
  const fail = (message) => { throw new Error(`单模型配置校验失败：${message}`); };
  const same = (value, expected, label) => {
    if (value !== expected) fail(`${label} 应为 ${JSON.stringify(expected)}，实际 ${JSON.stringify(value)}`);
  };

  same(cfg?.model, full, "model");
  same(cfg?.small_model, full, "small_model");
  same(cfg?.subagent_model, full, "subagent_model");
  same(cfg?.memory_model, full, "memory_model");
  same(cfg?.default_agent, AGENT_NAME, "default_agent");
  if (!Array.isArray(cfg?.enabled_providers) || cfg.enabled_providers.length !== 1 || cfg.enabled_providers[0] !== PROVIDER_ID) {
    fail(`enabled_providers 必须仅含 ${PROVIDER_ID}`);
  }
  if (!Array.isArray(cfg?.instructions) || cfg.instructions.length !== 0) fail("instructions 必须清空");
  if (!Array.isArray(cfg?.skills) || cfg.skills.length !== 0) fail("skills 必须清空");
  for (const key of SINGLE_DENY_TOOLS) {
    same(cfg?.permission?.[key], "deny", `permission.${key}`);
  }
  same(cfg?.compaction?.auto, false, "compaction.auto");
  same(cfg?.experimental?.task_model_selection, false, "experimental.task_model_selection");

  for (const name of HIDDEN_AGENTS) {
    const agent = cfg?.agent?.[name];
    if (!agent || typeof agent !== "object") fail(`agent.${name} 必须显式存在，避免内置 agent 回退为 primary`);
  }
  for (const [name, agent] of Object.entries(cfg?.agent && typeof cfg.agent === "object" ? cfg.agent : {})) {
    if (!agent || typeof agent !== "object") continue;
    same(agent.model, full, `agent.${name}.model`);
    if (variant) same(agent.variant, variant, `agent.${name}.variant`);
    else if (Object.prototype.hasOwnProperty.call(agent, "variant")) fail(`agent.${name}.variant 应删除`);
    if (name !== "single") {
      same(agent.mode, "subagent", `agent.${name}.mode`);
      same(agent.hidden, true, `agent.${name}.hidden`);
    }
  }
  same(cfg?.agent?.single?.mode, "primary", "agent.single.mode");
  if (cfg?.agent?.single?.hidden === true) fail("agent.single.hidden 不应为 true");
  for (const key of SINGLE_DENY_TOOLS) {
    same(cfg?.agent?.single?.permission?.[key], "deny", `agent.single.permission.${key}`);
  }

  const provider = cfg?.provider?.[PROVIDER_ID];
  const options = provider?.options;
  same(singleModelOfOptions(options), bare, "provider.options.singleModel");
  const chain = options?.failover?.chain?.models;
  if (!Array.isArray(chain) || chain.length !== 0) fail("provider.options.failover.chain.models 必须为空");
  same(options?.reasoningGate, false, "provider.options.reasoningGate");
  if (JSON.stringify(options?.moa?.references) !== JSON.stringify([bare])) fail("provider.options.moa.references 必须仅含目标模型");
  same(options?.moa?.aggregator, bare, "provider.options.moa.aggregator");
  if (!Array.isArray(options?.moa?.aggregator_fallbacks) || options.moa.aggregator_fallbacks.length !== 0) {
    fail("provider.options.moa.aggregator_fallbacks 必须为空");
  }
  for (const key of ["positive", "negative", "aggregator"]) {
    same(options?.dual_review?.[key], bare, `provider.options.dual_review.${key}`);
  }
  for (const key of ["positive_fallbacks", "negative_fallbacks", "aggregator_fallbacks"]) {
    const list = options?.dual_review?.[key];
    if (!Array.isArray(list) || list.length !== 0) fail(`provider.options.dual_review.${key} 必须为空`);
  }

  const modelKeys = Object.keys(provider?.models && typeof provider.models === "object" ? provider.models : {});
  if (modelKeys.length !== 1 || modelKeys[0] !== bare) fail(`provider.models 必须仅保留 ${bare}`);
  const targetVariants = Object.keys(provider?.models?.[bare]?.variants ?? {});
  if (variant) {
    if (targetVariants.length !== 1 || targetVariants[0] !== variant) fail(`模型 variants 必须仅保留 ${variant}`);
  } else if (targetVariants.length !== 0) {
    fail("未指定 variant 时模型 variants 必须清空");
  }
  return true;
}

function describeDiff(before, after, { model, variant }) {
  const bare = normalizeModelId(model);
  const full = `${PROVIDER_ID}/${bare}`;
  const lines = [
    `model: ${before.model ?? "(none)"} -> ${full}`,
    `small_model: ${before.small_model ?? "(none)"} -> ${full}`,
    `subagent_model: ${before.subagent_model ?? "(none)"} -> ${full}`,
    `memory_model: ${before.memory_model ?? "(none)"} -> ${full}`,
    `default_agent: ${before.default_agent ?? "(none)"} -> ${AGENT_NAME}`,
    `instructions/skills: 清空（禁用全局原则、经验与技能注入）`,
    `agent models: ${Object.keys(after.agent ?? {}).length} 个 -> ${full}${variant ? ` @ ${variant}` : ""}`,
    `provider.models: ${Object.keys(before.provider?.[PROVIDER_ID]?.models ?? {}).length} 个 -> 1 个（${bare}）`,
    `failover.chain.models: ${JSON.stringify(before.provider?.[PROVIDER_ID]?.options?.failover?.chain?.models ?? [])} -> []`,
    `singleModel: ${singleModelOfOptions(before.provider?.[PROVIDER_ID]?.options) || "(none)"} -> ${bare}`,
    `agents: 其余 primary agent -> hidden subagent，仅保留 ${AGENT_NAME}`,
    `permission: task/moa/dual_review/agent_manager/todo/goal/skill/记忆工具 deny`,
    `compaction.auto: false`,
    `experimental.task_model_selection: false`,
  ];
  return lines;
}

function readEnterConfig() {
  if (loadState()) {
    throw new Error(`单模型模式状态已存在：${STATE_PATH}。先执行 restore，不要重复 enter。`);
  }
  const { text, value } = readJson(CONFIG_PATH);
  const existingPin = singleModelOfOptions(value.provider?.[PROVIDER_ID]?.options);
  if (existingPin) {
    throw new Error(`配置已存在 singleModel=${existingPin} 但没有状态文件；请先重新安装配置或手动恢复后再 enter。`);
  }
  return { text, value };
}

function enter(args) {
  if (!args.model) throw new Error("enter 需要 --model <id>");
  const bare = normalizeModelId(args.model);
  const variant = args.variant ? String(args.variant).trim() : "";

  if (args.dryRun) {
    const { value } = readEnterConfig();
    const next = applySingleModelConfig(value, { model: bare, variant });
    console.log(`[single-model] dry-run：将写入 ${CONFIG_PATH}`);
    for (const line of describeDiff(value, next, { model: bare, variant })) console.log(`  ${line}`);
    console.log("[single-model] 未写盘；确认后去掉 --dry-run 执行。");
    return;
  }

  acquireLock("enter", args.force);
  try {
    const { text: originalText, value: original } = readEnterConfig();
    const next = applySingleModelConfig(original, { model: bare, variant });
    const nextText = `${JSON.stringify(next, null, 2)}\n`;
    const backupPath = createBackup();
    const backupText = readText(backupPath);
    const state = {
      version: STATE_VERSION,
      enabled: true,
      phase: "prepared",
      model: bare,
      variant: variant || null,
      configPath: CONFIG_PATH,
      backupPath,
      originalSha256: sha256Text(backupText),
      appliedSha256: sha256Text(nextText),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    try {
      writeState(state);
    } catch (e) {
      try { fs.unlinkSync(backupPath); } catch { /* backup cleanup best-effort */ }
      throw e;
    }
    try {
      atomicWrite(CONFIG_PATH, nextText);
    } catch (e) {
      let rolledBack = false;
      try {
        atomicWrite(CONFIG_PATH, originalText);
        rolledBack = true;
      } catch { /* keep backup for manual recovery */ }
      try { fs.unlinkSync(STATE_PATH); } catch { /* no state to remove */ }
      if (rolledBack) {
        try { fs.unlinkSync(backupPath); } catch { /* backup cleanup best-effort */ }
      }
      audit("enter-failed", { model: bare, variant: variant || null, error: String(e?.message ?? e) });
      throw e;
    }
    state.phase = "applied";
    state.updatedAt = nowIso();
    try {
      writeState(state);
    } catch (e) {
      console.error(`[single-model] 警告：配置已写入，但状态 phase 更新失败：${e?.message ?? e}；restore 仍可用。`);
    }
    audit("enter", { model: bare, variant: variant || null, backup: backupPath });
    console.log(`[single-model] 已进入单模型模式：${fullModel(bare)}${variant ? ` @ ${variant}` : ""}`);
    console.log(`[single-model] 备份：${backupPath}`);
    console.log("[single-model] 请重载 VS Code 窗口/Kilo，新建会话后使用。");
  } finally {
    releaseLock();
  }
}

function fullModel(bare) {
  return `${PROVIDER_ID}/${bare}`;
}

function planRestore(args) {
  const state = loadState();
  if (!state) throw new Error(`没有单模型状态文件：${STATE_PATH}`);
  if (state.configPath && path.resolve(state.configPath) !== path.resolve(CONFIG_PATH)) {
    throw new Error(`状态文件属于另一份配置：${state.configPath}，当前：${CONFIG_PATH}`);
  }
  const backupPath = state.backupPath ? path.resolve(state.backupPath) : "";
  if (backupPath) {
    const configDir = path.resolve(CONFIG_DIR);
    if (path.dirname(backupPath) !== configDir || !path.basename(backupPath).startsWith("kilo.json.bak-single-")) {
      throw new Error(`状态文件中的备份路径不合法：${state.backupPath}`);
    }
  }
  const currentText = readText(CONFIG_PATH);
  const currentHash = sha256Text(currentText);
  const backupExists = backupPath && fs.existsSync(backupPath);
  const backupText = backupExists ? readText(backupPath) : null;
  const backupHash = backupText ? sha256Text(backupText) : "";
  if (backupText && state.originalSha256 && backupHash !== state.originalSha256) {
    throw new Error(`备份文件哈希与状态不一致，拒绝恢复：${backupPath}`);
  }
  const originalHash = state.originalSha256 || backupHash;
  if (!backupText && currentHash !== originalHash) {
    throw new Error(`备份文件缺失，且当前配置不是原始配置：${backupPath}`);
  }
  if (currentHash !== originalHash && currentHash !== state.appliedSha256 && !args.force) {
    throw new Error("配置在 enter 之后被修改，restore 默认拒绝覆盖；确认要丢弃这些修改时加 --force。");
  }
  return { state, backupPath, backupText, currentText, currentHash, originalHash };
}

function restore(args) {
  if (args.dryRun) {
    const { state, backupPath, backupText, currentHash, originalHash } = planRestore(args);
    const { value: cfg } = readJson(CONFIG_PATH);
    console.log(`[single-model] dry-run restore：${state.model}${state.variant ? ` @ ${state.variant}` : ""}`);
    console.log(`  备份：${backupPath}（${backupText ? "存在且哈希一致" : "缺失"}）`);
    console.log(`  当前 singleModel：${singleModelOfOptions(cfg.provider?.[PROVIDER_ID]?.options) || "(none)"}`);
    console.log(`  配置哈希：${currentHash === originalHash ? "已是原始配置" : "将恢复为备份"}`);
    console.log("[single-model] 校验通过，未写盘。");
    return;
  }

  acquireLock("restore", args.force);
  try {
    const { state, backupPath, backupText, currentHash, originalHash } = planRestore(args);
    if (backupText && currentHash !== originalHash) {
      atomicWrite(CONFIG_PATH, backupText);
    }
    const afterHash = sha256Text(readText(CONFIG_PATH));
    if (originalHash && afterHash !== originalHash) {
      throw new Error("恢复后哈希与备份不一致，已保留状态文件供排查。");
    }
    fs.unlinkSync(STATE_PATH);
    if (!args.keepBackup && backupPath) {
      try { fs.unlinkSync(backupPath); } catch (e) {
        console.error(`[single-model] 警告：备份未能删除：${backupPath}：${e?.message ?? e}`);
      }
    }
    audit("restore", { model: state.model, variant: state.variant ?? null, backup: backupPath, force: !!args.force });
    console.log("[single-model] 已恢复原始配置。");
    console.log("[single-model] 请重载 VS Code 窗口/Kilo 使配置生效。");
  } finally {
    releaseLock();
  }
}

function status() {
  const { value: cfg } = readJson(CONFIG_PATH);
  let state = null;
  let stateError = "";
  try { state = loadState(); } catch (e) { stateError = String(e?.message ?? e); }
  const pin = singleModelOfOptions(cfg.provider?.[PROVIDER_ID]?.options);
  const currentHash = sha256Text(readText(CONFIG_PATH));

  console.log(`[single-model] 配置：${CONFIG_PATH}`);
  console.log(`[single-model] 状态：${STATE_PATH}`);
  console.log(`[single-model] 配置 singleModel：${pin || "(none)"}`);
  console.log(`[single-model] 注册模型数：${Object.keys(cfg.provider?.[PROVIDER_ID]?.models ?? {}).length}`);
  console.log(`[single-model] failover.chain.models：${JSON.stringify(cfg.provider?.[PROVIDER_ID]?.options?.failover?.chain?.models ?? [])}`);
  if (stateError) console.log(`[single-model] 状态错误：${stateError}`);
  if (state) {
    console.log(`[single-model] 状态模型：${state.model}${state.variant ? ` @ ${state.variant}` : ""}`);
    console.log(`[single-model] 状态阶段：${state.phase ?? "?"}`);
    console.log(`[single-model] 当前配置哈希：${currentHash}`);
    console.log(`[single-model] 应用时哈希：${state.appliedSha256 ?? "?"}`);
    console.log(`[single-model] 备份：${state.backupPath}（${state.backupPath && fs.existsSync(state.backupPath) ? "存在" : "缺失"}）`);
    if (pin === state.model && state.appliedSha256 === currentHash) {
      console.log("[single-model] 判定：ACTIVE（配置已锁定，重载后生效）");
    } else if (!pin) {
      console.log("[single-model] 判定：INCONSISTENT（状态存在但配置未锁定；执行 restore）");
    } else {
      console.log("[single-model] 判定：INCONSISTENT（配置哈希/模型与状态不一致；检查后 restore --force）");
    }
  } else if (pin) {
    console.log("[single-model] 判定：ORPHANED（配置已锁定但无状态文件；重新安装配置或手动清理）");
  } else {
    console.log("[single-model] 判定：OFF");
  }

  const backups = listBackups();
  if (backups.length) {
    console.log("[single-model] 备份文件：");
    for (const file of backups) console.log(`  ${file}`);
  }
}

function listBackups() {
  try {
    return fs.readdirSync(CONFIG_DIR)
      .filter((name) => name.startsWith("kilo.json.bak-single-"))
      .sort()
      .map((name) => path.join(CONFIG_DIR, name));
  } catch {
    return [];
  }
}

function listModels() {
  const { value: cfg } = readJson(CONFIG_PATH);
  const models = cfg.provider?.[PROVIDER_ID]?.models ?? {};
  const entries = Object.keys(models).sort();
  if (entries.length === 0) {
    console.log("[single-model] 没有注册模型。");
    return;
  }
  const pin = singleModelOfOptions(cfg.provider?.[PROVIDER_ID]?.options);
  if (pin) console.log(`[single-model] 当前 singleModel=${pin}；恢复原始配置后可查看完整注册表。`);
  for (const name of entries) {
    const variants = Object.keys(models[name]?.variants ?? {});
    console.log(`${name}${variants.length ? `  variants=${variants.join(",")}` : "  variants=(none)"}`);
  }
}

function usage() {
  console.log(`用法：
  node scripts/single-model.mjs list
  node scripts/single-model.mjs enter --model <id> [--variant <v>] [--dry-run] [--force]
  node scripts/single-model.mjs status
  node scripts/single-model.mjs restore [--dry-run] [--force] [--keep-backup]

说明：
  - enter 会备份当前部署配置，并把主模型、small/subagent/memory、全部 agent、failover、moa、dual_review 全部钉到同一模型。
  - enter 把其余 agent（含未写入配置的内置 agent）降为 hidden subagent，清空 instructions/skills，禁止 task/moa/dual_review/agent_manager/todo/goal/skill/记忆工具，并关闭自动压缩与 task_model_selection。
  - 进入后必须重载 Kilo 窗口；测试结束执行 restore 并再次重载。
  - install 在单模型模式活动期间会拒绝覆盖配置。`);
}

function parseArgs(argv) {
  const args = { command: "status", model: "", variant: "", dryRun: false, force: false, keepBackup: false };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-")) args.command = rest.shift();
  while (rest.length) {
    const arg = rest.shift();
    if (arg === "--help" || arg === "-h") { args.command = "help"; continue; }
    if (arg === "--model") { args.model = rest.shift() ?? ""; continue; }
    if (arg === "--variant") { args.variant = rest.shift() ?? ""; continue; }
    if (arg === "--dry-run") { args.dryRun = true; continue; }
    if (arg === "--force") { args.force = true; continue; }
    if (arg === "--keep-backup") { args.keepBackup = true; continue; }
    throw new Error(`未知参数：${arg}`);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  switch (args.command) {
    case "enter": enter(args); break;
    case "restore": restore(args); break;
    case "status": status(); break;
    case "list": listModels(); break;
    case "help": usage(); break;
    default: throw new Error(`未知命令：${args.command}`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
let isMain = false;
try {
  isMain = invokedPath && fs.realpathSync(invokedPath) === fs.realpathSync(fileURLToPath(import.meta.url));
} catch {
  isMain = false;
}

if (isMain) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`[single-model] ${e?.message ?? e}`);
    process.exit(1);
  }
}

export const _export = {
  applySingleModelConfig,
  validatePinnedConfig,
  normalizeModelId,
  singleModelOfOptions,
  sha256Text,
};
