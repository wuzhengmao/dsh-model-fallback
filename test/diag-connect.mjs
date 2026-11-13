// 诊断：连接失败（next() 抛错）时插件是否降级
import { apply } from "../lib/index.js";

function makeCtx() {
  const state = { calls: [], handler: null };
  const ctx = {
    llm: { stream(o) { state.calls.push(o.model); return state.impl(o); } },
    on(_e, h) { state.handler = h; return () => {}; },
    effect(fn) { fn(); }
  };
  return { ctx, state };
}

const cfg = {
  enabled: true, primaryProvider: "vendor-a", primaryModels: ["primary-model"],
  fallbackProvider: "vendor-a", fallbackModel: "model-lite",
  timeoutMs: 5000, windowMs: 30000, minTokensPerSecond: 30,
  switchBackAfterMs: 600000, asciiTokenPerChar: 0.3, cjkTokenPerChar: 0.6
};

const { ctx, state } = makeCtx();
apply(ctx, cfg);

// 场景 A：next() 返回的流在第一次 next() 时抛错（连接被拒）
state.nextImpl = async function* () {
  throw new Error("connect ECONNREFUSED primary.example:30000");
};
state.impl = async function* () {
  yield { type: "text-delta", index: 0, text: "fallback ok" };
  yield { type: "finish", reason: { kind: "stop" } };
};

try {
  const it = state.handler({ provider: "vendor-a", model: "primary-model", messages: [] }, () => state.nextImpl())[Symbol.asyncIterator]();
  const out = [];
  for (;;) { const r = await it.next(); if (r.done) break; out.push(r.value); }
  console.log("场景A 输出:", JSON.stringify(out));
  console.log("场景A fallback 调用次数:", state.calls.length);
} catch (e) {
  console.log("场景A 抛出异常:", e.message);
  console.log("场景A fallback 调用次数:", state.calls.length, "← 0 表示没降级，BUG");
}
