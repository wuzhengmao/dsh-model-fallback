// 逻辑单元测试：用假 ctx 驱动 apply()，验证超时降级、低速率降级、正常透传、定时切回。
// 运行：node test/logic.test.mjs
import { apply } from "../lib/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 构造一个可控的 chunk 流。 */
async function* fakeStream(chunks, { delayBeforeFirst = 0, perChunkDelay = 0 } = {}) {
  if (delayBeforeFirst > 0) await sleep(delayBeforeFirst);
  for (const c of chunks) {
    if (perChunkDelay > 0) await sleep(perChunkDelay);
    yield c;
  }
}

/** 构造假 ctx：记录 llm.stream 调用，返回 handler 注册函数。 */
function makeCtx() {
  const state = { calls: [], handler: null, created: null, agents: new Map(), disposed: false };
  const ctx = {
    llm: {
      stream(options) {
        state.calls.push({ provider: options.provider, model: options.model });
        return state.impl(options);
      }
    },
    get(name) {
      if (name !== "agents") return undefined;
      return { get: (id) => state.agents.get(id) };
    },
    on(event, handler) {
      if (event === "llm/stream") state.handler = handler;
      if (event === "agent/created") state.created = handler;
      return () => { state.disposed = true; };
    },
    effect(fn) { fn(); }
  };
  return { ctx, state };
}


/** 构造一个假的 live agent：model.select 把选择记到 selections 里。 */
function fakeAgent(id) {
  const agent = {
    id,
    selections: [],
    events: [],
    session: { snapshotEvents: () => agent.events },
    model: {
      select(selection) {
        agent.selections.push(selection);
        agent.events = [...agent.events, { type: "model/selection", data: selection }];
        return Promise.resolve();
      }
    }
  };
  return agent;
}

/** 驱动一次完整请求，收集所有 chunk。 */
async function runRequest(state, options) {
  const it = state.handler(options, () => state.nextImpl(options))[Symbol.asyncIterator]();
  const out = [];
  for (;;) {
    const r = await it.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

const baseConfig = {
  enabled: true,
  primaryProvider: "vendor-a", primaryModels: ["primary-model"],
  fallbackProvider: "deepseek-official", fallbackModel: "deepseek-flash",
  timeoutMs: 100, windowMs: 200, minTokensPerSecond: 1000,
  switchBackAfterMs: 300, asciiTokenPerChar: 0.3, cjkTokenPerChar: 0.6
};

const textChunks = (n) => [
  { type: "block-start", index: 0, blockType: "text" },
  ...Array.from({ length: n }, (_, i) => ({ type: "text-delta", index: 0, text: "hello " })),
  { type: "block-end", index: 0, block: { type: "text", text: "hello" } },
  { type: "finish", reason: { kind: "stop" } }
];

const req = () => ({ provider: "vendor-a", model: "primary-model", messages: [{ role: "user", content: "hi" }] });

let failed = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed += 1; console.error(`  ✗ ${name} ${extra}`); }
}

// --- 用例 1：首 token 超时 → 降级重发，输出全部来自 fallback ---
{
  console.log("用例 1：首 token 超时降级");
  const { ctx, state } = makeCtx();
  apply(ctx, { ...baseConfig, timeoutMs: 100 });
  state.nextImpl = () => fakeStream(textChunks(3), { delayBeforeFirst: 500 });
  state.impl = () => fakeStream(textChunks(3));
  const out = await runRequest(state, req());
  check("产生了 fallback 调用", state.calls.some((c) => c.model === "deepseek-flash"), JSON.stringify(state.calls));
  check("输出含 fallback 内容", out.filter((c) => c.type === "text-delta").length === 3, `got ${out.filter((c) => c.type === "text-delta").length}`);
  check("无 primary 的 partial 输出混入", out.filter((c) => c.type === "text-delta").length === 3);
}

// --- 用例 2：低速率 → 当前请求不中断，只标记；下个请求走 fallback ---
{
  console.log("用例 2：低速率降级（不中断当前流）");
  const { ctx, state } = makeCtx();
  apply(ctx, { ...baseConfig, timeoutMs: 0, windowMs: 150, minTokensPerSecond: 10000 });
  // 每 60ms 一个 chunk，5 个 chunk ≈ 300ms，速率远低于 10000 tok/s
  state.nextImpl = () => fakeStream(textChunks(5), { perChunkDelay: 60 });
  state.impl = () => fakeStream(textChunks(2));
  const out = await runRequest(state, req());
  check("当前请求完整收到 primary 全部 chunk", out.filter((c) => c.type === "text-delta").length === 5, `got ${out.filter((c) => c.type === "text-delta").length}`);
  check("当前请求未触发 fallback 重发", state.calls.length === 0, JSON.stringify(state.calls));
  // 下个请求应走 fallback
  const out2 = await runRequest(state, req());
  check("下个请求走 fallback", state.calls.length === 1 && state.calls[0].model === "deepseek-flash", JSON.stringify(state.calls));
  check("下个请求输出为 fallback 内容", out2.filter((c) => c.type === "text-delta").length === 2);
}

// --- 用例 3：正常高速率 → 透传，不降级 ---
{
  console.log("用例 3：正常透传");
  const { ctx, state } = makeCtx();
  apply(ctx, { ...baseConfig, timeoutMs: 500, windowMs: 100000, minTokensPerSecond: 1 });
  state.nextImpl = () => fakeStream(textChunks(4));
  state.impl = () => fakeStream(textChunks(2));
  const out = await runRequest(state, req());
  check("输出完整", out.filter((c) => c.type === "text-delta").length === 4, `got ${out.filter((c) => c.type === "text-delta").length}`);
  check("未调用 fallback", state.calls.length === 0, JSON.stringify(state.calls));
}

// --- 用例 4：fallback 满期后切回 primary ---
{
  console.log("用例 4：满期切回 primary");
  const { ctx, state } = makeCtx();
  apply(ctx, { ...baseConfig, timeoutMs: 50, windowMs: 100000, minTokensPerSecond: 1, switchBackAfterMs: 150 });
  state.nextImpl = () => fakeStream(textChunks(2), { delayBeforeFirst: 300 });
  state.impl = () => fakeStream(textChunks(2));
  await runRequest(state, req());                    // 触发超时降级
  check("已降级到 fallback", state.calls.length === 1, JSON.stringify(state.calls));
  await runRequest(state, req());                    // 仍在降级期
  check("降级期内继续 fallback", state.calls.length === 2, JSON.stringify(state.calls));
  await sleep(200);                                  // 超过 switchBackAfterMs
  state.nextImpl = () => fakeStream(textChunks(2));  // primary 恢复快速
  await runRequest(state, req());
  check("满期后切回 primary", state.calls.length === 2, `calls=${JSON.stringify(state.calls)}`);
}

// --- 用例 5：递归请求不被再次拦截 ---
{
  console.log("用例 5：递归防重入");
  const { ctx, state } = makeCtx();
  apply(ctx, { ...baseConfig, timeoutMs: 100, windowMs: 100000, minTokensPerSecond: 1 });
  let recursiveSeen = 0;
  state.nextImpl = () => fakeStream(textChunks(2), { delayBeforeFirst: 400 });
  state.impl = (options) => {
    // 模拟递归：fallback 请求再次进入同一个 handler
    const it = state.handler(options, () => {
      recursiveSeen += 1;
      return fakeStream(textChunks(2));
    })[Symbol.asyncIterator]();
    return { [Symbol.asyncIterator]: () => it };
  };
  await runRequest(state, req());
  check("递归请求直接放行到 next()", recursiveSeen === 1, `recursiveSeen=${recursiveSeen}`);
}

// --- 用例 6：enabled=false 时不注册 ---
{
  console.log("用例 6：enabled=false 不注册");
  const { ctx, state } = makeCtx();
  apply(ctx, { ...baseConfig, enabled: false });
  check("未注册 handler", state.handler === null);
}

// --- 用例 7：监控列表外的模型原样放行，不干预用户显式选择 ---
{
  console.log("用例 7：列表外模型请求透传");
  const { ctx, state } = makeCtx();
  apply(ctx, { ...baseConfig, timeoutMs: 50, windowMs: 50, minTokensPerSecond: 99999 });
  let nextCalled = 0;
  state.nextImpl = () => { nextCalled += 1; return fakeStream(textChunks(2)); };
  const out = await runRequest(state, { provider: "vendor-a", model: "primary-model-mini", messages: [] });
  check("直接走 next()", nextCalled === 1, `nextCalled=${nextCalled}`);
  check("未调用 llm.stream 重发", state.calls.length === 0, JSON.stringify(state.calls));
  check("输出完整", out.filter((c) => c.type === "text-delta").length === 2);
}

// --- 用例 8：监控列表含多个模型，任一模型超时均被拦截降级 ---
{
  console.log("用例 8：多模型列表拦截");
  const { ctx, state } = makeCtx();
  apply(ctx, {
    ...baseConfig,
    primaryModels: ["primary-model", "primary-model-mini"],
    timeoutMs: 100
  });
  // 列表内第二个模型 primary-model-mini 超时，也应被拦截降级
  state.nextImpl = () => fakeStream(textChunks(3), { delayBeforeFirst: 400 });
  state.impl = () => fakeStream(textChunks(2));
  const out = await runRequest(state, { provider: "vendor-a", model: "primary-model-mini", messages: [] });
  check("列表内模型超时触发 fallback", state.calls.some((c) => c.model === "deepseek-flash"), JSON.stringify(state.calls));
  check("输出来自 fallback", out.filter((c) => c.type === "text-delta").length === 2, `got ${out.filter((c) => c.type === "text-delta").length}`);
}

// --- 用例 9：连接失败（next 抛错）也应降级 ---
{
  console.log("用例 9：连接失败降级");
  const { ctx, state } = makeCtx();
  apply(ctx, { ...baseConfig, timeoutMs: 5000 });
  state.nextImpl = async function* () {
    throw new Error("connect ECONNREFUSED primary.example:30000");
  };
  state.impl = () => fakeStream(textChunks(2));
  const out = await runRequest(state, req());
  check("连接失败触发 fallback", state.calls.length === 1, JSON.stringify(state.calls));
  check("输出为 fallback 内容", out.filter((c) => c.type === "text-delta").length === 2, `got ${out.filter((c) => c.type === "text-delta").length}`);
}

// --- 用例 10：错误结束帧（error finish）也应降级 ---
{
  console.log("用例 10：错误结束帧降级");
  const { ctx, state } = makeCtx();
  apply(ctx, { ...baseConfig, timeoutMs: 5000 });
  state.nextImpl = async function* () {
    yield { type: "finish", reason: { kind: "error", failure: { message: "401 unauthorized" } } };
  };
  state.impl = () => fakeStream(textChunks(2));
  const out = await runRequest(state, req());
  check("错误帧触发 fallback", state.calls.length === 1, JSON.stringify(state.calls));
  check("输出为 fallback 内容", out.filter((c) => c.type === "text-delta").length === 2, `got ${out.filter((c) => c.type === "text-delta").length}`);
}

// --- 用例 11：已产出内容后出错，不重发（避免内容重复） ---
{
  console.log("用例 11：已有输出后出错不重发");
  const { ctx, state } = makeCtx();
  apply(ctx, { ...baseConfig, timeoutMs: 5000 });
  state.nextImpl = async function* () {
    yield { type: "text-delta", index: 0, text: "partial" };
    throw new Error("connection reset");
  };
  state.impl = () => fakeStream(textChunks(2));
  let threw = false;
  try {
    await runRequest(state, req());
  } catch {
    threw = true;
  }
  check("错误继续上抛给上层", threw, "应抛出");
  check("未调用 fallback（避免内容重复）", state.calls.length === 0, JSON.stringify(state.calls));
}

// --- 用例 12：降级 / 切回时同步改写会话模型（agent.model.select） ---
{
  console.log("用例 12：同步改写会话模型");
  const { ctx, state } = makeCtx();
  const selected = [];
  ctx.get = (name) =>
    name === "agents"
      ? {
          get: (id) =>
            id === "s1"
              ? {
                  id,
                  options: {},
                  model: {
                    select(sel) {
                      selected.push({ ...sel });
                      return Promise.resolve();
                    }
                  },
                  session: { snapshotEvents: () => [] }
                }
              : undefined
        }
      : undefined;
  apply(ctx, { ...baseConfig, timeoutMs: 50, switchBackAfterMs: 150 });
  state.nextImpl = () => fakeStream(textChunks(2), { delayBeforeFirst: 300 });
  state.impl = () => fakeStream(textChunks(2));
  await runRequest(state, { ...req(), sessionId: "s1" });
  check(
    "降级时写入 fallback 选择",
    selected.length >= 1 && selected[0].model === "deepseek-flash",
    JSON.stringify(selected)
  );
  await sleep(220);
  check(
    "到期后写入首选选择",
    selected.some((s) => s.model === "primary-model"),
    JSON.stringify(selected)
  );
}

// --- 用例 13：降级期间用户自己改了别的模型 → 到期放弃切回（需求 4） ---
{
  console.log("用例 13：用户自选模型后放弃切回");
  const { ctx, state } = makeCtx();
  const selected = [];
  let userModel = { provider: "deepseek-official", model: "deepseek-flash" };
  ctx.get = (name) =>
    name === "agents"
      ? {
          get: (id) =>
            id === "s2"
              ? {
                  id,
                  options: {},
                  model: {
                    select(sel) {
                      selected.push({ ...sel });
                      return Promise.resolve();
                    }
                  },
                  session: { snapshotEvents: () => [{ type: "model/selection", data: userModel }] }
                }
              : undefined
        }
      : undefined;
  apply(ctx, { ...baseConfig, timeoutMs: 50, switchBackAfterMs: 100 });
  state.nextImpl = () => fakeStream(textChunks(2), { delayBeforeFirst: 300 });
  state.impl = () => fakeStream(textChunks(2));
  await runRequest(state, { ...req(), sessionId: "s2" });
  // 用户在此期间手动换成另一个模型
  userModel = { provider: "vendor-a", model: "other-model" };
  await sleep(180);
  check(
    "未把会话模型改回首选",
    !selected.some((s) => s.model === "primary-model"),
    JSON.stringify(selected)
  );
}

// --- 用例 14：降级状态按会话隔离 ---
{
  console.log("用例 14：会话间状态隔离");
  const { ctx, state } = makeCtx();
  apply(ctx, { ...baseConfig, timeoutMs: 60, switchBackAfterMs: 100000 });
  state.nextImpl = () => fakeStream(textChunks(2), { delayBeforeFirst: 400 });
  state.impl = () => fakeStream(textChunks(2));
  await runRequest(state, { ...req(), sessionId: "a" });
  check("会话 a 已降级", state.calls.length === 1, JSON.stringify(state.calls));
  state.nextImpl = () => fakeStream(textChunks(2));
  const outB = await runRequest(state, { ...req(), sessionId: "b" });
  check("会话 b 不受影响，仍走 primary", state.calls.length === 1, JSON.stringify(state.calls));
  check("会话 b 输出完整", outB.filter((c) => c.type === "text-delta").length === 2);
}

// --- 用例 15：定时器到期时会话不在线，下次打开补写回首选模型 ---
{
  console.log("\n用例 15：会话不在线时排队，重新打开补切回");
  const { ctx, state } = makeCtx();
  apply(ctx, { ...baseConfig, timeoutMs: 50, switchBackAfterMs: 150, minTokensPerSecond: 10000 });
  const agent = fakeAgent("s15");
  state.agents.set("s15", agent);
  state.impl = () => fakeStream(textChunks(1));
  state.nextImpl = () => fakeStream([], { delayBeforeFirst: 500 });
  await runRequest(state, { provider: "vendor-a", model: "primary-model", sessionId: "s15", messages: [] });
  check("初次降级写入 fallback", agent.selections.at(-1)?.model === "deepseek-flash");
  state.agents.delete("s15");
  await sleep(220);
  check("离线时不误改会话模型", agent.selections.at(-1)?.model === "deepseek-flash");
  state.agents.set("s15", agent);
  state.created({ agent });
  check("重新打开后补写回首选模型", agent.selections.at(-1)?.model === "primary-model");
}

// --- 用例 16：重复降级只保留一个定时器，后一次覆盖前一次 ---
{
  console.log("\n用例 16：重复降级只切回一次");
  const { ctx, state } = makeCtx();
  apply(ctx, { ...baseConfig, timeoutMs: 40, switchBackAfterMs: 200, minTokensPerSecond: 10000 });
  const agent = fakeAgent("s16");
  state.agents.set("s16", agent);
  state.impl = () => fakeStream(textChunks(1));
  state.nextImpl = () => fakeStream([], { delayBeforeFirst: 600 });
  await runRequest(state, { provider: "vendor-a", model: "primary-model", sessionId: "s16", messages: [] });
  // 用户手动切回首选模型，随后再次触发降级。
  await agent.model.select({ provider: "vendor-a", model: "primary-model" });
  await sleep(60);
  await runRequest(state, { provider: "vendor-a", model: "primary-model", sessionId: "s16", messages: [] });
  const primaryBefore = agent.selections.filter((x) => x.model === "primary-model").length;
  await sleep(320);
  check(
    "到期只切回一次（旧定时器已被覆盖）",
    agent.selections.filter((x) => x.model === "primary-model").length === primaryBefore + 1
  );
  check("两次降级都写入了 fallback", agent.selections.filter((x) => x.model === "deepseek-flash").length === 2);
}

// --- 用例 17：配置为空启动，之后补全配置应自动开始工作（不依赖重新 apply）---
{
  console.log("\n用例 17：空配置启动后补全配置自动生效");
  const { ctx, state } = makeCtx();
  // 模拟 Host 传入的配置对象：settings 保存时只就地更新它，不会重新执行 apply。
  const liveConfig = {
    enabled: true,
    primaryProvider: "",
    primaryModels: [],
    fallbackProvider: "",
    fallbackModel: "",
    timeoutMs: 60,
    windowMs: 200,
    minTokensPerSecond: 10000,
    switchBackAfterMs: 60000,
    asciiTokenPerChar: 0.3,
    cjkTokenPerChar: 0.6
  };
  apply(ctx, liveConfig);
  check("配置为空时仍然注册了 llm/stream 监听器", typeof state.handler === "function");

  state.nextImpl = () => fakeStream(textChunks(2), { delayBeforeFirst: 400 });
  state.impl = () => fakeStream(textChunks(1));
  const outEmpty = await runRequest(state, { ...req(), sessionId: "s17" });
  check("配置为空时请求原样放行", state.calls.length === 0, JSON.stringify(state.calls));
  check("配置为空时输出完整", outEmpty.filter((c) => c.type === "text-delta").length === 2);

  // 用户在设置页把四项补全：config 对象被就地更新，apply 不会重跑。
  liveConfig.primaryProvider = "vendor-a";
  liveConfig.primaryModels = ["primary-model"];
  liveConfig.fallbackProvider = "deepseek-official";
  liveConfig.fallbackModel = "deepseek-flash";

  const agent = fakeAgent("s17");
  state.agents.set("s17", agent);
  await runRequest(state, { ...req(), sessionId: "s17" });
  check("补全配置后同一实例立即接管并降级", state.calls.length === 1, JSON.stringify(state.calls));
  check("降级写入了 fallback 模型", agent.selections.at(-1)?.model === "deepseek-flash");
}

// --- 用例 18：切回目标是「降级前用户实际在用的模型」，不是拦截列表的第一个 ---
{
  console.log("\n用例 18：切回还原降级前的模型");
  const { ctx, state } = makeCtx();
  const agent = fakeAgent("s18");
  state.agents.set("s18", agent);
  apply(ctx, {
    ...baseConfig,
    primaryModels: ["primary-model", "primary-model-mini"],
    timeoutMs: 50, windowMs: 100000, minTokensPerSecond: 1, switchBackAfterMs: 120
  });
  state.nextImpl = () => fakeStream(textChunks(2), { delayBeforeFirst: 300 });
  state.impl = () => fakeStream(textChunks(2));
  const request = () => ({
    provider: "vendor-a", model: "primary-model-mini", sessionId: "s18", messages: []
  });
  // 用户在拦截列表里的第二个模型上发起请求
  await runRequest(state, request());
  check("已降级", state.calls.length === 1, JSON.stringify(state.calls));
  check("降级写入 fallback", agent.selections.at(-1)?.model === "deepseek-flash", JSON.stringify(agent.selections));
  await sleep(200);
  state.nextImpl = () => fakeStream(textChunks(2));
  await runRequest(state, request());
  const last = agent.selections.at(-1);
  check(
    "切回写回降级前的 primary-model-mini，而不是列表第一个 primary-model",
    last?.model === "primary-model-mini",
    JSON.stringify(agent.selections)
  );
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);