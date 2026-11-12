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
// verify 来自本仓库 agent/verify.md，不是内置 agent；single 是质量闭环入口，单独提升为 primary。
// 自定义 agent 文件即使未在 kilo.json 配键也会被 Kilo 加载，因此 verify 同样必须显式补写。
const CUSTOM_HIDDEN_AGENTS = ["verify"];
const HIDDEN_AGENTS = [...BUILT_IN_AGENTS, ...CUSTOM_HIDDEN_AGENTS];
// 严格档仍保留质量闭环：todo/goal/dual_review 不再禁用（层 1/2/3 门禁与同模型自动审查
// 依赖 todowrite；dual_review 在 singleModel 钉扎下三席同模型，不会混入其他模型）。
// 仍禁用会引入其他模型或增强注入的入口：task/agent_manager（子代理模型不保证同模型）、
// moa（多模型聚合）、skill/记忆工具（保持严格隔离口径）。
const SINGLE_DENY_TOOLS = [
  "task", "moa", "agent_manager", "skill",
  "kilo_memory_save", "kilo_memory_recall",
  "mem_add", "mem_search", "mem_get", "mem_cite", "mem_flag",
];
const SINGLE_DENY_PERMISSIONS = Object.fromEntries(SINGLE_DENY_TOOLS.map((name) => [name, "deny"]));
// 历史配置迁移：旧版严格档把以下工具写成 deny；新版保留质量闭环，必须在 enter 时清除
//（否则同一份部署配置升级后仍会绕过 todo/质量门禁）。只清 deny，不覆盖用户自定义 allow。
const SINGLE_QUALITY_TOOLS = ["dual_review", "todowrite", "todoread", "goal", "goal_report"];
function clearQualityLoopDenies(permission) {
  if (!permission || typeof permission !== "object") return;
  for (const key of SINGLE_QUALITY_TOOLS) {
    if (permission[key] === "deny") delete permission[key];
  }
}

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
  // POSIX 上 rename 的持久性需要父目录 fsync（掉电时目录项可能丢）；
  // Windows 无此语义（MoveFileEx 已落盘），跳过。
  if (process.platform !== "win32") {
    try {
      const dirFd = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* 部分文件系统不支持目录 fsync */ }
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
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = JSON.stringify({ pid: process.pid, token, action, at: nowIso() });
  for (let attempt = 0; attempt < 2; attempt++) {
    // 先把完整内容写到临时文件，再原子占位：openSync(wx) 后再写 pid 存在窗口，
    // 并发进程可能读到空/半截锁并当成「陈旧锁」接管 → 双写同一份 kilo.json。
    const tmp = `${LOCK_PATH}.tmp-${token}`;
    try {
      fs.writeFileSync(tmp, payload, { mode: 0o600, flag: "wx" });
    } catch (e) {
      if (e?.code === "EEXIST") { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
      throw e;
    }
    try {
      try {
        fs.linkSync(tmp, LOCK_PATH); // 原子且不覆盖：EEXIST = 锁已被占
      } catch (e) {
        if (e?.code === "EEXIST") throw e;
        // 不支持硬链接（FAT/exFAT 等）：退化为排他复制，同样不会覆盖既有锁。
        fs.copyFileSync(tmp, LOCK_PATH, fs.constants.COPYFILE_EXCL);
      }
      return token;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      if (e?.code !== "EEXIST") throw e;
      let info = null;
      try { info = JSON.parse(readText(LOCK_PATH)); } catch { /* malformed lock */ }
      if (info && Number.isInteger(info.pid) && isPidAlive(info.pid)) {
        throw new Error(`另一个单模型操作正在运行（pid=${info.pid}, action=${info.action ?? "?"}）`);
      }
      // 属主进程已退出（崩溃残留）或锁内容损坏：默认拒绝接管，必须 --force 人工确认，
      // 避免「读到半截锁就删锁」造成并发多写。
      if (!force) {
        const why = info && Number.isInteger(info.pid)
          ? `残留锁（pid=${info.pid} 已退出）`
          : "锁内容损坏或不可读";
        throw new Error(`检测到${why}：${LOCK_PATH}；确认没有单模型操作在运行后加 --force 接管。`);
      }
      try { fs.unlinkSync(LOCK_PATH); } catch { /* stale lock already gone */ }
    }
  }
  throw new Error(`无法获取单模型操作锁：${LOCK_PATH}`);
}

function releaseLock(token) {
  if (!token) return;
  let info = null;
  try { info = JSON.parse(readText(LOCK_PATH)); } catch { /* unreadable lock */ }
  // 属主校验：不是自己持有的锁一律不删（否则会删掉后来者的锁 → 第三方可并发进入）。
  if (!info || !info.token || info.token !== token) return;
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
      try { fs.chmodSync(file, 0o600); } catch (e) {
        // POSIX 上备份含配置内容，权限收紧失败必须报错（不能留宽权限副本）；
        // Windows 由 ACL 管权限，chmod 语义有限，忽略。
        if (process.platform !== "win32") {
          throw new Error(`备份文件权限收紧失败（内容含配置，勿留宽权限）：${file}：${e?.message ?? e}`);
        }
      }
      return file;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
    }
  }
  throw new Error(`无法创建唯一备份文件：${CONFIG_DIR}`);
}

// 备份保留策略：只留最近 N 份（文件名按时间戳升序 = 最旧在前），避免无限累积。
// 当前活动备份必为最新一份，不会被裁掉。
function pruneBackups(keep = 5) {
  const files = listBackups();
  const stale = files.slice(0, Math.max(0, files.length - keep));
  for (const file of stale) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
  return stale.length;
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
  // 单模型质量闭环：去掉全局工程原则、全局经验与技能注入，避免额外模型/技能/记忆增强；质量纪律由 agent/single.md 承担。
  cfg.instructions = [];
  // skills 必须保持对象形状（模板与部署副本都是 { "paths": [...] }）：改成数组会破坏
  // Kilo 的 schema 形状不变式，整份配置可能被判不合法而拒载（= Kilo 启动失败）。
  // 只清空 paths，效果等价（无技能可注入）且不改变类型。
  cfg.skills = {
    ...(cfg.skills && typeof cfg.skills === "object" && !Array.isArray(cfg.skills) ? cfg.skills : {}),
    paths: [],
  };
  cfg.permission = {
    ...(cfg.permission && typeof cfg.permission === "object" ? cfg.permission : {}),
    ...SINGLE_DENY_PERMISSIONS,
  };
  clearQualityLoopDenies(cfg.permission);
  cfg.compaction = {
    ...(cfg.compaction && typeof cfg.compaction === "object" ? cfg.compaction : {}),
    auto: true,
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
    description:
      "单模型质量闭环入口；质量门禁与同模型双审照常，所有模型调用只用当前唯一模型，禁止委派与多模型聚合。",
    model: full,
    permission: {
      ...(singleAgent.permission && typeof singleAgent.permission === "object" ? singleAgent.permission : {}),
      ...SINGLE_DENY_PERMISSIONS,
    },
  };
  clearQualityLoopDenies(cfg.agent.single.permission);
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
  const skillsPaths = cfg?.skills && typeof cfg.skills === "object" && !Array.isArray(cfg.skills)
    ? cfg.skills.paths : null;
  if (!Array.isArray(skillsPaths) || skillsPaths.length !== 0) {
    fail("skills.paths 必须清空（skills 保持对象形状，不改成数组）");
  }
  for (const key of SINGLE_DENY_TOOLS) {
    same(cfg?.permission?.[key], "deny", `permission.${key}`);
  }
  same(cfg?.compaction?.auto, true, "compaction.auto");
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
  for (const key of SINGLE_QUALITY_TOOLS) {
    if (cfg?.permission?.[key] === "deny") fail(`permission.${key} 不应为 deny（质量闭环需要）`);
    if (cfg?.agent?.single?.permission?.[key] === "deny") fail(`agent.single.permission.${key} 不应为 deny（质量闭环需要）`);
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
    `permission: task/moa/agent_manager/skill/记忆工具 deny；todo/goal/dual_review 保持可用（质量闭环）`,
    `compaction.auto: true`,
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

  const lockToken = acquireLock("enter", args.force);
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
    const pruned = pruneBackups(5);
    if (pruned) console.log(`[single-model] 旧备份清理：${pruned} 份（保留最近 5 份）`);
    console.log("[single-model] 请重载 VS Code 窗口/Kilo，新建会话后使用。");
  } finally {
    releaseLock(lockToken);
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
  if (!backupText && currentHash !== originalHash && !args.force) {
    throw new Error(`备份文件缺失，且当前配置不是原始配置：${backupPath}；确认要放弃恢复（保留当前配置）并解除单模型状态时加 --force。`);
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

  const lockToken = acquireLock("restore", args.force);
  try {
    const { state, backupPath, backupText, currentHash, originalHash } = planRestore(args);
    // 备份缺失 + --force：放弃恢复、保留当前配置，仅解除单模型状态
    // （否则状态文件会永久挡住 install 的单模型守卫与后续 enter）。
    const abandon = !backupText && !!args.force;
    if (!abandon && backupText && currentHash !== originalHash) {
      atomicWrite(CONFIG_PATH, backupText);
    }
    if (abandon) {
      console.error("[single-model] 警告：备份文件缺失，已按 --force 放弃恢复；保留当前配置并解除单模型状态。");
    } else {
      const afterHash = sha256Text(readText(CONFIG_PATH));
      if (originalHash && afterHash !== originalHash) {
        throw new Error("恢复后哈希与备份不一致，已保留状态文件供排查。");
      }
    }
    fs.unlinkSync(STATE_PATH);
    if (!args.keepBackup && backupPath) {
      try { fs.unlinkSync(backupPath); } catch (e) {
        console.error(`[single-model] 警告：备份未能删除：${backupPath}：${e?.message ?? e}`);
      }
    }
    audit("restore", { model: state.model, variant: state.variant ?? null, backup: backupPath, force: !!args.force, abandoned: abandon });
    console.log(abandon ? "[single-model] 已解除单模型状态（配置未回滚）。" : "[single-model] 已恢复原始配置。");
    console.log("[single-model] 请重载 VS Code 窗口/Kilo 使配置生效。");
  } finally {
    releaseLock(lockToken);
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
  - enter 把其余 agent（含未写入配置的内置 agent）降为 hidden subagent，清空 instructions/skills；保留 todo/goal/dual_review 与自动压缩以维持质量闭环，禁止 task/moa/agent_manager/skill/记忆工具，并关闭 task_model_selection。
  - 进入后必须重载 Kilo 窗口；使用结束执行 restore 并再次重载。
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
