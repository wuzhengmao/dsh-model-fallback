import z from "@deepseek-ai/schemastery";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

// 插件名即 cordis 配置项 id。
export const name = "dsh-model-fallback";

// 硬依赖：llm 服务（核心服务，恒存在）。用于递归发起备用模型请求。
// agents 是可选服务（用 ctx.get 惰性读取），用于把降级结果同步回会话模型选择。
export const inject = ["llm"];

// 防递归标记：备用模型重发请求时挂到 options 上，监听器检测到后直接放行，
// 避免在 llm/stream 监听器内再次调用 ctx.llm.stream() 造成无限递归。
const RECURSIVE = Symbol("dsh-model-fallback:recursive");

const ConfigBase = z.object({
  enabled: z.boolean()
    .description("是否启用模型自动降级。关闭后所有请求原样放行，不干预路由。")
    .default(true),
  primaryProvider: z.string()
    .description("首选模型 provider。")
    .default(""),
  primaryModels: z.array(z.string())
    .description("需要监控降级的首选模型列表（拦截这些模型的请求；其余模型原样放行）。")
    .default([]),
  fallbackProvider: z.string()
    .description("备用模型 provider。官方 DeepSeek 通道的运行时 id 为 deepseek-official。")
    .default(""),
  fallbackModel: z.string()
    .description("备用模型。官方 DeepSeek 通道为 deepseek-flash。")
    .default(""),
  timeoutMs: z.number().min(0)
    .description("首 token 超时毫秒：超过该时长仍无任何流式响应则降级；0 表示不启用超时降级。")
    .default(10000),
  windowMs: z.number().min(1000)
    .description("低速率统计窗口毫秒：请求开始满该时长后，按累计 token 估算速率。")
    .default(30000),
  minTokensPerSecond: z.number().min(0)
    .description("低速率阈值（token/s）：窗口期满后估算速率低于该值则降级。")
    .default(30),
  switchBackAfterMs: z.number().min(0)
    .description("降级持续毫秒：到期后自动尝试切回首选模型（0 表示不自动切回）。")
    .default(600000),
  asciiTokenPerChar: z.number().min(0.01)
    .description("ASCII 字符估算 token 系数（速率估算用，官方 usage 到达前）。")
    .default(0.3),
  cjkTokenPerChar: z.number().min(0.01)
    .description("非 ASCII 字符估算 token 系数（速率估算用，官方 usage 到达前）。")
    .default(0.6),
  logFile: z.string()
    .description("日志文件绝对路径（留空只写宿主日志与控制台）。排查降级行为时可设为如 D:\\\\\\\\logs\\\\\\\\dsh-model-fallback.log。")
    .default("")
});

// 设置页 / 系统设置只暴露 volatile 字段：把每个字段包成 volatile，
// 这样 Host 的 settings.describe() 才会收录本插件，系统设置里才能热改。
export const Config = z.object(
  Object.fromEntries(
    Object.entries(ConfigBase.dict ?? {}).map(([key, field]) => [key, field.volatile()]),
  ),
);

// --- 工具函数 ---

/** 是否为携带生成内容的增量 chunk。 */
function isDelta(chunk) {
  return (
    chunk.type === "text-delta" ||
    chunk.type === "reasoning-delta" ||
    chunk.type === "tool-call-delta"
  );
}

/** 取一个增量 chunk 携带的文本（用于估算 token）。 */
function deltaText(chunk) {
  if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") return chunk.text ?? "";
  if (chunk.type === "tool-call-delta") return chunk.argumentsDelta ?? "";
  return "";
}

/** 双密度估算文本 token 数：ASCII 每字符 asciiTokenPerChar，其余每字符 cjkTokenPerChar。 */
function estimateTokens(text, cfg) {
  let ascii = 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i += 1) {
    const cp = text.codePointAt(i);
    if (cp === undefined) continue;
    if (cp <= 0x7f) ascii += 1;
    else cjk += 1;
    if (cp > 0xffff) i += 1;
  }
  return ascii * cfg.asciiTokenPerChar + cjk * cfg.cjkTokenPerChar;
}

/** 是否为错误结束帧（adapter 把连接/鉴权失败编码成 finish 而非抛错）。 */
function isErrorFinish(chunk) {
  return chunk.type === "finish" && chunk.reason?.kind === "error";
}

/** 把失败对象转成一行可读描述，用于日志。 */
function describeFailure(failure) {
  if (!failure) return "未知错误";
  if (typeof failure === "string") return failure;
  if (typeof failure.message === "string") return failure.message;
  try {
    return JSON.stringify(failure);
  } catch {
    return String(failure);
  }
}

/** 把一个 selection 对象收敛成 { provider, model, reasoningEffort? }，非法则返回 undefined。 */
function looseSelection(data) {
  if (!data || typeof data !== "object") return undefined;
  const { provider, model, reasoningEffort } = data;
  if (typeof provider !== "string" || provider === "") return undefined;
  if (typeof model !== "string" || model === "") return undefined;
  return {
    provider,
    model,
    ...(typeof reasoningEffort === "string" && reasoningEffort !== ""
      ? { reasoningEffort }
      : {})
  };
}

/** 两个 selection 是否等价。 */
function sameSelection(left, right) {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort
  );
}

/**
 * 从会话事件流推导「当前有效模型选择」。
 * 折叠 model/selection（待生效）与 request/header（最近实际使用）两类事件：
 * 二者一致时清掉待生效状态，最终返回 pending ?? lastUsed。
 * 与 dsh-better-sidebar 的 effectiveModelSelection 语义保持一致。
 */
function effectiveModelSelection(events) {
  let pending;
  let lastUsed;
  for (const event of events) {
    const data = event?.data;
    if (event?.type === "model/selection") {
      const selection = looseSelection(data);
      if (selection !== undefined) pending = selection;
      continue;
    }
    if (event?.type !== "request/header") continue;
    const header = data?.header;
    const config = header?.config;
    if (config === null || typeof config !== "object") continue;
    const selection = looseSelection(config);
    if (selection === undefined) continue;
    // adapter 自己补的默认 reasoningEffort 不算用户选择。
    const isDefaultEffort = header?.adapterDefaults?.reasoningEffort === true;
    lastUsed = {
      provider: selection.provider,
      model: selection.model,
      ...(!isDefaultEffort && selection.reasoningEffort !== undefined
        ? { reasoningEffort: selection.reasoningEffort }
        : {})
    };
    if (sameSelection(pending, lastUsed)) pending = undefined;
  }
  return pending ?? lastUsed;
}

// --- 降级状态对外暴露（typert @Remote，供 client 端渲染降级标志与倒计时）---
// 网关 SRC 模式通过 remoteMethods() 读原型上的方法标记来发现端点，并反射方法参数名，
// 所以这里手动写入与 @Remote 装饰器等价的标记（常量未导出，用字符串字面量）。
const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";

class ModelFallbackRemote extends TypertRemoteService {
  constructor(ctx, states, getConfig) {
    super(ctx, "modelFallback");
    this.states = states;
    this.getConfig = getConfig;
  }

  /**
   * 查询某会话的降级状态。参数名 sessionId 必须是普通标识符（SRC 反射依赖）。
   * 返回 JSON 兼容对象：{ degraded, remainingMs, switchBackAfterMs }。
   */
  async status(sessionId) {
    const state = typeof sessionId === "string" ? this.states.get(sessionId) : undefined;
    const switchBackAfterMs = this.getConfig().switchBackAfterMs;
    if (state === undefined || state.mode !== "fallback") {
      return { degraded: false, remainingMs: 0, switchBackAfterMs };
    }
    const remainingMs = Math.max(0, switchBackAfterMs - (Date.now() - state.switchedAt));
    return { degraded: true, remainingMs, switchBackAfterMs };
  }
}

Object.defineProperty(ModelFallbackRemote.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: "status", invocation: Object.freeze({ kind: "direct" }) })
    ])
  })
});

export function apply(ctx, config = {}) {
  // 配置实时读取：settings 保存走 configEditor.edit，内部只做 fiber.resolveConfig（就地更新，
  // 不会让本插件重新 apply）。所以这里不缓存值，而是每次访问都从未被替换的 config 对象上
  // 解开 volatile 容器，这样保存后立刻生效。
  const unwrap = (value) => (value && typeof value.get === "function" ? value.get() : value);
  const cfg = new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        return unwrap(config[key]);
      }
    }
  );
  if (cfg.enabled === false) return;

  // 首选/备用模型未配置完整时，等同于插件未启用：所有请求原样放行。
  //
  // 注意：这里**不能**因为「此刻不完整」就提前 return。Host 对已有插件条目的配置变更
  // 只做 resolveConfig 就地更新（不会重新执行 apply），所以一旦提前 return，监听器就
  // 永远注册不上——用户后来把配置补全了，插件也醒不过来，只能重启整个 DSH。
  // 因此把完整性判断推迟到每个请求，配置补全后的第一个请求即自动开始工作。
  function isConfigured() {
    const models = Array.isArray(cfg.primaryModels) ? cfg.primaryModels : [];
    return (
      typeof cfg.primaryProvider === "string" &&
      cfg.primaryProvider !== "" &&
      models.length > 0 &&
      typeof cfg.fallbackProvider === "string" &&
      cfg.fallbackProvider !== "" &&
      typeof cfg.fallbackModel === "string" &&
      cfg.fallbackModel !== ""
    );
  }

  const llm = ctx.llm;

  /** 首选目标（切回时写入会话模型）。列表为空时退化为空 model，调用方需容忍。 */
  function primarySelection() {
    const models = Array.isArray(cfg.primaryModels) ? cfg.primaryModels : [];
    return { provider: cfg.primaryProvider, model: models[0] ?? "" };
  }

  /** 备用目标。 */
  function fallbackSelection() {
    return { provider: cfg.fallbackProvider, model: cfg.fallbackModel };
  }

  // 统一日志：走宿主 ctx.logger（写入 Host 日志流），并同步 console 便于开发期观察。
  // ctx.logger 是 cordis 内置能力，格式串 + 参数与 console 兼容。
  // 另可选追加到 logFile（桌面版 Host stdout 不落盘，落文件才方便事后排查）。
  let logFileReadyFor = "";
  function log(message) {
    const line = `[dsh-model-fallback] ${new Date().toISOString()} ${message}`;
    try {
      ctx.logger?.info?.(message);
    } catch {
      /* 日志失败绝不影响请求 */
    }
    console.log(line);
    const target = cfg.logFile;
    if (!target) return;
    try {
      // 目录按路径缓存：用户可能在运行中把 logFile 改到别的目录。
      const dir = dirname(target);
      if (logFileReadyFor !== dir) {
        mkdirSync(dir, { recursive: true });
        logFileReadyFor = dir;
      }
      appendFileSync(target, line + "\n", "utf8");
    } catch {
      /* 写文件失败绝不影响请求 */
    }
  }

  // --- 每会话状态机 ---
  // 降级状态必须按会话隔离：一个会话降级不应该影响另一个会话。
  // sessionId 缺失时退化到空串键，行为等价于旧的全局状态。
  const states = new Map();

  // 暴露降级状态给 client 端（渲染「降级中 · Xs 后恢复」）。实例化即完成 Cordis 服务
  // 注册与 typert 网关绑定；插件卸载时 ctx 销毁，无需显式清理。
  // 失败只影响降级标志，不影响核心降级功能，故兜住。
  try {
    new ModelFallbackRemote(ctx, states, () => cfg);
  } catch (error) {
    log(`降级状态 RPC 注册失败：${error?.message ?? error}（降级标志将不可用）`);
  }

  function stateOf(sessionId) {
    const key = typeof sessionId === "string" && sessionId !== "" ? sessionId : "";
    let state = states.get(key);
    if (state === undefined) {
      state = { mode: "primary", switchedAt: 0, timer: null, pendingRestore: false };
      states.set(key, state);
    }
    return state;
  }

  function clearTimer(state) {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  // --- 会话模型读写（需求 3、4 的基础）---

  /** 按 sessionId 取 live agent（拿不到就返回 undefined，调用方需容忍）。 */
  function agentOf(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return undefined;
    try {
      return ctx.get("agents")?.get?.(sessionId);
    } catch {
      return undefined;
    }
  }

  /** 读取会话当前有效模型；无法确定时返回 undefined。 */
  function currentSelectionOf(sessionId) {
    const agent = agentOf(sessionId);
    if (agent === undefined) return undefined;
    try {
      const events = agent.session?.snapshotEvents?.();
      if (Array.isArray(events)) {
        const selection = effectiveModelSelection(events);
        if (selection !== undefined) return selection;
      }
    } catch {
      /* 事件读取失败则退回到 agent.options */
    }
    const options = agent.options;
    if (options && typeof options.provider === "string" && typeof options.model === "string") {
      return {
        provider: options.provider,
        model: options.model,
        ...(typeof options.reasoningEffort === "string"
          ? { reasoningEffort: options.reasoningEffort }
          : {})
      };
    }
    return undefined;
  }

  /**
   * 把模型选择写回会话（agent.model.select）。
   * 成功返回 true——此时对话框里的模型显示会跟随变化，后续 step 直接使用新模型；
   * 失败返回 false，调用方退回「仅在 llm/stream 路由层接管」的兜底路径。
   */
  function selectAgentModel(sessionId, selection) {
    const agent = agentOf(sessionId);
    const model = agent?.model;
    if (!model || typeof model.select !== "function") return false;
    try {
      const result = model.select(selection);
      if (result && typeof result.then === "function") result.catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  function isFallbackSelection(selection) {
    return (
      selection !== undefined &&
      selection.provider === cfg.fallbackProvider &&
      selection.model === cfg.fallbackModel
    );
  }

  // --- 降级 / 切回 ---

  /** 备用模型重发：spread 出带防递归标记的新 options，递归走完整 llm/stream 瀑布流，
   * 从而保留官方中间件（鉴权注入、重试等）。返回的 AsyncIterable 由调用方 yield* 消费。 */
  function routeFallback(options) {
    const fallbackOptions = {
      ...options,
      provider: cfg.fallbackProvider,
      model: cfg.fallbackModel,
      [RECURSIVE]: true
    };
    return llm.stream(fallbackOptions);
  }

  /** 切回首选模型：改回会话模型 + 复位状态 + 清定时器。 */
  function switchBack(sessionId, state, reason) {
    state.mode = "primary";
    state.switchedAt = 0;
    clearTimer(state);
    const target = primarySelection();
    const written = selectAgentModel(sessionId, target);
    // 会话已结束 / agent 不在时改不进去，记下待恢复标记，
    // 等这个会话下次被打开时再补写回首选模型。
    state.pendingRestore = !written;
    log(
      `切回(${reason}): ${cfg.fallbackProvider}/${cfg.fallbackModel} → ` +
      `${target.provider}/${target.model}` +
      (written ? "" : "（会话当前不在线，已排队下次打开时补写回首选模型）")
    );
  }

  /**
   * 补写待恢复的会话模型（定时器到期时会话不在线的情况）。
   * 返回 true 表示本次确实把会话模型改回了首选模型。
   */
  function restoreIfPending(sessionId) {
    const state = stateOf(sessionId);
    if (!state.pendingRestore) return false;
    const current = currentSelectionOf(sessionId);
    if (current !== undefined && !isFallbackSelection(current)) {
      // 用户自己改过模型，尊重它。
      state.pendingRestore = false;
      return false;
    }
    const target = primarySelection();
    const written = selectAgentModel(sessionId, target);
    if (!written) return false;
    state.pendingRestore = false;
    log(
      `补切回: ${cfg.fallbackProvider}/${cfg.fallbackModel} → ` +
      `${target.provider}/${target.model}`
    );
    return true;
  }

  /**
   * 到期尝试切回。需求 4：如果用户在此期间自己另选了别的模型，
   * 当前会话模型就不再是备用目标，此时应当放弃切回，尊重用户选择。
   */
  function trySwitchBack(sessionId, state, reason) {
    if (state.mode !== "fallback") return;
    const current = currentSelectionOf(sessionId);
    if (current !== undefined && !isFallbackSelection(current)) {
      state.mode = "primary";
      state.switchedAt = 0;
      clearTimer(state);
      log(
        `放弃切回(${reason}): 当前会话模型 ${current.provider}/${current.model} ` +
        `已不是备用目标 ${cfg.fallbackProvider}/${cfg.fallbackModel}`
      );
      return;
    }
    switchBack(sessionId, state, reason);
  }

  /** 进入降级：写回会话模型 + 记录时间 + 安排到期定时器。 */
  function degrade(sessionId, state, options, why) {
    state.mode = "fallback";
    state.switchedAt = Date.now();
    const target = fallbackSelection();
    const written = selectAgentModel(sessionId, target);
    scheduleSwitchBack(sessionId, state);
    log(
      `降级(${why}): ${options.provider}/${options.model} → ` +
      `${target.provider}/${target.model}` +
      (written ? "" : "（未能改写会话模型，改由路由层接管）")
    );
  }

  /** 到期定时器：不依赖「下一个首选模型请求」出现，避免会话模型已被改写后永远不切回。 */
  function scheduleSwitchBack(sessionId, state) {
    clearTimer(state);
    if (!(cfg.switchBackAfterMs > 0)) return;
    const timer = setTimeout(() => {
      state.timer = null;
      trySwitchBack(sessionId, state, `已降级 ${(cfg.switchBackAfterMs / 1000).toFixed(0)}s`);
    }, cfg.switchBackAfterMs);
    if (typeof timer?.unref === "function") timer.unref();
    state.timer = timer;
  }

  // 首选模型流监控。两类降级：
  // 1. 首 token 超时 / 请求失败（零输出）：中断当前流并降级，fallback 完整重跑当前请求。
  //    此时 primary 尚无任何输出，重跑对下游透明、无 partial 拼接。
  // 2. 低速率（有输出）：不中断当前流（中断会让已产出的 partial 与 fallback
  //    重跑的完整流发生拼接，语义错乱），只标记降级，下一个请求用 fallback。
  async function* runPrimary(options, next, state, sessionId) {
    // next() 本身可能同步抛错（provider 未注册等），提前兜住，按失败降级处理。
    let it;
    try {
      it = next()[Symbol.asyncIterator]();
    } catch (error) {
      degrade(sessionId, state, options, `请求失败(${describeFailure(error)})`);
      yield* routeFallback(options);
      return;
    }

    const startedAt = Date.now();
    let firstChunkAt = 0;
    let tokens = 0;
    let timedOut = false;
    let slowRate = false;
    let failed = false;
    let failureReason = "";

    // 首 token 超时定时器：resolve 一个 { kind: "timeout" } 哨兵，与首个 chunk race。
    let timer = null;
    let timeoutPromise = null;
    if (cfg.timeoutMs > 0) {
      timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), cfg.timeoutMs);
      });
    }
    const stopTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    // 低速率窗口定时器：窗口期满准时判定，不依赖下一个 chunk 是否到达
    // （模型长时间不吐 token 时，惰性检查会被无限推迟）。
    let windowTimer = null;
    if (cfg.windowMs > 0) {
      windowTimer = setTimeout(() => {
        windowTimer = null;
        const elapsed = Date.now() - startedAt;
        const rate = tokens / (elapsed / 1000);
        if (rate < cfg.minTokensPerSecond) slowRate = true;
      }, cfg.windowMs);
    }
    const stopWindowTimer = () => {
      if (windowTimer !== null) {
        clearTimeout(windowTimer);
        windowTimer = null;
      }
    };

    try {
      // 第一阶段：等待首个 chunk，带首 token 超时。
      if (timeoutPromise !== null) {
        const chunkPromise = it.next();
        // 超时后被中止的 pending 请求若后续 reject，需兜底避免 unhandled rejection。
        chunkPromise.catch(() => {});
        const winner = await Promise.race([
          chunkPromise.then((r) => ({ kind: "chunk", r }), (e) => ({ kind: "throw", e })),
          timeoutPromise
        ]);
        if (winner.kind === "timeout") {
          timedOut = true;
          // 不 await：底层 adapter 可能已挂起，it.return() 会一直等它的 pending
          // promise，从而把降级路径一起拖死。这里 fire-and-forget，让 GC 收尾。
          Promise.resolve(it.return?.()).catch(() => {});
        } else if (winner.kind === "throw") {
          // 连接被拒、DNS 失败、鉴权失败等会在这里抛错，属于「无响应」的一种，
          // 必须降级而不是把错误抛给上层。
          failed = true;
          failureReason = describeFailure(winner.e);
        } else {
          const r = winner.r;
          if (!r.done) {
            // adapter 也可能把失败编码成 error 结束帧而不是抛错。
            if (isErrorFinish(r.value)) {
              failed = true;
              failureReason = describeFailure(r.value.reason?.failure);
            } else {
              firstChunkAt = Date.now();
              stopTimer();
              if (isDelta(r.value)) tokens += estimateTokens(deltaText(r.value), cfg);
              yield r.value;
            }
          }
          // r.done === true 表示空流，正常结束，不降级。
        }
      }

      // 第二阶段：正常迭代。低速率判定由窗口定时器负责，这里只累计 token。
      while (!timedOut && !failed) {
        const r = await it.next();
        if (r.done) break;
        const chunk = r.value;
        // 流中途出错（连接被服务端掐断等）：只要还没产出任何内容，仍可干净降级。
        if (isErrorFinish(chunk) && firstChunkAt === 0) {
          failed = true;
          failureReason = describeFailure(chunk.reason?.failure);
          break;
        }
        if (firstChunkAt === 0) firstChunkAt = Date.now();
        if (isDelta(chunk)) tokens += estimateTokens(deltaText(chunk), cfg);
        yield chunk;
      }
    } catch (error) {
      // 迭代过程中抛错：只有在尚未产出任何内容时才能干净地降级重发，
      // 否则 partial 已下发，重发会造成内容重复。
      if (firstChunkAt === 0) {
        failed = true;
        failureReason = describeFailure(error);
      } else {
        throw error;
      }
    } finally {
      stopTimer();
      stopWindowTimer();
    }

    if (timedOut || failed) {
      const why = timedOut
        ? `超时 ${cfg.timeoutMs}ms 无响应`
        : `请求失败(${failureReason})`;
      degrade(sessionId, state, options, why);
      yield* routeFallback(options);
    } else if (slowRate) {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const rate = tokens / Math.max(1, elapsedSec);
      degrade(
        sessionId,
        state,
        options,
        `低速率 ${rate.toFixed(1)} tok/s < ${cfg.minTokensPerSecond}（下个请求生效）`
      );
    }
  }

  // 配置状态播报：只在「完整 ←→ 不完整」翻转时打一行，避免每个请求刷日志。
  // 这行同时是「配置已补全、插件开始工作」的可观测证据。
  let announcedConfigured = null;
  function announceState() {
    const ready = isConfigured();
    if (ready === announcedConfigured) return;
    announcedConfigured = ready;
    if (ready) {
      log(
        `插件已加载: 拦截 ${cfg.primaryProvider}/[${(cfg.primaryModels ?? []).join(", ")}] → ` +
        `${cfg.fallbackProvider}/${cfg.fallbackModel}，降级持续 ${(cfg.switchBackAfterMs / 1000).toFixed(0)}s`
      );
    } else {
      log(
        "插件已加载但未启用：首选/备用模型未配置完整" +
        "（primaryProvider、primaryModels、fallbackProvider、fallbackModel 均须填写）。" +
        "补全配置后会自动开始工作，无需重启。"
      );
    }
  }
  announceState();


  const off = ctx.on(
    "llm/stream",
    (options, next) => {
      // 递归重发的请求直接放行，避免无限递归。
      if (options[RECURSIVE]) return next();

      // 配置可能在本插件 apply 之后才被补全（Host 只做 resolveConfig 就地更新），
      // 所以每个请求都重新判断一次：补全前原样放行，补全后立刻接管。
      announceState();
      if (!isConfigured()) return next();

      const sessionId = options.sessionId;
      const state = stateOf(sessionId);
      const now = Date.now();

      // 上次到期时会话不在线、没能写回首选模型：这个会话一出现就补写，
      // 并把当前这次请求也改为发往首选模型。
      if (state.pendingRestore && restoreIfPending(sessionId)) {
        const primary = primarySelection();
        return llm.stream({ ...options, provider: primary.provider, model: primary.model, [RECURSIVE]: true });
      }

      // 只接管发往监控列表内模型的请求。用户显式选择其他模型时不干预，
      // 否则插件会把 UI 里的模型选择强行改写，破坏显式意图。
      if (
        options.provider !== cfg.primaryProvider ||
        !Array.isArray(cfg.primaryModels) ||
        !cfg.primaryModels.includes(options.model)
      ) {
        return next();
      }

      // 仍处于降级期、且请求又是首选模型：
      // - 用户已手动改回别的模型 → 复位降级状态，重新监控首选模型；
      // - 已到期 → 尝试切回；
      // - 未到期 → 继续路由到备用模型。
      if (state.mode === "fallback") {
        const current = currentSelectionOf(sessionId);
        if (current !== undefined && !isFallbackSelection(current)) {
          state.mode = "primary";
          state.switchedAt = 0;
          clearTimer(state);
          log(`复位降级: 当前会话模型已是 ${current.provider}/${current.model}，重新监控首选模型`);
        } else if (now - state.switchedAt >= cfg.switchBackAfterMs) {
          trySwitchBack(sessionId, state, `已降级 ${((now - state.switchedAt) / 1000).toFixed(0)}s`);
        }
        if (state.mode === "fallback") return routeFallback(options);
      }

      return runPrimary(options, next, state, sessionId);
    },
    { global: true, prepend: true }
  );

  // 会话重新打开时补写待恢复的模型（定时器到期时会话不在线的情况）。
  const offCreated = ctx.on(
    "agent/created",
    ({ agent }) => {
      if (!agent || typeof agent.id !== "string") return;
      try {
        restoreIfPending(agent.id);
      } catch {
        /* 补写失败不影响会话创建 */
      }
    },
    { global: true }
  );

  // 插件重载会清空内存状态，但会话 log 里的模型选择仍然存在。
  // 若某个在线会话当前就选着备用模型，重建降级状态并补上到期定时器，
  // 否则它会永远停在备用模型上：既不再触发降级，也不会自动切回。
  const adoptDegradedSessions = () => {
    // 配置不完整时没有「备用目标」，无从接管。
    if (!isConfigured()) return;
    let list = [];
    try {
      list = ctx.get?.("agents")?.list?.() ?? [];
    } catch {
      return;
    }
    for (const agent of list) {
      const id = agent?.id;
      if (typeof id !== "string") continue;
      const state = stateOf(id);
      if (state.mode === "fallback") continue;
      const current = currentSelectionOf(id);
      if (current === undefined || !isFallbackSelection(current)) continue;
      state.mode = "fallback";
      state.switchedAt = Date.now();
      scheduleSwitchBack(id, state);
      log(
        `接管已降级的会话 ${id}: ${current.provider}/${current.model}，` +
        `${(cfg.switchBackAfterMs / 1000).toFixed(0)}s 后尝试切回`
      );
    }
  };
  adoptDegradedSessions();

  ctx.effect(
    () => () => {
      off();
      offCreated?.();
      for (const state of states.values()) clearTimer(state);
      states.clear();
    },
    "dsh-model-fallback: teardown"
  );
}
