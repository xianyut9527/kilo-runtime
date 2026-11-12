// 会话选定模型提取（单模型质量闭环共用，纯函数零依赖）。
// 不能放进 hx-client：quality-gate 刻意不在模块级引入 hx-client 的副作用链
//（模块求值抛错会让三层门禁陪葬 "failed to load plugin"）。本文件无 import、无顶层副作用，
// 可被 plugin/quality-gate.ts 与 plugin/dual-review.ts 安全静态复用。
//
// 字段来源（kilo.db 实证）：
// - user 消息 info：{ role, agent, model: { providerID, modelID, variant } }
// - assistant 消息 info：{ role, agent, mode, providerID, modelID, variant }
// - session 行：{ agent, model: { id, providerID, variant } }
// 统一经 modelIdOf 归一化，兼容 modelID/id 两种命名与 openllamas/ 前缀。

export function modelIdOf(info) {
  const model = info?.model && typeof info.model === "object" ? info.model : {};
  const providerID = String(model.providerID || info?.providerID || "").trim();
  let id = String(model.modelID || model.id || info?.modelID || "").trim();
  if (id.startsWith("openllamas/")) id = id.slice("openllamas/".length);
  return { providerID, id };
}

export function normalizeModelPin(value) {
  const raw = typeof value === "string" ? value : value?.model;
  const id = typeof raw === "string" ? raw.trim() : "";
  return id.startsWith("openllamas/") ? id.slice("openllamas/".length) : id;
}

// 会话级提取：以最近一条用户消息的 agent/mode 判定是否单模型会话（切换模式后旧消息
// 不再生效）；选定模型取最近一条带模型的 info（换模型后不钉旧模型）。
// 只有 openllamas（或 providerID 缺失的历史形态）可经网关路由；其他 provider 返回
// pin=""、routable=false、blocked=true，调用方必须显式拒绝/阻断，不能回退到配置里的多模型席位。
export function singleSessionInfoOf(list) {
  const arr = Array.isArray(list) ? list : Array.isArray(list?.data) ? list.data : [];
  const flagOf = (m) => {
    const info = m?.info ?? {};
    return String(info.agent || info.mode || "").trim();
  };
  // 以最近一条用户消息的 agent 为准（会话可中途切换模式）；用户消息缺 agent 时
  // 退回最近一条带 agent/mode 的消息。不能「任意一条是 single 就算」——切走模式后
  // 历史消息仍带 single，会把普通会话误钉到旧模型。
  let latest = "";
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (m?.info?.role === "user") {
      // 以最近一条用户消息为准：即使它缺 agent/mode 也不能继续翻更早用户消息，
      // 否则会拿切走 single 前的旧值误钉模型。
      latest = flagOf(m);
      break;
    }
  }
  if (!latest) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const flag = flagOf(arr[i]);
      if (flag) { latest = flag; break; }
    }
  }
  const isSingle = latest === "single";
  if (!isSingle) return { isSingle: false, pin: "", providerID: "", routable: false, blocked: false };
  // 选定模型取最近一条带 model 的消息（换模型后旧消息不能拿来钉扎）。
  let providerID = "";
  let id = "";
  for (let i = arr.length - 1; i >= 0; i--) {
    const p = modelIdOf(arr[i]?.info);
    if (p.id) {
      providerID = p.providerID;
      id = p.id;
      break;
    }
  }
  const routable = !!id && (!providerID || providerID === "openllamas");
  return { isSingle: true, pin: routable ? id : "", providerID, routable, blocked: !!id && !routable };
}
