// dsh-pet 桌宠桥接插件（仅使用 DSH 提供的 LLM 服务，不主动联网）
// 订阅 DSH 的 agent 生命周期事件，追加写入共享桥目录的 dsh-{pid}.jsonl
//（多实例分区；消费端 glob dsh*.jsonl，兼容旧单文件 dsh.jsonl），
// 桌宠侧的 DshMonitor 通过 byte-offset tail 读取（不回放历史）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";

// ===== 零依赖红线 =====
// 本插件必须保持零外部依赖：profile 经 pnpm 的 link: 协议链接到本目录，
// pnpm 不会安装被链接包自己的依赖；而链接目标常常是打包版桌宠
// _internal 内的副本（CI 构建不带 node_modules）。一旦此处声明运行时依赖，
// 依赖解析失败会让 Cordis 插件树初始化整体抛错、DSH 无法启动（2026-09 事故：
// 作者与多用户 dsh 全 profile 起不来）。因此 user-message envelope 手写，
// 形状与 @deepseek-ai/dsh-llm 的 createUserMessage 完全对齐——
// {...input, role: "user", id: randomUUID()}，structuredClone 后深冻结。
// dsh 升级 envelope 形状时这里必须同步（inject 的 llm.stream / steer 消费它）。
function deepFreezeMessage(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreezeMessage(value[key], seen);
  return Object.freeze(value);
}

// dsh createUserMessage 的本地等价物：补齐 role/id，返回不可变快照。
function createUserMessage(input) {
  const message = structuredClone({ ...input, role: "user", id: randomUUID() });
  return deepFreezeMessage(message);
}

const MAX_BYTES = 1024 * 1024; // 事件文件超过 1MB 时轮转（保留 .1 备份，防无限增长）
const PLUGIN_ID = "dsh-pet-bridge";
// These services are resolved by DSH when the plugin is loaded.  The bridge
// uses them only for the watchdog's isolated diagnosis request; normal event
// forwarding remains usable even when no model is configured.
//
// 注意 `agents` **故意不进 inject**：Cordis 的严格代理对未声明服务直接抛
// "cannot get property ... without inject"（vendor/cordis/src/reflect.ts:144），
// 但 inject 是**强依赖**——服务若未激活，整个插件会停在 PENDING 不 apply，
// 那会连既有的状态/气泡转发一起失效。改用 Cordis 提供的非严格读取
// `ctx.get(name, false)`（缺失返回 undefined），与本文件读 apiProxy 的做法一致。
// 见 agentRegistry()。
const inject = ["llm", "agentDefaultModel"];
const CONTROL_POLL_MS = 150;
const CONTROL_MAX_CONTEXT = 12000;
const CONTROL_MAX_REQUEST_AGE_MS = 10 * 60 * 1000;

// 进程内状态去重 + 多 Agent 聚合：
// 1) dsh 在 agent 创建/状态切换瞬间会抖动出重复 idle（实测 idle→working 仅隔
//    4ms），重复聚合状态不落盘——否则桌宠端 2 秒换帧节流会吞掉真实 working。
// 2) 必须按 agent 分别跟踪再聚合（任一在忙 = 忙）：dsh 可并发多个 agent
//   （子代理/多会话），全局单值去重会让先完成的 agent 把还在干活的顶成 idle。
const agentStates = new Map(); // agent 对象 → "working" | "idle"
const liveAgents = new Map(); // agent/session id → agent object
const knownSessions = new Set();
const sessionMetaCache = new Map(); // sessionId → { sessionName, projectName, agentName }
let metadataRefreshPromise = null;
let metadataRefreshTimer = null;
let lastState = null;

function aggregateWrite() {
  const anyBusy = [...agentStates.values()].some((s) => s === "working");
  const next = anyBusy ? "working" : "idle";
  if (next === lastState) return;
  lastState = next;
  writeRecord({ state: next });
}

// 连接/超时类失败错误码（与下方 isModelAccessError 共用；DSH 的 llm/retry 里
// 错误码不统一，消息必含超时或连接断词，码+消息两者归一判定）。
const MODEL_ACCESS_CONN_CODES = new Set([
  "TIMEOUT", "REQUEST_TIMEOUT", "UPSTREAM_TIMEOUT", "ETIMEDOUT",
  "ESOCKETTIMEDOUT", "ECONNABORTED", "ECONNRESET", "ECONNREFUSED",
  "EPIPE", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "NETWORK_ERROR",
]);

// 判定是否为模型访问失败（服务端限流/过载，或上游响应连接/超时类故障）。
// DSH 实测 errorCode 为 "RATE_LIMIT"（消息如 "429: ..."），偶见直接 "429"；
// 网络类故障常见 errorCode 为 "TIMEOUT"/"ETIMEDOUT" 等（消息形如
// "upstream stream read failed before completion: upstream response headers
// timed out before streaming started"）。连接/超时与限流同样属于「本次模型
// 请求未成功、进入重试链」的异常，累计到阈值后也必须提醒桌宠（见下方
// RETRY_EVENT_THRESHOLD 注释）。必须同时匹配 code 与 message，避免漏判。
function isModelAccessError(code, message) {
  const c = String(code || "").trim().toUpperCase();
  const m = String(message || "");
  if (c === "RATE_LIMIT" || c === "429" || c === "TOO_MANY_REQUESTS") return true;
  if (m.startsWith("429") || /\b429\b/.test(m) || /rate.?limit/i.test(m)) return true;
  if (MODEL_ACCESS_CONN_CODES.has(c)) return true;
  return /\btimed?\s?out\b|timed out before|connection (reset|refused|aborted|closed|reset by peer)|network (error|unreachable|is unreachable)|socket hang up|eai_again|read ?ec 0|econnreset|etimedout/i.test(m);
}

// 桥目录必须与桌宠端一致：win32=%APPDATA%，darwin=~/Library/Application Support，其他=~/.config
function bridgeDir() {
  if (process.platform === "win32") {    return path.join(process.env.APPDATA || os.homedir(), "dsh-pet-bridge");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "dsh-pet-bridge");
  }
  return path.join(os.homedir(), ".config", "dsh-pet-bridge");
}

/**
 * 诊断日志：宿主日志在桌面端不落盘，而"插件有没有认领聊天请求"这种事
 * 没有任何可见通道（`writeRecord` 只写状态事件）。
 * 写 `~/.dsh/pet-bridge-diag.log`；写失败绝不抛错。
 */
function diag(...args) {
  try {
    const text = args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    const target = path.join(process.env.USERPROFILE || os.homedir(), ".dsh", "pet-bridge-diag.log");
    fs.appendFileSync(target, `[${new Date().toISOString().slice(11, 19)}] ${text}\n`);
  } catch { /* 诊断失败绝不影响主流程 */ }
}

/**
 * 桌宠自己的数据目录（win32: %APPDATA%\dsh-pet-standalone-webm-chat）。
 *
 * 为什么需要它：**桌宠进程写不进桥接目录**（实测 PermissionError 13），
 * 但读没问题。所以"桌宠写、插件读"的那一半（只有 chat-request）落在桌宠
 * 可写的这里，由本插件的轮询一并认领；插件写、桌宠读的方向保持桥接目录不变。
 * 目录名与 pet/config.py 的 APP_DIR_NAME 一致。
 */
function petRequestDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || os.homedir(), "dsh-pet-standalone-webm-chat");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "dsh-pet-standalone-webm-chat");
  }
  return path.join(os.homedir(), ".config", "dsh-pet-standalone-webm-chat");
}

function controlRequestPath(id) {
  return path.join(bridgeDir(), `watchdog-request-${id}.json`);
}

function controlResponsePath(id) {
  return path.join(bridgeDir(), `watchdog-response-${id}.json`);
}

function writeControlResponse(id, result) {
  try {
    fs.mkdirSync(bridgeDir(), { recursive: true });
    fs.writeFileSync(controlResponsePath(id), JSON.stringify({
      id, ts: Date.now(), ...result,
    }), "utf8");
  } catch (err) {
    // The response file is a convenience for the pet.  Never affect the Agent.
  }
}

// 非严格读取 Agent 注册表：不写进 inject（见 inject 处注释），缺失时返回 null。
// 这是「插件加载前就已存在的会话」也能投递的关键——那种会话不在 liveAgents 里。
function agentRegistry(ctx) {
  try {
    if (typeof ctx?.get !== "function") return null;
    const registry = ctx.get("agents", false);
    return registry && typeof registry.get === "function" ? registry : null;
  } catch (err) {
    console.warn(`[${PLUGIN_ID}] agents service lookup unavailable: ${String(err?.message || err)}`);
    return null;
  }
}

function controlAgent(ctx, sessionId) {
  const id = String(sessionId || "");
  if (!id) return null;
  const live = liveAgents.get(id);
  if (live) return live;
  // 不直接 ctx.agents.get：未声明服务会被严格代理抛错（历史上被这里的
  // try/catch 静默吞掉，导致 controlAgent 永远只认 liveAgents）。
  return agentRegistry(ctx)?.get?.(id) || null;
}

function agentBelongsToLiveSession(agent, sessionId) {
  if (!agent) return false;
  const id = String(sessionId);
  return liveAgents.get(id) === agent ||
    liveAgents.get(String(agent.id || "")) === agent ||
    liveAgents.get(String(agent.session?.id || "")) === agent;
}

function controlAgentState(agent) {
  return String(agent?.status || agent?.state || "unknown");
}

// ===== 子代理 → 根会话归一 =====
// DSH 的会话在持久化 header 里携带谱系：parentSession（直接父会话 id）、
// delegationDepth（顶层为 0/缺省，子代理 = 父级深度 + 1）、origin === "subagent"
// （直接子代理标记）。运行时 Agent 经 session.header 暴露该 header。
// 控制动作（interrupt/replan）打在一个子代理上时，主 agent 会立刻补派新的
// 子代理——用户视角「终止没用」。因此把控制归一到目标会话的根会话：
//   子代理链上的 agent 统一作用到其最高可解析的存活祖先（根）；
//   顶层 session 直接作用自身。
// 返回的对象同时给出 wasSubagent / appliedToRoot / rootSessionId / subagentChain，
// 供 pet 侧区分「已终止会话（含子代理）」与「已终止子代理（主代理仍在运行）」。
function resolveControlRoot(agent, sessionLookup) {
  const sessionIdOf = (a) => String(a?.id || a?.session?.id || "");
  const headerOf = (a) => (a && a.session && a.session.header) || null;
  const isSubagentHeader = (a) => {
    const h = headerOf(a);
    if (!h) return false;
    return Number(h.delegationDepth || 0) > 0 ||
      String(h.origin || "") === "subagent" ||
      String(h.parentSession || "") !== "";
  };
  const targetSessionId = sessionIdOf(agent);
  if (!isSubagentHeader(agent)) {
    return {
      targetSessionId,
      wasSubagent: false,
      appliedToRoot: false,
      rootAgent: agent,
      rootSessionId: targetSessionId,
      subagentChain: [],
    };
  }
  // 沿 parentSession 谱系向上，尽可能解析到最高存活的祖先。
  const chain = [];
  let current = agent;
  const seen = new Set();
  while (current) {
    const sid = sessionIdOf(current);
    if (!sid || seen.has(sid)) break;
    seen.add(sid);
    chain.push(sid);
    const h = headerOf(current);
    const parent = h && h.parentSession ? String(h.parentSession) : "";
    if (!parent) break;
    const parentAgent = (typeof sessionLookup === "function") ? sessionLookup(parent) : null;
    if (!parentAgent || parentAgent === current) break;
    current = parentAgent;
  }
  const appliedToRoot = chain.length > 1 && current !== agent;
  const rootAgent = appliedToRoot ? current : agent;
  return {
    targetSessionId,
    wasSubagent: true,
    appliedToRoot,
    rootAgent,
    rootSessionId: sessionIdOf(rootAgent),
    subagentChain: chain,
  };
}

async function waitAgentIdle(agent, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = controlAgentState(agent);
    if (state === "idle" || state === "cancelled" || state === "stopped") return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

function currentModelSelection(ctx, request) {
  const provider = String(request.provider || "");
  const model = String(request.model || "");
  if (provider && model) return { provider, model };
  const selection = typeof ctx.agentDefaultModel?.currentSelection === "function"
    ? ctx.agentDefaultModel.currentSelection() : null;
  return {
    provider: provider || String(selection?.provider || ""),
    model: model || String(selection?.model || ""),
  };
}

async function runBridgeDiagnosis(ctx, request, signal) {
  if (typeof ctx.llm?.stream !== "function") throw new Error("llm-unavailable");
  const selection = currentModelSelection(ctx, request);
  if (!selection.provider || !selection.model) throw new Error("judge-model-unavailable");
  const context = String(request.context || "").slice(0, CONTROL_MAX_CONTEXT);
  const goal = String(request.goal || "").slice(0, 2000);
  const prompt = [
    "你是执行中的 Agent 的独立规划诊断器。不要调用工具，不要泛泛解释。",
    "根据当前用户目标和最近一个步骤批次，输出一份可以直接交给 Agent 执行的下一步计划。",
    "计划必须包含：当前目标、最强假设、支持证据、反对证据、下一项最小可证伪实验；",
    "完成前避免继续无目的 Search/Read。只输出计划正文，不要输出 JSON、前言或道歉。",
    `当前用户目标：${goal || "（未知）"}`,
    `最近上下文：\n${context || "（无）"}`,
  ].join("\n\n");
  const messages = [createUserMessage({
    content: [{ type: "text", text: prompt }],
    source: { kind: `plugin:${PLUGIN_ID}` },
  })];
  let output = "";
  let reasoning = "";
  for await (const chunk of ctx.llm.stream({
    provider: selection.provider,
    model: selection.model,
    messages,
    // 推理型模型会先消耗 token 在 reasoning 上，700 经常被吃光导致正文为空
    // （实机复现：empty-diagnosis）。给足预算，正文才出得来。
    maxTokens: 2048,
    purpose: "dsh-pet-watchdog-replan",
    signal,
  })) {
    if (chunk?.type === "text-delta") output += String(chunk.text || "");
    else if (chunk?.type === "reasoning-delta" || chunk?.type === "reasoning") reasoning += String(chunk.text || "");
  }
  output = output.trim();
  if (!output) {
    console.warn(`[${PLUGIN_ID}] diagnosis empty (reasoning ${reasoning.length} chars, model ${selection.provider}/${selection.model})`);
    throw new Error("empty-diagnosis");
  }
  return output.slice(0, CONTROL_MAX_CONTEXT);
}

async function handleControlRequest(ctx, request) {
  const id = String(request?.id || "");
  const operation = String(request?.operation || "");
  const sessionId = String(request?.sessionId || "");
  if (!id || !sessionId || !["interrupt", "replan"].includes(operation)) {
    return { ok: false, operation, sessionId, phase: "invalid", error: "invalid-control-request", foundAgent: false, cancelInvoked: false };
  }
  if (Date.now() - Number(request.ts || 0) > CONTROL_MAX_REQUEST_AGE_MS) {
    return { ok: false, operation, sessionId, phase: "stale", error: "stale-control-request", foundAgent: false, cancelInvoked: false };
  }
  const agent = controlAgent(ctx, sessionId);
  writeRecord({ event: "bridge/control-received", requestId: id, sessionId,
    operation, foundAgent: !!agent && agentBelongsToLiveSession(agent, sessionId), agentState: controlAgentState(agent) });
  const foundAgent = !!agent && agentBelongsToLiveSession(agent, sessionId);
  if (!foundAgent) {
    if (operation === "interrupt" && knownSessions.has(sessionId)) {
      return { ok: true, operation, sessionId, phase: "already-idle", alreadyIdle: true, foundAgent: false, cancelInvoked: false };
    }
    return { ok: false, operation, sessionId, phase: "not-found", error: "session-not-found", foundAgent: false, cancelInvoked: false };
  }
  // 把控制归一到根会话：子代理 → 其最高存活祖先；顶层 session → 自身。
  // 这样 interrupt 停根 agent 的当前回合（主 agent 不会再补派新子代理），
  // replan 给根 agent 注入重规划建议，而不是只作用于空转的子代理。
  const resolved = resolveControlRoot(agent, (sid) => liveAgents.get(String(sid)));
  const controlTarget = resolved.appliedToRoot ? resolved.rootAgent : agent;
  const rootNorm = {
    wasSubagent: resolved.wasSubagent,
    appliedToRoot: resolved.appliedToRoot,
    rootSessionId: resolved.rootSessionId,
    subagentChain: resolved.subagentChain,
  };
  let cancelInvoked = false;
  try {
    if (operation === "interrupt") {
      // Terminate means terminate: discard pending watchdog/user steering too.
      await controlTarget.cancel("dsh-pet-watchdog", { keepInbox: false });
      cancelInvoked = true;
      // 用户点的是这个子代理：主 agent 的回合取消未必级联到已发布的子代理
      // 自身 driver，显式再停一次目标，确保用户看到的那个空转子代理确实停下。
      if (resolved.appliedToRoot && agent !== controlTarget) {
        try { agent.cancel("dsh-pet-watchdog", { keepInbox: false }); } catch {}
      }
      if (await waitAgentIdle(controlTarget)) {
        return { ok: true, operation, sessionId, phase: "cancelled", alreadyIdle: false, foundAgent: true, cancelInvoked, ...rootNorm };
      }
      return { ok: false, operation, sessionId, phase: "timeout", error: "cancel-timeout", foundAgent: true, cancelInvoked, ...rootNorm };
    }
    // Stop the active driver first.  keepInbox is essential: it prevents a
    // watchdog request from deleting ordinary queued Agent input.
    await controlTarget.cancel("dsh-pet-watchdog-replan", { keepInbox: true });
    cancelInvoked = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(request.timeoutMs || 8000)));
    let plan;
    try {
      plan = await runBridgeDiagnosis(ctx, request, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
    await controlTarget.steer(createUserMessage({
      content: [{ type: "text", text: plan }],
      source: { kind: `plugin:${PLUGIN_ID}` },
    }));
    return { ok: true, operation, sessionId, phase: "replanned", plan, foundAgent: true, cancelInvoked, ...rootNorm };
  } catch (err) {
    console.warn(`[${PLUGIN_ID}] control failed: ${String(err?.message || err)}`);
    return { ok: false, operation, sessionId, phase: "failed", error: "bridge-internal-error", foundAgent: true, cancelInvoked, ...rootNorm };
  }
}

function writeControlOutcome(id, request, result) {
  const controlResult = { source: "bridge", requestId: id, operation: request.operation,
    sessionId: request.sessionId, ok: !!result.ok, phase: result.phase || "",
    error: result.error || "", alreadyIdle: !!result.alreadyIdle,
    foundAgent: !!result.foundAgent, cancelInvoked: !!result.cancelInvoked,
    wasSubagent: !!result.wasSubagent, appliedToRoot: !!result.appliedToRoot,
    rootSessionId: String(result.rootSessionId || "") };
  writeControlResponse(id, result);
  writeRecord({ event: "bridge/control-result", ...controlResult });
  writeRecord({ event: "watchdog/control-result", ...controlResult });
}

function startControlQueue(ctx) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    let names = [];
    try {
      names = fs.readdirSync(bridgeDir()).filter(name => name.startsWith("watchdog-request-") && name.endsWith(".json"));
    } catch { return; }
    for (const name of names) {
      const id = name.slice("watchdog-request-".length, -".json".length);
      const source = path.join(bridgeDir(), name);
      const claimed = path.join(bridgeDir(), `watchdog-processing-${id}.json`);
      try { fs.renameSync(source, claimed); } catch { continue; }
      busy = true;
      try {
        let request;
        try { request = JSON.parse(fs.readFileSync(claimed, "utf8")); }
        catch { request = { id, operation: "", sessionId: "" }; }
        const result = await handleControlRequest(ctx, request);
        writeControlOutcome(id, request, result);
      } catch (err) {
        console.warn(`[${PLUGIN_ID}] control internal error: ${String(err?.message || err)}`);
        writeControlOutcome(id, request || { operation: "", sessionId: "" }, {
          ok: false, phase: "failed", error: "bridge-internal-error", foundAgent: false, cancelInvoked: false,
        });
      } finally {
        try { fs.rmSync(claimed, { force: true }); } catch {}
        busy = false;
      }
      break;
    }
  }, CONTROL_POLL_MS);
  if (timer.unref) timer.unref();
  ctx.effect?.(() => () => clearInterval(timer), `${PLUGIN_ID}.control-queue()`);
}

// 过程汇报：工具调用事件（state 不变，只带 tool 字段，桌宠端据此弹「正在跑命令…」）
// 注：工具名在 assistant/message 的 tool-call 块与独立 tool/call 事件中均可获得，
// 统一按 callId 去重写入（见下方 session/event 处理），不再单独 writeTool。

// ===== 卡住检测数据增强 =====
// 桌宠端 stuck_detector 需要只读的最终结果观察点。这里在转发事件时附带
// 轻量字段（工具名、参数指纹、成败、错误码/文本、耗时），不改变任何 DSH 流程。
const ARGS_KEY_LENGTH = 64;
const TEXT_MAX = 300;

// ===== 硬失败判定（execution/failed）=====
// 规则：只有 DSH 以「本轮出错的 turn 结尾」为真才可能提醒，正常完成绝不误报。
//   DSH 的 turn/end 自带 data.reason.kind：completed / error / aborted /
//   blocked / max-tokens。completed（正常收尾）等非 error 结尾一律不判失败——
//   即使中途出现过模型重试或工具失败、之后又恢复并正常跑完。
//   真·重试耗尽 = 连续 llm/retry 后 DSH 抛错 → reason.kind === "error"。
//   工具最终失败同理：只有 turn 以 error 结尾且本 turn 有工具失败无成功才判。
// 重试计数只在 turn 内生效，且「恢复即清零」：出现模型成功产出（assistant/
// message、tool/call、成功的 tool/result）就把 retries 归零——只统计距离上次
// 恢复后的连续重试，绝不把不同时段已恢复的抖动累加成长期故障。
// 只在 turn/end 时判定并写一条脱敏记录（错误码保留、错误正文不落盘）。
const RETRY_EXHAUSTED_THRESHOLD = 4;
// 限流/连接超时类重试只在同一 session 连续达到 5 次时提醒一次（识别口径与
// isModelAccessError 一致：429/RATE_LIMIT 与 TIMEOUT/连接断类故障都算）。
// 原始 llm/retry 仍然逐条转发，便于桌宠侧做详细诊断；这里只抑制高优先级
// model_access 事件，避免一次短暂抖动连续轰炸桌宠。
const RETRY_EVENT_THRESHOLD = 5;

// 每个 turn 的状态：sessionKey -> {retries, hadSuccess, hadFailure,
//   lastErrorCode, lastErrorMessage, lastRetryCode, turnActive}
// retries = 距上次恢复后的连续模型重试次数（恢复即清零，见上方规则）。
const turnStatsMap = new Map();

// sessionKey -> { count, notified }
// 只统计连续的 llm/retry 限流事件。任意其他 session 事件、连接成功或 Agent
// 状态变化都会清零，因此不会把不同阶段的重试拼成一次长期故障。
const retryConnectionStats = new Map();

function resetRetryConnection(sessionKey) {
  retryConnectionStats.delete(String(sessionKey || "session:unknown"));
}

function noteRetryConnection(sessionKey) {
  const key = String(sessionKey || "session:unknown");
  const current = retryConnectionStats.get(key) || { count: 0, notified: false };
  current.count += 1;
  retryConnectionStats.set(key, current);
  if (current.count !== RETRY_EVENT_THRESHOLD || current.notified) return false;
  current.notified = true;
  return true;
}

// 用于硬失败判定的 session 键：优先 session.id，回退到 event.data.turn
function sessionKeyOf(_session, event) {
  if (_session && _session.id) return String(_session.id);
  const data = (event && event.data) || {};
  if (data && data.turn) return "turn:" + String(data.turn);
  return "session:unknown";
}

function _turnStats(sessionKey) {
  if (!turnStatsMap.has(sessionKey)) {
    turnStatsMap.set(sessionKey, {
      retries: 0, hadSuccess: false, hadFailure: false,
      lastErrorCode: "", lastErrorMessage: "", lastRetryCode: "", turnActive: false,
    });
  }
  return turnStatsMap.get(sessionKey);
}

function _endTurnStats(sessionKey) {
  turnStatsMap.delete(sessionKey);
}

// turn 开始/异常兜底：把单个 turn 统计重置为全新状态（绝不跨 turn 累计）。
function resetTurnStats(st) {
  st.retries = 0;
  st.hadSuccess = false;
  st.hadFailure = false;
  st.lastErrorCode = "";
  st.lastErrorMessage = "";
  st.lastRetryCode = "";
  st.turnActive = true;
  return st;
}

// 记录一次模型重试：只累加连续计数（恢复信号会把 retries 归零），并记住
// 最后一次重试的错误码（重试耗尽时 execution/failed 用它标注根因）。
function noteStatsRetry(st, errorCode) {
  st.retries += 1;
  if (errorCode) st.lastRetryCode = String(errorCode).slice(0, 48);
}

// 「恢复即清零」：模型成功产出/流程继续推进 → 连续重试计数归零。绝不把已经
// 恢复的抖动计入「重试耗尽」（否则正常完成的 turn 会被误判成硬失败）。
function noteStatsRecovery(st) {
  st.retries = 0;
}

// 记录一次工具结果对硬失败判定的影响（turn/start 重置，tool/result 累计）
function noteStatsToolResult(st, ok, errorCode, errorMessage) {
  st.turnActive = true;
  if (ok) {
    st.hadSuccess = true;
    // 工具执行成功说明模型调用链已恢复推进——同一 turn 内此前任何模型
    // 重试都不再计入「耗尽」判定（与恢复信号同语义）。
    st.retries = 0;
  } else {
    st.hadFailure = true;
    if (errorCode) st.lastErrorCode = String(errorCode).slice(0, 48);
    if (errorMessage) st.lastErrorMessage = truncate(errorMessage);
  }
}

// 按 sessionKey 包装（生产事件路径使用）：
function noteTurnRetry(sessionKey, errorCode) {
  noteStatsRetry(_turnStats(sessionKey), errorCode);
}

function noteTurnRecovery(sessionKey) {
  noteStatsRecovery(_turnStats(sessionKey));
}

function noteTurnToolResult(sessionKey, ok, errorCode, errorMessage) {
  noteStatsToolResult(_turnStats(sessionKey), ok, errorCode, errorMessage);
}

// turn/end 时的硬失败判定（纯函数，供 Node 回归测试直接驱动）：
// 只认 DSH 的 reason.kind === "error"（本轮真的出错终止）；completed /
// aborted / blocked / max-tokens / reason 缺失 → 一律不写 execution/failed。
// 返回要写盘的对象（含脱敏错误码），或 null（不提醒）。
function decideTurnEndFailure(reason, st) {
  if (!st || !st.turnActive) return null;
  const kind = reason && reason.kind ? String(reason.kind) : "";
  if (kind !== "error") return null;
  const retryExhausted = st.retries >= RETRY_EXHAUSTED_THRESHOLD;
  const toolFailed = st.hadFailure && !st.hadSuccess;
  if (!retryExhausted && !toolFailed) return null;
  const reasonCode = reason && reason.error && reason.error.code
    ? String(reason.error.code) : "";
  // 错误码按失败来源选取（只落码不落错误正文）：
  //   模型重试耗尽 → 最近一次 llm/retry 错误码，缺省回退 turn/end 终止错误码
  //   工具最终失败 → 工具错误码，缺省回退终止错误码（generic 码没有工具码信息量大）
  const errorCode = retryExhausted
    ? String(st.lastRetryCode || reasonCode || st.lastErrorCode || "")
    : String(st.lastErrorCode || reasonCode || "");
  return {
    event: "execution/failed",
    // failureType 与活动/过程事件（tool/call 的 tool）解耦：模型重试耗尽 =
    // 模型请求链连续重试后仍失败；tool_failed = 工具调用最终失败。不再是
    // 语义含糊的 "tool"/"model_request"，也不会与协议保留字段 source（Agent
    // 来源）撞名。
    failureType: retryExhausted ? "model_retry_exhausted" : "tool_failed",
    retryExhausted: !!retryExhausted,
    retries: st.retries,
    errorCode: errorCode.slice(0, 48),
    errorMessage: String(st.lastErrorMessage || ""),
  };
}

function summarizeArgs(args) {
  if (args === undefined || args === null) return "";
  let obj = args;
  if (typeof obj === "string") {
    try { obj = JSON.parse(obj); } catch { return String(obj).slice(0, ARGS_KEY_LENGTH); }
  }
  if (typeof obj !== "object" || Array.isArray(obj)) {
    return JSON.stringify(obj).slice(0, ARGS_KEY_LENGTH);
  }
  const keys = Object.keys(obj).sort();
  const parts = keys.map(k => String(k));
  // 命令型工具：加入 argv[0]（如 pip/curl/npm）使「同命令换参数」聚成同一指纹
  const cmdKeys = ["command", "cmd", "shell", "script", "argv", "exec"];
  for (const k of cmdKeys) {
    const v = obj[k];
    if (v !== undefined && v !== null) {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      const argv0 = s.trim().split(/\s+/)[0];
      if (argv0) parts.push("argv0:" + argv0.slice(0, 48));
      break;
    }
  }
  return parts.slice(0, 16).join(",").slice(0, ARGS_KEY_LENGTH);
}

// Keep the command that is actually executed separate from user-facing tool
// descriptions.  The watchdog compares execution semantics; labels such as
// "Read file 1st time" must not make identical commands look different.
function commandFromArgs(args) {
  if (args === undefined || args === null) return "";
  let obj = args;
  if (typeof obj === "string") {
    try { obj = JSON.parse(obj); } catch { return ""; }
  }
  if (!obj || typeof obj !== "object") return "";
  for (const key of ["command", "cmd", "shell", "script", "exec", "argv"]) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    return truncate(typeof value === "string" ? value : JSON.stringify(value), 800);
  }
  return "";
}

function truncate(s, max = TEXT_MAX) {
  if (typeof s !== "string") s = String(s || "");
  return s.length > max ? s.slice(0, max) : s;
}

function messageText(data) {
  const d = data || {};
  for (const value of [d.text, d.prompt, d.message && d.message.text]) {
    if (typeof value === "string" && value.trim()) return truncate(value.trim(), 1200);
  }
  const content = (d.message && d.message.content) || d.content;
  if (typeof content === "string") return truncate(content.trim(), 1200);
  if (!Array.isArray(content)) return "";
  return truncate(content.map(block => {
    if (typeof block === "string") return block;
    return block && typeof block.text === "string" ? block.text : "";
  }).filter(Boolean).join(" ").replace(/\s+/g, " ").trim(), 1200);
}

function agentLabelFor(sessionId) {
  const agent = liveAgents.get(String(sessionId));
  if (!agent) return "DSH";
  return String(agent.name || agent.displayName || agent.label || agent.id || "DSH");
}

function basenameOf(value) {
  const raw = String(value || "").trim().replace(/[\\/]+$/, "");
  if (!raw) return "";
  return raw.split(/[\\/]/).pop() || "";
}

function sessionIdOfAgent(agent, session) {
  return String(agent?.session?.id || agent?.id || session?.id || "");
}

function projectionTitle(session) {
  const values = session?.projections?.values;
  const title = values && typeof values === "object" ? values.title : "";
  return typeof title === "string" && title.trim() ? title.trim() : "";
}

function extractSessionMeta(agent, session, summary = null, workspace = null) {
  if (!agent && !session && !summary) return null;
  const sessionId = String(summary?.sessionId || sessionIdOfAgent(agent, session));
  if (!sessionId) return null;

  // 运行时 Session 没有 UI 名称；真实标题来自 session.list 的 summary.projections.title。
  const sessionName = String(
    summary?.projections?.values?.title || projectionTitle(session) ||
    session?.title || session?.label || session?.name || "",
  ).trim();
  // 真实项目名来自 workspace.list 的 title；cwd 只作最后的真实 basename 降级。
  const projectName = String(
    workspace?.title || basenameOf(workspace?.path) || basenameOf(summary?.cwd) ||
    basenameOf(session?.cwd) || "",
  ).trim();
  const agentName = String(agent?.name || agent?.displayName || "DSH").trim() || "DSH";

  const parts = ["DSH"];
  if (projectName) parts.push(projectName);
  if (sessionName) parts.push(sessionName);
  const displayLabel = parts.join(" · ");
  return { sessionId, sessionName, projectName, agentName, displayLabel };
}

// apiProxy 缺失（当前 dsh 发布版无此服务）时的真实标题兜底：
// dsh 把会话标题/工作目录缓存在 ~/.dsh/storages/session_projcache/sessions/<sid>.json。
function readProjcacheSummary(sessionId) {
  const sid = String(sessionId || "");
  if (!sid) return null;
  const candidates = sid.startsWith("session-") ? [sid] : [sid, `session-${sid}`];
  for (const name of candidates) {
    try {
      const file = path.join(os.homedir(), ".dsh", "storages", "session_projcache", "sessions", `${name}.json`);
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const title = data?.record?.rows?.title?.val;
      const cwd = data?.record?.identity?.cwd;
      if (!title && !cwd) continue;
      return { sessionId: name, cwd: cwd || "", projections: { values: { title: title || "" } } };
    } catch { /* 缓存不存在或损坏：跳过 */ }
  }
  return null;
}

async function refreshSessionMetadata(ctx) {
  if (metadataRefreshPromise) return metadataRefreshPromise;
  metadataRefreshPromise = (async () => {
    try {
      // apiProxy 不进 inject（当前 dsh 发布版无此服务，强依赖会让插件无法激活）；
      // 用 ctx.get 免 inject 读取，缺失时返回 undefined。
      const api = typeof ctx?.get === "function" ? ctx.get("apiProxy", false) : undefined;
      if (!api?.sessions?.list || !api?.workspace?.list) {
        // 兜底：读 dsh 本地会话缓存投影出 summary，复用同一条写 meta 通路。
        for (const [id, agent] of liveAgents) {
          const sid = String(agent?.session?.id || id);
          writeSessionMeta(agent, agent?.session, readProjcacheSummary(sid), null);
        }
        return;
      }
      const request = () => ({ rpcId: randomUUID(), payload: {} });
      const [sessionsResponse, workspacesResponse] = await Promise.all([
        api.sessions.list(request()),
        api.workspace.list(request()),
      ]);
      const sessionItems = sessionsResponse?.result?.ok
        ? sessionsResponse.result.value?.items || [] : sessionsResponse?.items || [];
      const workspaceItems = workspacesResponse?.result?.ok
        ? workspacesResponse.result.value?.items || [] : workspacesResponse?.items || [];
      const summaries = new Map(sessionItems.map(item => [String(item.sessionId || ""), item]));
      const workspaces = new Map();
      for (const workspace of workspaceItems) {
        for (const id of workspace.sessionIds || []) workspaces.set(String(id), workspace);
      }
      for (const [id, agent] of liveAgents) {
        const summary = summaries.get(String(agent?.session?.id || id));
        const session = agent?.session;
        const workspace = workspaces.get(String(summary?.sessionId || id));
        writeSessionMeta(agent, session, summary, workspace);
      }
    } catch (error) {
      console.warn(`[${PLUGIN_ID}] 获取 session/workspace 元数据失败: ${String(error?.message || error)}`);
    } finally {
      metadataRefreshPromise = null;
    }
  })();
  return metadataRefreshPromise;
}

function scheduleSessionMetadataRefresh(ctx) {
  if (metadataRefreshTimer) clearTimeout(metadataRefreshTimer);
  metadataRefreshTimer = setTimeout(() => {
    metadataRefreshTimer = null;
    refreshSessionMetadata(ctx);
  }, 50);
  if (metadataRefreshTimer.unref) metadataRefreshTimer.unref();
}

function writeSessionMeta(agent, session, summary = null, workspace = null) {
  const meta = extractSessionMeta(agent, session, summary, workspace);
  if (!meta) return;

  const sid = meta.sessionId;
  // 去重：仅当 sessionName 或 projectName 变化时才重发
  const cached = sessionMetaCache.get(sid);
  if (cached && cached.displayLabel === meta.displayLabel) return;

  sessionMetaCache.set(sid, meta);
  writeRecord({
    type: "session/meta",
    sessionId: sid,
    projectName: meta.projectName || "",
    sessionName: meta.sessionName || "",
    agentName: meta.agentName || "DSH",
  });

  // 临时诊断：仅第一条 session 输出字段结构，用于确认真实 DSH payload
  if (sessionMetaCache.size <= 1) {
    writeRecord({
      type: "debug/session-shape",
      sessionId: sid,
      rawLabel: session?.label ?? null,
      rawTitle: session?.title ?? null,
      rawName: session?.name ?? null,
      rawProject: session?.parent?.name ?? session?.project?.name ?? null,
      rawWorkspace: session?.workspace?.path ?? null,
      rawAgentName: agent?.name ?? null,
    });
  }
}

const lastEvidenceByCallTarget = new Map();

function toolResultInfo(data) {
  const message = (data && data.message) || {};
  const callId = message.callId || (message.source && message.source.callId) || "";
  let isError = false, errorText = "", errorCode = "", resultText = "";
  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool-result") {
        if (block.isError) isError = true;
        const c = block.content;
        if (c !== undefined && c !== null) {
          resultText = typeof c === "string" ? c : JSON.stringify(c);
          if (block.isError) errorText = resultText;
        }
        break;
      }
    }
  }
  const err = data && data.error;
  if (err && typeof err === "object") {
    if (!errorCode) errorCode = String(err.code || err.name || err.type || "");
    if (!errorText) errorText = typeof err.message === "string" ? err.message : "";
  }
  return {
    callId: String(callId), isError, errorText: truncate(errorText),
    resultText: truncate(resultText, 240), errorCode: errorCode.slice(0, 48),
  };
}

const pendingTools = new Map(); // callId -> {tool, argsKey, command, sessionId, t0}
const writtenToolCallIds = new Set(); // callId -> 已写入过 tool/call 记录（去重）

function noteToolCall(callId, tool, args, sessionId = "") {
  if (!callId || pendingTools.has(callId)) return;
  pendingTools.set(callId, {
    tool: String(tool || ""), argsKey: summarizeArgs(args),
    command: commandFromArgs(args), sessionId: String(sessionId || ""), t0: Date.now(),
  });
  if (pendingTools.size > 512) { // 防无限增长
    const now = Date.now();
    for (const [k, v] of pendingTools) {
      if (now - v.t0 > 30 * 60 * 1000) pendingTools.delete(k);
    }
  }
}

function consumeToolCall(callId) {
  if (!callId) return null;
  const info = pendingTools.get(callId) || null;
  pendingTools.delete(callId);
  return info;
}

// 审批命令只允许从同 session、同工具、且时间窗口内的最近 tool/call 回填。
// 不再使用进程级 lastToolCall，避免并发 session 把普通命令串到审批上。
const recentToolCalls = new Map(); // sessionId -> [{tool, args, callId, ts}]
const APPROVAL_COMMAND_MAX_AGE_MS = 2000;

function noteLatestToolCall(tool, args, sessionId = "", callId = "") {
  const key = String(sessionId || "session:unknown");
  const list = recentToolCalls.get(key) || [];
  list.push({ tool: String(tool || ""), args, callId: String(callId || ""), ts: Date.now() });
  while (list.length > 16) list.shift();
  recentToolCalls.set(key, list);
}

function latestCommandFor(toolName, args, sessionId = "", callId = "") {
  const direct = extractCommand(args);
  if (direct) return direct;
  const key = String(sessionId || "session:unknown");
  const list = recentToolCalls.get(key) || [];
  const expectedTool = String(toolName || "").trim();
  const expectedCall = String(callId || "").trim();
  const now = Date.now();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    if (now - item.ts > APPROVAL_COMMAND_MAX_AGE_MS) continue;
    if (expectedCall && item.callId && item.callId === expectedCall) {
      return extractCommand(item.args);
    }
    if (expectedTool && item.tool === expectedTool) {
      return extractCommand(item.args);
    }
  }
  return "";
}

// ===== v1 DSH state linkage =====
// Forward real DSH session/event types as "simple events" so the pet side
// (pet/dsh_state.py) can collapse them into thinking/working/
// waiting_approval/success/error. Records carry only an event field and no
// state field, so the legacy AgentStatus working/idle baseline is untouched
// and the legacy DshMonitor (which ignores unknown event types) keeps working.
// NOTE: assistant/message, tool/call, tool/result, and llm/retry are handled
// explicitly with enriched data and are NOT in this set to avoid double writes.
const STATE_EVENT_TYPES = new Set([
  "turn/start",
  "turn/end",
  // NOTE: assistant/chunk (streaming) is intentionally NOT forwarded here.
  // It fires many times per second while streaming, and each forwarded event
  // used to trigger a synchronous file write on DSH's main thread, which
  // visibly stuttered DSH and the pet. "thinking" is already covered by
  // user/message and turn/start, so dropping chunk loses no state.
  "step/start",
  "step/end",
  "command/run",
  "command/done",
  "tool-workflow/run-start",
  "tool-workflow/run-end",
  "approval/asked",
  "approval/decided",
]);

// Extract step identifier from a DSH session/event for behavior pattern detection.
// DSH events carry { turn, step, ... } in event.data; the behavior detector on the
// pet side uses step to deduplicate parallel tool calls (same step → one decision).
function stepOf(event) {
  const data = (event && event.data) || {};
  if (data && data.step !== undefined && data.step !== null) return data.step;
  if (data && data.turn !== undefined && data.turn !== null) return `turn:${data.turn}`;
  return null;
}

function sessionIdOf(session, event) {
  if (session && session.id) return String(session.id);
  const data = (event && event.data) || {};
  if (data && data.sessionId) return String(data.sessionId);
  if (data && data.session_id) return String(data.session_id);
  if (data && data.turn !== undefined && data.turn !== null) return `turn:${data.turn}`;
  return "session:unknown";
}

function writeStateEvent(type, step, sessionId, agentName = "") {
  const extra = { event: type };
  if (step !== undefined && step !== null) extra.step = step;
  if (sessionId) extra.sessionId = sessionId;
  if (agentName) extra.agentName = agentName;
  writeRecord(extra);
}

// These events are useful to the exploration watchdog but are not state
// transitions.  Streaming delta events are intentionally excluded: they are
// summarized by their corresponding begin/end event and must not become fake
// Agent decisions.
const WATCHDOG_EVENT_TYPES = new Set([
  "agent_reasoning", "agent_reasoning_raw_content", "web_search_begin", "web_search_end",
  "exec_command_begin", "exec_command_end", "mcp_tool_call_begin", "mcp_tool_call_end",
  "context_compacted", "thread_rolled_back", "task_started", "task_complete",
  "user_action",
]);

// 审批 UI 请求只由权威 mux 帧（approval/requested，带 rpcId+sessionId）产生
// （见下方 mux 中继）。这里不再提供 writeApprovalRequest：approval/asked 等
// session/event 只是状态/审计信号，绝不能升级成桌宠的审批弹窗——普通工具调用
// （如 pwsh 跑 Get-Location）一旦被宿主标成 approval/asked 就会误弹无法关闭的
// sticky 审批气泡。

// 从审批 arguments 里提取「将要执行的命令」完整内容：
//   bash/shell/pwsh 等命令型工具 → arguments.command / .cmd / .shell / .script
//   write/edit 等文件工具 → filePath（动作对象，非全文）
// 取不到时返回 ""（调用方回退到仅显示工具名）。
function extractCommand(arguments_) {
  if (!arguments_) return "";
  let args = arguments_;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { return ""; }
  }
  if (!args || typeof args !== "object") return "";
  for (const key of ["command", "cmd", "shell", "script", "argv"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && v.length) return v.join(" ").trim();
  }
  // 文件型工具：展示动作对象（filePath/path），帮助判断改的是哪个文件
  for (const key of ["filePath", "path"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

// ===== user-question blocking interaction =====
// DSH's ask_user_question tool pauses the agent until the human answers, then
// feeds the answer back as an ordinary tool result (see @deepseek-ai/dsh-tool-ask-user
// and the host-apiproxy question/requested + question/resolved mux frames).
// The bridge detects it from the session/event stream:
//   tool/call { name: "ask_user_question", callId, arguments: { questions } }
//     -> authoritative request signal; write question/requested with the payload
//   tool/result { message.callId } matching the pending call
//     -> resolved; write question/resolved
// Records are consumed by pet/dsh_state.py (waiting_question state) and the
// legacy agent_link bubble path (permanent question popup).
const QUESTION_TOOL = "ask_user_question";
const pendingQuestionCallIds = new Set();
// mux rpcId ↔ callId 按到达顺序 FIFO 配对（C3）：tool/call 注册把 callId
// 排进会话队列；mux question/requested 帧出队一个并记住 rpcId→callId，
// 后续 question/resolved 按 rpcId 取回。同会话多问题并发时，每个帧拿到
// 的是自己那份 callId，而不是反复取到最旧的一个。
const pendingQuestionRpcPairs = new Map(); // rpcId → callId（resolved 取回后即删）
const pendingQuestionOrder = new Map();    // sessionId → callId[]（FIFO，待 mux 帧出队）

function questionCallIdentity(callId, sessionId) {
  return `${String(sessionId || "")}|${String(callId || "")}`;
}

function registerQuestionCall(callId, sessionId) {
  const id = String(callId || "");
  if (!id || pendingQuestionCallIds.has(questionCallIdentity(id, sessionId))) return false;
  pendingQuestionCallIds.add(questionCallIdentity(id, sessionId));
  const session = String(sessionId || "");
  const queue = pendingQuestionOrder.get(session) || [];
  queue.push(id);
  pendingQuestionOrder.set(session, queue);
  return true;
}

function forgetQuestionCall(callId, sessionId) {
  const id = String(callId || "");
  pendingQuestionCallIds.delete(questionCallIdentity(id, sessionId));
  const session = String(sessionId || "");
  const queue = pendingQuestionOrder.get(session);
  if (queue) {
    const idx = queue.indexOf(id);
    if (idx >= 0) queue.splice(idx, 1);
    if (!queue.length) pendingQuestionOrder.delete(session);
  }
}

function extractQuestions(arguments_) {
  if (!arguments_) return [];
  let args = arguments_;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return [];
    }
  }
  if (!args || typeof args !== "object" || !Array.isArray(args.questions)) return [];
  // DSH's question contract is extensible.  Do not project/flatten it: retain
  // every question and option field (including intent and future fields), while
  // cloning so later DSH mutations cannot alter the JSONL record.
  return typeof structuredClone === "function"
    ? structuredClone(args.questions)
    : JSON.parse(JSON.stringify(args.questions));
}

function writeQuestionRequest(callId, questions, sessionId) {
  if (!registerQuestionCall(callId, sessionId)) return; // 已写过，去重
  // 两个路径（tool/call + mux）都无条件写，由 writeRecordDedup 去重：
  // mux 正常时保留 rpcId 版本（可交互）；mux 不可用/连接失败时兜底写提示
  // （无按钮但至少弹窗出现，不会丢问题）。
  writeRecordDedup({
    event: "question/requested",
    callId: String(callId || ""),
    sessionId: String(sessionId || ""),
    questions,
  });
}

function resolveQuestion(callId, sessionId) {
  const id = String(callId || "");
  if (!id || !pendingQuestionCallIds.has(questionCallIdentity(id, sessionId))) return;
  forgetQuestionCall(callId, sessionId);
  // 收尾记录不 gate mux：重复的 question/resolved 无害（桌宠幂等），
  // 但若 mux 在问题中途才连上、丢了对应的 resolved 帧，这里必须兜底写，
  // 否则桌宠会卡死在 waiting_question。
  writeRecord({
    event: "question/resolved",
    callId: id,
    sessionId: String(sessionId || ""),
  });
}

// mux question 帧只带 rpcId，callId 只有 tool/call 兜底路径才登记（复合键
// sessionId|callId，FIFO 队列见 pendingQuestionOrder）。桌宠端升级重建后靠
// callId 与兜底 question/resolved 配对，帧里缺 callId 时 mux 断线后的兜底
// 关闭就失效，气泡永久挂住——按 FIFO 出队补上并记住 rpcId→callId。
function muxQuestionCallId(payload, rpcId) {
  const fromFrame = String(payload.callId || "");
  if (fromFrame) return fromFrame;
  const rpc = String(rpcId || "");
  const paired = pendingQuestionRpcPairs.get(rpc);
  if (paired) return paired;
  const queue = pendingQuestionOrder.get(String(payload.sessionId || ""));
  const next = queue ? queue.shift() : undefined;
  if (next) {
    if (rpc) pendingQuestionRpcPairs.set(rpc, next);
    return next;
  }
  return "";
}

function muxQuestionCallIdForResolved(payload, rpcId) {
  const fromFrame = String(payload.callId || "");
  if (fromFrame) return fromFrame;
  const rpc = String(rpcId || "");
  const paired = pendingQuestionRpcPairs.get(rpc);
  if (paired) {
    pendingQuestionRpcPairs.delete(rpc); // resolved 是终态，取回即清
    return paired;
  }
  return "";
}

function muxQuestionRequestedRecord(rpcId, payload) {
  return {
    event: "question/requested",
    rpcId,
    sessionId: payload.sessionId,
    questions: payload.questions,
    callId: muxQuestionCallId(payload, rpcId),
  };
}

function muxQuestionResolvedRecord(rpcId, payload) {
  return {
    event: "question/resolved",
    rpcId,
    sessionId: payload.sessionId,
    outcome: payload.outcome,
    callId: muxQuestionCallIdForResolved(payload, rpcId),
  };
}

// ===== interactive mux relay =====
// DSH's /api/events.mux (WebSocket) pushes the SAME interaction frames the web
// UI renders: approval/requested, approval/resolved, question/requested,
// question/resolved — each carrying an rpcId the pet needs to answer back via
// POST /api/respond. The bridge connects as one mux client and relays these
// frames (with rpcId + full payload) into dsh.jsonl so the pet can show a
// CLICKABLE bubble and actually resolve the approval/question in DSH, instead
// of only hinting "go click it in the web UI".
// Node >=22 exposes a global WebSocket client (undici) — zero dependency.
let muxSocket = null;
let muxTimer = null;
let muxReconnectMs = 1000;
let muxPortIndex = 0;
// mux 是否已真正连接（onopen 置真、onclose 置假）。mux 连接后，审批/问题的
// 权威记录由 mux 帧（带 rpcId，可交互）提供；未连接时才用旧路径降级写提示。
let muxConnected = false;

// DSH 可能跑在 3080（web 默认）或 38080（端口被占时的避让），也可能由
// DSH_PORT 指定——全部作为候选，逐个尝试，任一连上即可（与桌宠端一致）。
function muxCandidatePorts() {
  const ports = [];
  if (process.env.DSH_PORT) ports.push(Number(process.env.DSH_PORT));
  ports.push(3080, 38080);
  return [...new Set(ports.filter((p) => Number.isInteger(p) && p > 0))];
}

function muxScheduleReconnect() {
  if (muxTimer) clearTimeout(muxTimer);
  muxTimer = setTimeout(() => {
    muxTimer = null;
    muxConnect();
  }, muxReconnectMs);
  muxReconnectMs = Math.min(muxReconnectMs * 2, 15000);
}

function muxConnect() {
  if (typeof WebSocket === "undefined") return; // 旧 Node：无 WS，降级为纯提示
  const ports = muxCandidatePorts();
  if (ports.length === 0) return;
  if (muxPortIndex >= ports.length) muxPortIndex = 0; // 一轮试完回到起点（配合退避）
  const port = ports[muxPortIndex];
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/api/events.mux`);
  } catch {
    muxPortIndex = (muxPortIndex + 1) % ports.length;
    muxScheduleReconnect();
    return;
  }
  muxSocket = ws;
  ws.onopen = () => {
    muxReconnectMs = 1000;
    muxPortIndex = 0; // 连上了，下次重连从首选端口开始
    muxConnected = true;
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (!msg || msg.type !== "server-request" || !msg.payload) return;
    const p = msg.payload;
    try {
      if (p.type === "approval/requested") {
        // 权威 UI 审批请求：必须带 rpcId + sessionId 才可作为桌宠可交互审批落盘
        // （approvalId 正常也会带，供 resolved 精确配对）。缺身份/空占位帧一律
        // 忽略（只留日志），防止误弹无法关闭的审批气泡。
        const rpcId = String(msg.rpcId || "");
        const sessionId = String(p.sessionId || "");
        if (rpcId && sessionId) {
          writeRecordDedup({ event: "approval/request", rpcId, sessionId, approvalId: String(p.approvalId || ""), toolName: p.toolName, command: latestCommandFor(p.toolName, p.arguments) });
        } else {
          console.warn(`[${PLUGIN_ID}] 忽略缺身份的 mux 审批帧: rpcId=${rpcId ? "yes" : "no"} sessionId=${sessionId ? "yes" : "no"}`);
        }
      } else if (p.type === "approval/resolved") {
        writeRecord({ event: "approval/resolved", rpcId: msg.rpcId, sessionId: p.sessionId, approvalId: p.approvalId, outcome: p.outcome });
        writeInteractionResolved("approval", p.sessionId, { rpcId: msg.rpcId, approvalId: p.approvalId }, p.outcome || "approved");
        // 用户介入信号
        writeRecord({
          event: "user_action",
          action: "approval_resolved",
          outcome: String(p.outcome || ""),
          rpcId: msg.rpcId,
          approvalId: p.approvalId,
          sessionId: p.sessionId,
        });
      } else if (p.type === "question/requested") {
        writeRecordDedup(muxQuestionRequestedRecord(msg.rpcId, p));
      } else if (p.type === "question/resolved") {
        const questionRpcId = p.questionRpcId || msg.rpcId;
        writeRecord(muxQuestionResolvedRecord(questionRpcId, p));
        writeInteractionResolved("question", p.sessionId, { rpcId: questionRpcId }, p.outcome || "answered");
        // 用户介入信号
        writeRecord({
          event: "user_action",
          action: "question_resolved",
          outcome: String(p.outcome || ""),
          rpcId: questionRpcId,
          sessionId: p.sessionId,
        });
      }
    } catch {}
  };
  ws.onclose = () => {
    if (muxSocket === ws) muxSocket = null;
    muxConnected = false;
    muxPortIndex = (muxPortIndex + 1) % ports.length; // 换下一个候选端口
    muxScheduleReconnect();
  };
  ws.onerror = () => {
    try { ws.close(); } catch {}
  };
}

// ===== 写盘去抖（batch flush） =====
// 之前每条事件都立即 mkdirSync+statSync+appendFileSync 同步写盘；DSH 会话忙碌
// （流式/工具密集）时，这些逐事件同步文件 I/O 会卡住 DSH 的 Node 主线程，连带
// 桌宠感知卡顿。改为：事件先入内存队列，合并到一个延迟 flush 里一次性落盘——
// 一个节流窗口内无论来多少事件，DSH 主线程都只做一次文件写。

// 每个 DSH 实例写自己的文件（dsh-{pid}.jsonl），避免 Windows 多实例并行写
// 同一文件的数据行交织；consumers 读取全部 dsh-*.jsonl。
const INSTANCE_FILE = `dsh-${process.pid}.jsonl`;

const FLUSH_DELAY_MS = 80; // 事件合批窗口：80ms 内的记录合并成一次写盘
let writeQueue = [];
let flushTimer = null;

function flushPending() {
  flushTimer = null;
  if (writeQueue.length === 0) return;
  const batch = writeQueue.splice(0, writeQueue.length).join("");
  try {
    const dir = bridgeDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, INSTANCE_FILE);
    try {
      // 超上限轮转：dsh-{pid}.jsonl → dsh-{pid}.jsonl.1（只留一代）
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
        // Windows 不允许 rename 覆盖已存在目标，先删再转
        fs.rmSync(file + ".1", { force: true });
        fs.renameSync(file, file + ".1");
      }
    } catch {}
    fs.appendFileSync(file, batch, "utf8");
  } catch {
    // 静默失败：桥接是锦上添花，绝不能影响 DSH 本体
  }
}

function writeRecord(extra) {
  try {
    // 从 sessionMetaCache 补充字面上的 projectName / sessionName。
    // sessionName 不再借用 label，避免下游把工具标签与会话名混淆。
    const sid = extra.sessionId;
    if (sid) {
      const meta = sessionMetaCache.get(sid);
      if (meta) {
        if (meta.projectName) extra.projectName = meta.projectName;
        if (meta.sessionName) extra.sessionName = meta.sessionName;
      }
    }
    writeQueue.push(
      JSON.stringify({ ts: Date.now() / 1000, agent: "dsh", event: "AgentStatus", ...extra }) + "\n",
    );
    if (flushTimer === null) {
      flushTimer = setTimeout(flushPending, FLUSH_DELAY_MS);
      if (flushTimer.unref) flushTimer.unref(); // 不阻止 DSH 进程退出
    }
  } catch {
    // 入队失败也静默：绝不影响 DSH
  }
}

// ===== 审批/问题写盘去重（P0 竞态防线） =====
// approval/request 现在只由权威 mux 帧（approval/requested）产生，但 mux 重连/
// 重复投递仍可能对同一条审批多次触发；question/requested 仍走 tool/call + mux
// 双通道。这里按可得的稳定身份去重：短窗口内同一条审批/问题只落一条记录，
// 杜绝「先弹无按钮气泡、交互版被队列压住」的重复气泡竞态。优先保留带 rpcId
// 的可交互版本。
const INTERACTION_DEDUP_MS = 8000;
const interactionSeen = new Map(); // key -> { ts, hasRpcId }
const resolvedInteractionIds = new Set();

function interactionIdentity(kind, sessionId, values = {}) {
  const id = String(values.requestId || values.rpcId || values.approvalId || values.callId || "");
  return id && `${String(sessionId || "")}|${kind}|${id}`;
}

function writeInteractionResolved(kind, sessionId, values = {}, outcome = "") {
  const identity = interactionIdentity(kind, sessionId, values);
  if (!identity || resolvedInteractionIds.has(identity)) return false;
  resolvedInteractionIds.add(identity);
  if (resolvedInteractionIds.size > 2048) resolvedInteractionIds.delete(resolvedInteractionIds.values().next().value);
  writeRecord({
    event: "interaction/resolved", source: "dsh", agentName: agentLabelFor(sessionId),
    sessionId: String(sessionId || ""), kind,
    requestId: String(values.requestId || ""), rpcId: String(values.rpcId || ""),
    approvalId: String(values.approvalId || ""), callId: String(values.callId || ""),
    outcome: String(outcome || ""),
  });
  return true;
}

function _interactionDedupKeys(extra) {
  const ev = extra.event || "";
  const keys = [];
  if (ev === "approval/request" || ev === "approval/resolved") {
    if (extra.approvalId) keys.push(`ap:${extra.approvalId}`);
    else if (extra.rpcId) keys.push(`ap:${extra.rpcId}`);
    // sessionId 只能与 approvalId/rpcId 组合使用，单用 sessionId 会误从不同审批
    // 的同 session 事件上去重（如两个不同审批在同一 session 中先后到达）。
    if (extra.approvalId && extra.sessionId) keys.push(`ap:se:${extra.sessionId}:${extra.approvalId}`);
    else if (extra.rpcId && extra.sessionId) keys.push(`ap:se:${extra.sessionId}:${extra.rpcId}`);
    // tool+command 降级去重键：仅在没有任何稳定审批身份（approvalId/rpcId）
    // 时才使用——无条件加入会让同一会话内两条身份不同的审批（同命令）在 8s
    // 窗口内互相吞掉（P1-4）。有 sessionId 时拼进键里做基本隔离。
    const tool = extra.toolName || extra.tool || "";
    const cmd = extra.command || "";
    const session = extra.sessionId || "";
    const hasIdentity = Boolean(extra.approvalId || extra.rpcId);
    if (!hasIdentity && (tool || cmd)) {
      keys.push(session ? `ap:tc:${session}:${tool}|${cmd}` : `ap:tc:${tool}|${cmd}`);
    }
  } else if (ev === "question/requested" || ev === "question/resolved") {
    if (extra.rpcId) keys.push(`qu:${extra.rpcId}`);
    // sessionId 同理：与 rpcId 组合
    if (extra.rpcId && extra.sessionId) keys.push(`qu:se:${extra.sessionId}:${extra.rpcId}`);
  }
  return keys;
}

function writeRecordDedup(extra) {
  const keys = _interactionDedupKeys(extra);
  const now = Date.now();
  const hasRpc = !!extra.rpcId;
  if (keys.length) {
    let blocked = false;
    for (const k of keys) {
      const prev = interactionSeen.get(k);
      if (prev !== undefined && now - prev.ts < INTERACTION_DEDUP_MS) {
        // 已有同身份记录：新版本无 rpcId 且旧版本有 → 丢弃本版（不降级）
        // 新版本有 rpcId 且旧版本无 → 允许补写（升级为可交互），消费端会合并
        if (!hasRpc && prev.hasRpcId) { blocked = true; break; }
        if (hasRpc && !prev.hasRpcId) { continue; } // 允许升级写盘
        blocked = true; break; // 完全相同或都有 rpcId：重复丢弃
      }
    }
    if (blocked) return;
    for (const k of keys) interactionSeen.set(k, { ts: now, hasRpcId: hasRpc });
    if (interactionSeen.size > 512) {
      for (const [k, v] of interactionSeen) {
        if (now - v.ts > INTERACTION_DEDUP_MS) interactionSeen.delete(k);
      }
    }
  }
  writeRecord(extra);
}

// 写 record 去重前的代理：mux 交互记录（审批/问题）走 writeRecordDedup，其余事件（状态/工具/结果/错误）直接走 writeRecord。

// ===== 桌宠聊天 → DSH 会话（档位 A「同一个脑子」） =====
// 桌宠聊天窗口不再直连 api.deepseek.com：它把用户文本原子写成
// chat-request-<id>.json，本插件用 **Agent 收件箱**把它投进指定会话——
// DSH 契约：收件箱是唯一队列，`followup()` 排队开启后续轮次、`steer()` 让
// 空闲目标立刻开一个轮次（docs/subsystems/subagent.zh.md:148）。assistant 文本
// 由本文件既有的 session/event 订阅转成 chat-stream-<id>.jsonl 的 delta 行，
// 桌宠侧 `pet/chat/dsh_provider.py` 增量 tail 后当作流式回复喂给聊天窗口。
// 协议见 dsh-pet-chat/DESIGN.md 第 3 节。**零外部依赖**红线不变：不 import
// createUserMessage/expandAssistantStream，只用文件内已有的等价物。
const CHAT_POLL_MS = 120;
const CHAT_MAX_AGE_MS = 10 * 60 * 1000;
const CHAT_MAX_TEXT = 12000;
const CHAT_MAX_PERSONA = 2000;
const CHAT_MAX_DELTA = 20000;
//: 单张上传图片的字节上限（base64 解码后）。桌宠框选出来的 PNG 通常几十 KB，
//: 4MB 足够覆盖「框得很大」的情况，同时挡住误传超大文件把 bridge 目录写爆。
const CHAT_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
//: 待用上传（只 inject 不唤醒）最多留几张：一张图 = 一份 base64 常驻内存。
const MAX_PENDING_UPLOADS = 8;
const activeChats = new Map(); // requestId → { sessionId, path, openedAt, text, turn, closed }
// 「上传但先不回答」的暂存：handle → { mediaType, data, bytes, sessionId, ts }。
// 有活 Agent 时图片会同时 inject 进收件箱（模型下一步就能看到，但不唤醒）；
// 冷会话 inject 无处可去，就先留在这里，等桌宠带上传要求时一起 prompt 进去。
const pendingUploads = new Map();
// 每个会话当前打开的轮次（turn/start 设置、turn/end 清除）。桌宠的提问必须
// 绑定到「它自己那一轮」：否则我正忙时它提问，会把我当前轮的输出当成它的回答。
const openTurns = new Map(); // sessionId → turn

function chatRequestPath(id) {
  return path.join(bridgeDir(), `chat-request-${id}.json`);
}

function chatCancelPath(id) {
  return path.join(bridgeDir(), `chat-cancel-${id}.json`);
}

function chatStreamPath(id) {
  return path.join(bridgeDir(), `chat-stream-${id}.jsonl`);
}

// 事件所属轮次：优先取 payload，其次回退到该会话已打开的轮次。
// （回退保证某版 DSH 若不带 data.turn，聊天通道也不会永远等不到收尾。）
function turnOf(event, sessionId) {
  const data = (event && event.data) || {};
  if (data.turn !== undefined && data.turn !== null) return data.turn;
  return openTurns.get(String(sessionId || ""));
}

// 每条记录一行、同步 append：聊天流量是「每步一段文本」级别，同步写入换来
// 严格有序与无半行交错（桌宠 tail 时不必处理写入撕裂）。
function appendChat(requestId, record) {
  const chat = activeChats.get(requestId);
  if (!chat || chat.closed) return;
  try {
    fs.appendFileSync(chat.path, JSON.stringify({ ts: Date.now() / 1000, ...record }) + "\n", "utf8");
  } catch {
    // 桌宠侧读取/磁盘问题绝不影响 Agent 循环
  }
}

function closeChat(requestId, record) {
  const chat = activeChats.get(requestId);
  if (!chat) return;
  if (record) appendChat(requestId, record);
  chat.closed = true;
  activeChats.delete(requestId);
  try { fs.rmSync(chatCancelPath(requestId), { force: true }); } catch { /* 已不存在 */ }
}

// assistant 文本 → 绑定到**同一轮**的聊天请求。走持久 session/event 的全文
// （既有记录为卡住检测做过 truncate，聊天必须是全文，故单独一条通道）。
function forwardChatText(sessionId, text, turn) {
  if (activeChats.size === 0) return;
  const sid = String(sessionId || "");
  const bounded = String(text || "").slice(0, CHAT_MAX_DELTA);
  if (!sid || !bounded || turn === undefined || turn === null) return;
  for (const [id, chat] of activeChats) {
    if (chat.sessionId !== sid || chat.turn !== turn) continue;
    chat.text = (chat.text || "") + bounded;
    appendChat(id, { kind: "delta", text: bounded });
  }
}

// 新轮次开始：把该会话里「等自己那一轮」的聊天请求绑定上去。
// 只绑定 turn 尚未确定的请求，因此不会抢走正在进行的他人轮次。
function bindChatsToTurn(sessionId, turn) {
  const sid = String(sessionId || "");
  for (const chat of activeChats.values()) {
    if (chat.sessionId !== sid) continue;
    if (chat.turn === undefined || chat.turn === null) chat.turn = turn;
  }
}

// 一轮结束：只收尾绑定到这一轮的聊天请求，并带上累计全文作为 delta 丢包时的兜底。
function closeChatsForSession(sessionId, turn, extra = {}) {
  const sid = String(sessionId || "");
  for (const [id, chat] of [...activeChats]) {
    if (chat.sessionId !== sid) continue;
    if (turn !== undefined && turn !== null && chat.turn !== turn) continue;
    closeChat(id, { kind: "done", text: chat.text || "", ...extra });
  }
}

// 桌宠崩溃/退出后遗留的流文件与超龄请求：定期回收，避免桥目录无限增长。
function reapStaleChats() {
  const now = Date.now();
  for (const [id, chat] of [...activeChats]) {
    if (now - chat.openedAt > CHAT_MAX_AGE_MS) {
      closeChat(id, { kind: "error", error: "chat-deadline-exceeded" });
    }
  }
  let names = [];
  try { names = fs.readdirSync(bridgeDir()); } catch { return; }
  for (const name of names) {
    if (!name.startsWith("chat-stream-") || !name.endsWith(".jsonl")) continue;
    const id = name.slice("chat-stream-".length, -".jsonl".length);
    if (activeChats.has(id)) continue;
    const full = path.join(bridgeDir(), name);
    try {
      if (now - fs.statSync(full).mtimeMs > CHAT_MAX_AGE_MS) fs.rmSync(full, { force: true });
    } catch { /* 竞态删除无妨 */ }
  }
}

// 解析聊天目标 agent：先认 liveAgents（agent/created 登记过），再认 ctx.get 读到的
// 注册表。注册表这条路径覆盖「插件加载前就已存在的会话」——冷启动缺口的主要兜底。
function liveAgentFor(ctx, sessionId) {
  const agent = controlAgent(ctx, sessionId);
  if (!agent) return null;
  if (agentBelongsToLiveSession(agent, sessionId)) return agent;
  if (agentRegistry(ctx)?.get?.(sessionId) === agent) return agent;
  return null;
}

// 官方 SessionController（宿主侧）：Web UI 提交提示词走的就是它，
// `prompt()` 内部会 resolveAgent —— 持久化但**当前没有活 Agent** 的会话会被自动
// resume。桌宠要拥有自己的专属会话（而不是复用用户当前打开的会话），就必须靠它
// 冷启动。非严格读取：缺失时返回 null，级联退到下一层。
function sessionControllerOf(ctx) {
  try {
    const service = ctx?.get?.("sessionController", false);
    return service && typeof service.prompt === "function" ? service : null;
  } catch (err) {
    console.warn(`[${PLUGIN_ID}] sessionController lookup unavailable: ${String(err?.message || err)}`);
    return null;
  }
}

// 人格上下文（档位 B）：把桌宠侧带上来的角色设定注入成**模型可见的 plugin 上下文**，
// 而不是塞进用户消息正文——这样用户消息在会话里保持干净。
function personaContext(text) {
  return [
    "本轮输入来自 DSH 桌宠窗口。请按下面的角色设定组织这一轮的回答：语气自然、简短（1–3 句），",
    "不要提及这段说明本身，也不要把它当成用户说的话。",
    "角色设定：",
    text,
  ].join("\n");
}

// 把桌宠请求里的图片字段解析成 DSH 内容段要用的形状。
// 只信任 `image/*`、只做长度粗筛再做一次真实解码，避免把超大 base64 解进内存。
function parseUploadImage(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const mediaType = String(raw.mediaType || "").trim().toLowerCase();
  const data = typeof raw.data === "string" ? raw.data.replace(/\s+/g, "") : "";
  if (!mediaType.startsWith("image/") || data === "") return undefined;
  const limitChars = Math.ceil(CHAT_MAX_IMAGE_BYTES * 4 / 3) + 8;
  if (data.length > limitChars) return undefined;
  let bytes = 0;
  try {
    bytes = Buffer.from(data, "base64").byteLength;
  } catch {
    return undefined;
  }
  if (bytes === 0 || bytes > CHAT_MAX_IMAGE_BYTES) return undefined;
  return { mediaType, data, bytes };
}

function imagePartOf(upload) {
  return { type: "image", mediaType: upload.mediaType, data: upload.data };
}

async function admitPromptContent(ctx, content) {
  let attachments;
  try {
    attachments = ctx?.get?.("attachments", false);
  } catch {
    attachments = undefined;
  }
  if (!attachments || typeof attachments.admitPromptContent !== "function") {
    throw new Error("attachment admission service is unavailable");
  }
  return attachments.admitPromptContent(content);
}

function rememberUpload(upload, sessionId) {
  const handle = `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  pendingUploads.set(handle, { ...upload, sessionId, ts: Date.now() });
  while (pendingUploads.size > MAX_PENDING_UPLOADS) {
    const oldest = pendingUploads.keys().next().value;
    pendingUploads.delete(oldest);
  }
  return handle;
}

/**
 * 「先上传、不回答」：把框选出来的图片挂进会话收件箱，但不唤醒驱动。
 *
 * 用 `agent.inject()` 而不是 `followup()` —— 官方契约写得明确：
 * 「Queue model-facing context for the next pre-step **without waking the driver**」。
 * 于是图片进了收件箱（用户在 DSH 里能看到待处理的输入），模型要到桌宠把用户的要求
 * 发过来（followup）时才会连图一起看到并作答。
 *
 * 冷会话没有活 Agent，inject 无处可去 → 只暂存，等提问时随 prompt 一起进。
 * @returns {{handle: string, delivery: string, bytes: number}} 或 null（请求非法）。
 */
async function handleAttachRequest(ctx, request) {
  const sessionId = String(request?.sessionId || "");
  const upload = parseUploadImage(request?.image);
  if (!sessionId || upload === undefined) return null;
  const note = String(request?.note || "").slice(0, 400);
  const handle = rememberUpload(upload, sessionId);

  const agent = liveAgentFor(ctx, sessionId);
  let delivery = "stored";
  if (agent) {
    try {
      const content = await admitPromptContent(ctx, [imagePartOf(upload)]);
      if (note) content.push({ type: "text", text: note });
      // kind="plugin"：这是桌宠带进来的上下文，不是用户手打的消息
      agent.inject(createUserMessage({ content, source: { kind: `plugin:${PLUGIN_ID}` } }));
      delivery = "injected";
    } catch (err) {
      console.warn(`[${PLUGIN_ID}] attach inject failed: ${String(err?.message || err)}`);
      delivery = "stored";
    }
  }
  return { handle, delivery, bytes: upload.bytes, sessionId };
}

async function handleChatRequest(ctx, request) {
  const id = String(request?.id || "");
  const sessionId = String(request?.sessionId || "");
  const text = String(request?.text || "").slice(0, CHAT_MAX_TEXT);
  const persona = String(request?.persona || "").trim().slice(0, CHAT_MAX_PERSONA);
  const uploadHandle = String(request?.uploadHandle || "").trim();
  diag("handleChatRequest 进入", { id: id.slice(0, 8), sessionId, textLen: text.length, op: String(request?.operation || "ask") });
  if (!id) return;

  // —— 上传（只要图，不要回答）走一条独立分支，绝不进 prompt/followup
  if (String(request?.operation || "ask") === "attach") {
    activeChats.set(id, { sessionId, path: chatStreamPath(id), openedAt: Date.now(), text: "", turn: undefined, closed: false });
    const result = await handleAttachRequest(ctx, request);
    if (result === null) {
      closeChat(id, { kind: "error", error: "bad-attach", detail: "需要 sessionId 与合法的 image{mediaType,data}" });
      return;
    }
    appendChat(id, {
      kind: "accepted", sessionId, delivery: result.delivery, handle: result.handle, bytes: result.bytes,
    });
    closeChat(id, { kind: "done", reason: "attached", handle: result.handle, delivery: result.delivery });
    writeRecord({ event: "bridge/attach", requestId: id, sessionId, handle: result.handle, delivery: result.delivery, bytes: result.bytes });
    return;
  }

  activeChats.set(id, { sessionId, path: chatStreamPath(id), openedAt: Date.now(), text: "", turn: undefined, closed: false });
  if (!sessionId || !text.trim()) {
    closeChat(id, { kind: "error", error: "bad-request" });
    return;
  }
  // 之前上传过、且当时没能 inject（冷会话）的图：这次提问随正文一起送进去
  let pendingImage;
  if (uploadHandle) {
    const stored = pendingUploads.get(uploadHandle);
    if (stored && stored.sessionId === sessionId) pendingImage = stored;
    pendingUploads.delete(uploadHandle);
  }
  const agent = liveAgentFor(ctx, sessionId);
  diag("handleChatRequest: liveAgent=", Boolean(agent), "uploadHandle=", Boolean(uploadHandle), "pendingImage=", Boolean(pendingImage));
  if (!agent) {
    // 冷会话：没有活 Agent。走官方的 sessionController.prompt() 让 DSH 自己把
    // 持久化会话 resume 起来（桌宠专属会话的常规入口）。人格只能随正文一起带进去
    // ——这是唯一一次「in-band」，之后该会话就有了活 Agent，后续走下面的干净路径。
    const controller = sessionControllerOf(ctx);
    diag("handleChatRequest 冷会话路径: controller=", Boolean(controller));
    if (!controller) {
      closeChat(id, { kind: "error", error: "session-not-live", detail: sessionId });
      writeRecord({ event: "bridge/chat-error", requestId: id, sessionId, error: "session-not-live" });
      return;
    }
    const parts = [];
    if (persona) parts.push({ type: "text", text: personaContext(persona) });
    if (pendingImage) {
      // ★ 冷会话这条同样要把图过一遍附件收编。`controller.prompt` 里 admit 的是
      //   **它自己那条** content；直接塞裸 base64 会渲染不出来
      //   （[Image attachment unavailable]）并让模型调用整条失败
      //   （DeepSeek Messages transport failed）。收编不了就**丢掉这张图**继续投递
      //   ——宁可少张图，也不能把会话传输搞坏。
      try {
        parts.push(...await admitPromptContent(ctx, [imagePartOf(pendingImage)]));
      } catch (err) {
        console.warn(`[${PLUGIN_ID}] cold-path image dropped: ${String(err?.message || err)}`);
        writeRecord({ event: "bridge/chat-image-skipped", requestId: id, sessionId });
      }
    }
    parts.push({ type: "text", text });
    // 真机实测（2026-09-19 17:17）：`prompt(request, signal)` 的**第二个参数是
    // AbortSignal**，不传会在内部 signal.throwIfAborted() 上抛
    // "Cannot read properties of undefined (reading 'throwIfAborted')"。
    // 这里给一个永不 abort 的信号（桌宠侧的取消走 chat-cancel → agent.cancel）。
    let signal;
    try {
      signal = typeof AbortController === "function" ? new AbortController().signal : undefined;
    } catch {
      signal = undefined;
    }
    let promise;
    try {
      // 同步异常（签名不符、服务内部前置校验）也要收敛成可诊断的错误，
      // 不能让它冒到轮询层变成笼统的 bridge-internal-error。
      promise = controller.prompt({
        requestId: id,
        sessionId,
        mode: "queue",
        content: parts,
      }, signal);
      diag("handleChatRequest: controller.prompt 已调用（未同步抛错）");
    } catch (err) {
      diag("handleChatRequest: controller.prompt 同步抛错:", String(err?.code || err?.message || err));
      closeChat(id, { kind: "error", error: "session-resume-failed", detail: String(err?.message || err) });
      writeRecord({ event: "bridge/chat-error", requestId: id, sessionId, error: "session-resume-failed", sync: true });
      return;
    }
    Promise.resolve(promise).then((result) => {
      if (result && result.accepted === false) {
        throw new Error(String(result?.error?.message || result?.error?.code || "prompt-rejected"));
      }
      diag("handleChatRequest: prompt 已接受 accepted=", result && result.accepted);
      appendChat(id, { kind: "accepted", sessionId, delivery: "session-controller", personaInBand: Boolean(persona) });
      writeRecord({ event: "bridge/chat-accepted", requestId: id, sessionId, delivery: "session-controller", personaChars: persona.length });
    }).catch(async (err) => {
      const detail = String(err?.code || err?.message || err);
      diag("handleChatRequest: prompt 被拒:", detail);
      // 冷路径也要处理 agent-busy：`liveAgentFor()` 查不到 Agent、但会话其实正在跑，
      // 这个空档让 prompt(queue) 被拒（实测 error=session-resume-failed /
      // detail=prompt rejected）。截图流程会发 attach + ask 两个请求，撞上概率更高，
      // 表现就是"框选截图报错、看看屏幕正常"。
      // 处理顺序：重查一次 Agent 走 followup/steer → 不行就退避重试 prompt。
      if (isAgentBusy(detail)) {
        const retried = await deliverAfterBusy(ctx, { id, sessionId, text, persona, pendingImage, parts, signal });
        if (retried) return;
      }
      closeChat(id, { kind: "error", error: "session-resume-failed", detail: String(err?.message || err) });
      writeRecord({ event: "bridge/chat-error", requestId: id, sessionId, error: "session-resume-failed" });
    });
    return;
  }
  // 有活 Agent 时的投递方式。
  //
  // ⚠️ 实机结论（2026-10-02）：`agent.followup/steer` 会把消息并入**当前轮次**
  // 作为中途输入——它会进会话存储（turnOutline 里看得见），但 DSH 界面上
  // **不会显示成一条独立的用户消息**，用户看到的是"桌宠说的话不见了"。
  // 而 `sessionController.prompt({mode:"queue"})`（冷会话路径用的同一个 API）
  // 会开**新一轮**，界面照常渲染。
  // 因此这里优先用 prompt 队列投递；只有拿不到 controller 时才退回 followup/steer。
  const controllerForQueue = sessionControllerOf(ctx);
  if (controllerForQueue) {
    const parts = [];
    if (persona) parts.push({ type: "text", text: personaContext(persona) });
    if (pendingImage) {
      try {
        parts.push(...await admitPromptContent(ctx, [imagePartOf(pendingImage)]));
      } catch (err) {
        console.warn(`[${PLUGIN_ID}] hot-path image dropped: ${String(err?.message || err)}`);
        writeRecord({ event: "bridge/chat-image-skipped", requestId: id, sessionId });
      }
    }
    parts.push({ type: "text", text });
    let signal;
    try {
      signal = typeof AbortController === "function" ? new AbortController().signal : undefined;
    } catch {
      signal = undefined;
    }
    try {
      const accepted = controllerForQueue.prompt({ requestId: id, sessionId, mode: "queue", content: parts }, signal);
      Promise.resolve(accepted).then((result) => {
        if (result && result.accepted === false) {
          throw new Error(String(result?.error?.message || result?.error?.code || "prompt-rejected"));
        }
        diag("handleChatRequest: 已按队列投递（会显示为独立消息）");
        appendChat(id, { kind: "accepted", sessionId, delivery: "session-controller-queue", personaInBand: Boolean(persona) });
        writeRecord({ event: "bridge/chat-accepted", requestId: id, sessionId, delivery: "session-controller-queue", personaChars: persona.length });
        return null;
      }).catch(async (err) => {
        // ⚠️ Agent 正在跑时 prompt(queue) 会被**直接拒绝**（实测 `session/agent-busy`），
        // 它不会替你排队。这正是"桌宠对话又用不了了"的成因：用户往往在 DSH 正在
        // 回答时才顺手跟桌宠说话。此时退回 agent.followup/steer —— 它们本身就是
        // "排队/中途插话"语义，能把消息交给当前这一轮。
        const code = String(err?.code || "");
        diag("handleChatRequest: 队列投递被拒:", code || String(err?.message || err));
        const fallback = typeof agent.followup === "function" ? "followup"
          : (typeof agent.steer === "function" ? "steer" : "");
        if (!fallback) {
          // 这条分支原先没有 diag，导致"队列被拒后什么都没发生"完全不可诊断
          // （实测：截图/看看屏幕发出去后桌宠一直等，日志里只有"队列投递被拒"）。
          diag("handleChatRequest: 队列被拒且 agent 无 followup/steer 可用，放弃投递");
          closeChat(id, { kind: "error", error: "queue-delivery-failed", detail: String(err?.message || err) });
          writeRecord({ event: "bridge/chat-error", requestId: id, sessionId, error: "queue-delivery-failed" });
          return null;
        }
        try {
          await deliverViaAgent(ctx, agent, fallback, { id, sessionId, text, persona, pendingImage });
          diag(`handleChatRequest: 队列被拒后经 ${fallback} 投递成功`);
        } catch (fallbackErr) {
          diag("handleChatRequest: 退回投递也失败:", String(fallbackErr?.message || fallbackErr));
          closeChat(id, { kind: "error", error: "delivery-failed", detail: String(fallbackErr?.message || fallbackErr) });
          writeRecord({ event: "bridge/chat-error", requestId: id, sessionId, error: "delivery-failed" });
        }
        return null;
      });
      return;
    } catch (err) {
      diag("handleChatRequest: prompt(queue) 同步抛错，退回 followup/steer:", String(err?.message || err));
    }
  }
  const deliver = typeof agent.followup === "function" ? "followup"
    : (typeof agent.steer === "function" ? "steer" : "");
  if (!deliver) {
    closeChat(id, { kind: "error", error: "followup-unavailable" });
    return;
  }
  // 有活 Agent：正常路径直接经 agent 投递。
  // 人格注入 / 图片收编 / 回合绑定都在 deliverViaAgent 里，与"队列被拒后的
  // 兜底路径"共用同一份逻辑，避免两处漂移（早先这里有一份重复实现）。
  try {
    await deliverViaAgent(ctx, agent, deliver, { id, sessionId, text, persona, pendingImage });
  } catch (err) {
    closeChat(id, { kind: "error", error: "delivery-failed", detail: String(err?.message || err) });
    writeRecord({ event: "bridge/chat-error", requestId: id, sessionId, error: "delivery-failed" });
  }
}

/**
 * 经活 Agent 投递一条聊天消息（`followup` 或 `steer`）。
 *
 * 抽成函数是因为有两条调用路径：正常路径直接用，以及"`prompt(queue)` 因
 * `session/agent-busy` 被拒"后的兜底路径。两条路径必须做同样的事——
 * 人格 plugin 注入、图片收编、回合绑定——否则兜底那条会丢人格或丢图。
 *
 * @returns 投递回执（agent.followup/steer 的返回值）
 */
async function deliverViaAgent(ctx, agent, deliver, { id, sessionId, text, persona, pendingImage }) {
  let personaInjected = false;
  if (persona && typeof agent.inject === "function") {
    try {
      agent.inject(createUserMessage({
        content: [{ type: "text", text: personaContext(persona) }],
        source: { kind: `plugin:${PLUGIN_ID}` },
      }));
      personaInjected = true;
    } catch (err) {
      console.warn(`[${PLUGIN_ID}] persona inject failed: ${String(err?.message || err)}`);
    }
  }
  const content = [];
  // 上传时若没能 inject（冷会话 / inject 失败），图片在这里跟要求一起进模型
  if (pendingImage) content.push(imagePartOf(pendingImage));
  content.push({ type: "text", text });
  const message = createUserMessage({
    content: pendingImage ? await admitPromptContent(ctx, content) : content,
    source: { kind: "user" },
  });
  const receipt = await agent[deliver](message);
  // 真机实测（DSH 0.1.6-alpha.1，2026-09-19）：只要目标 Agent 当时**正在跑**，
  // 这条消息就会在**当前轮的最近 step 边界**被领取并作答，不会等到新一轮。
  // 因此「有打开的轮次就绑它」；绑定发生在 accept **之后**，该轮此前已产出的
  // 步骤不会被误当成回答。
  const chat = activeChats.get(id);
  if (chat) {
    const open = openTurns.get(sessionId);
    if (open !== undefined && open !== null) chat.turn = open;
  }
  appendChat(id, {
    kind: "accepted",
    sessionId,
    delivery: deliver,
    personaInjected,
    messageId: String((receipt && (receipt.messageId || receipt.id)) || ""),
  });
  writeRecord({ event: "bridge/chat-accepted", requestId: id, sessionId, delivery: deliver, personaChars: String(persona || "").length, personaInjected });
  return receipt;
}

/**
 * 判断失败原因是不是"Agent 正忙"。
 *
 * `prompt(queue)` 在 Agent 正在跑时会被**直接拒绝**而不是排队（实测
 * `session/agent-busy`）；错误可能出现在 `code` 里，也可能只是消息文本，
 * 所以两个字段一起看。
 */
function isAgentBusy(detail) {
  return /agent-busy|agent busy|busy/i.test(String(detail || ""));
}

/**
 * 冷路径在"Agent 正忙"被拒后的补救：先把 Agent 重新查一次走 followup/steer，
 * 查不到就退避重试 `prompt(queue)`。
 *
 * 为什么需要：`liveAgentFor()` 与"会话是否忙"之间存在空档——查不到 Agent
 * 却拒绝投递（因为确实有 Agent 在跑）。这个空档让截图流程（attach + ask
 * 两个请求）更容易失败。busy 通常是瞬时的，稍等即可进入队列。
 *
 * @returns 是否已成功投出
 */
async function deliverAfterBusy(ctx, { id, sessionId, text, persona, pendingImage, parts, signal }) {
  // 1) 重新查一次 Agent：查到了就退回 followup/steer（与热路径同一份逻辑）
  const agent = liveAgentFor(ctx, sessionId);
  if (agent) {
    const deliver = typeof agent.followup === "function" ? "followup"
      : (typeof agent.steer === "function" ? "steer" : "");
    if (deliver) {
      try {
        await deliverViaAgent(ctx, agent, deliver, { id, sessionId, text, persona, pendingImage });
        diag(`handleChatRequest: 冷路径 busy 后重查 Agent，经 ${deliver} 投递成功`);
        return true;
      } catch (err) {
        diag("handleChatRequest: 冷路径 busy 后 followup/steer 也失败:", String(err?.message || err));
      }
    }
  }
  // 2) 退避重试 prompt(queue)：busy 多为瞬时，等一两秒往往就收下了
  const controller = sessionControllerOf(ctx);
  if (!controller) return false;
  for (const waitMs of [1200, 2500]) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    try {
      const accepted = await controller.prompt({ requestId: id, sessionId, mode: "queue", content: parts }, signal);
      if (accepted && accepted.accepted === false) {
        diag("handleChatRequest: 退避重试仍被拒:", String(accepted?.error?.code || "prompt-rejected"));
        continue;
      }
      diag(`handleChatRequest: 冷路径退避 ${waitMs}ms 后投递成功`);
      appendChat(id, { kind: "accepted", sessionId, delivery: "session-controller-retry", personaInBand: Boolean(persona) });
      writeRecord({ event: "bridge/chat-accepted", requestId: id, sessionId, delivery: "session-controller-retry", personaChars: String(persona || "").length });
      return true;
    } catch (err) {
      diag(`handleChatRequest: 退避 ${waitMs}ms 重试失败:`, String(err?.code || err?.message || err));
    }
  }
  return false;
}

function handleChatCancel(ctx, requestId) {
  const chat = activeChats.get(requestId);
  if (!chat) return;
  const agent = liveAgentFor(ctx, chat.sessionId);
  try {
    if (agent && typeof agent.cancel === "function") {
      agent.cancel("dsh-pet-chat", { keepInbox: true });
    }
  } catch { /* 取消失败也要收尾，避免桌宠一直等 */ }
  writeRecord({ event: "bridge/chat-cancelled", requestId, sessionId: chat.sessionId });
  closeChat(requestId, { kind: "done", cancelled: true });
}

function startChatQueue(ctx) {
  let busy = false;
  let failures = 0;
  // 诊断：确认轮询真的在跑、以及它是否看到桌宠目录里的请求文件。
  // 没有这条日志时，"插件没认领请求"与"插件根本没启动轮询"无法区分。
  let pollTicks = 0;
  let sawPetDir = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    try {
      pollTicks += 1;
      reapStaleChats();
      // 1) 取消：先处理，避免取消后又被同一轮投递
      let names = [];
      try { names = fs.readdirSync(bridgeDir()); } catch { names = []; }
      for (const name of names) {
        if (!name.startsWith("chat-cancel-") || !name.endsWith(".json")) continue;
        const id = name.slice("chat-cancel-".length, -".json".length);
        try { fs.rmSync(path.join(bridgeDir(), name), { force: true }); } catch { /* 已被消费 */ }
        handleChatCancel(ctx, id);
      }
      // 2) 投递：认领（rename）后处理，多实例/多轮轮询不会重复投递
      //
      // 为什么要扫两个目录：**桌宠进程写不进桥接目录**（实测 PermissionError 13），
      // 但它能读——读事件、读 chat-stream 都正常。因此"桌宠写、插件读"的那一半
      // （只有 chat-request）改为写在桌宠自己的数据目录，插件从这里一并认领；
      // 其余方向不变：插件仍写桥接目录，桌宠照旧读取。
      const requestDirs = [bridgeDir(), petRequestDir()];
      for (const sourceDir of requestDirs) {
        let sourceNames = names;
        if (sourceDir !== bridgeDir()) {
          try { sourceNames = fs.readdirSync(sourceDir); } catch {
            diag("chat 轮询：读不到桌宠目录", sourceDir, "（将跳过）");
            continue;
          }
          const pending = sourceNames.filter((n) => n.startsWith("chat-request-") && n.endsWith(".json"));
          if (pending.length && !sawPetDir) {
            sawPetDir = true;
            diag("chat 轮询：在桌宠目录发现待处理请求", pending.join(","));
          } else if (!pending && pollTicks % 80 === 0) {
            diag(`chat 轮询心跳 ticks=${pollTicks} 桌宠目录无待处理请求 dir=${sourceDir}`);
          }
        }
        for (const name of sourceNames) {
          if (!name.startsWith("chat-request-") || !name.endsWith(".json")) continue;
          const id = name.slice("chat-request-".length, -".json".length);
          const sourcePath = path.join(sourceDir, name);
          let claimed = null;
          // 首选：**在源目录内**改名完成认领。
          // 为什么关键：跨目录 rename 会报 EXDEV（cross-device link），
          // 实测 `%APPDATA%\dsh-pet-standalone-webm-chat` 与
          // `%APPDATA%\dsh-pet-bridge` **不是同一个文件系统**，
          // 因此"认领到桥接目录"这条路在本机必然失败。
          // 同目录改名是原子的，语义等价（文件仍是那个文件、只改了名）。
          try {
            const localClaim = path.join(sourceDir, `chat-processing-${id}.json`);
            fs.renameSync(sourcePath, localClaim);
            claimed = localClaim;
          } catch (localErr) {
            diag("chat 轮询：原地认领失败", name, "原因:", String(localErr?.code || localErr?.message || localErr));
            // 兜底：桌宠目录写不进时才走这里（历史上桥接目录是唯一来源）
            try {
              const bridgeClaim = path.join(bridgeDir(), `chat-processing-${id}.json`);
              fs.renameSync(sourcePath, bridgeClaim);
              claimed = bridgeClaim;
            } catch (renameErr) {
              // 绝不静默吞掉：空 catch 正是"认领失败"看起来像"没发现请求"的原因。
              diag("chat 轮询：认领失败", name, "from", sourceDir, "原因:", String(renameErr?.code || renameErr?.message || renameErr));
              continue;
            }
          }
          diag("chat 轮询：已认领请求", id, "来自", sourceDir === bridgeDir() ? "桥接目录" : "桌宠目录", "认领位置", claimed);
          try {
            let request;
            try { request = JSON.parse(fs.readFileSync(claimed, "utf8")); }
            catch { request = { id, sessionId: "", text: "" }; }
            handleChatRequest(ctx, request).catch((err) => {
              console.warn(`[${PLUGIN_ID}] chat request failed: ${String(err?.message || err)}`);
              closeChat(id, { kind: "error", error: "bridge-internal-error", detail: String(err?.message || err) });
            });
          } catch (err) {
            console.warn(`[${PLUGIN_ID}] chat request failed: ${String(err?.message || err)}`);
            activeChats.set(id, activeChats.get(id) || { sessionId: "", path: chatStreamPath(id), openedAt: Date.now(), text: "", closed: false });
            closeChat(id, { kind: "error", error: "bridge-internal-error", detail: String(err?.message || err) });
          } finally {
            try { fs.rmSync(claimed, { force: true }); } catch { /* 已被清理 */ }
          }
        }
      }
      failures = 0;
    } catch (err) {
      // 这个回调每 CHAT_POLL_MS 跑一次、且跑在 **DSH 宿主进程**里：任何未捕获异常
      // 都会变成宿主的 uncaughtException（可能直接崩掉整个 DSH）。因此轮询体一律
      // 吞掉异常并限频告警——聊天功能坏掉可以接受，拖垮宿主不可以。
      failures += 1;
      if (failures === 1 || failures % 100 === 0) {
        console.warn(`[${PLUGIN_ID}] chat queue poll failed (x${failures}): ${String(err?.message || err)}`);
      }
    } finally {
      busy = false;
    }
  }, CHAT_POLL_MS);
  if (timer.unref) timer.unref();
  ctx.effect?.(() => () => clearInterval(timer), `${PLUGIN_ID}.chat-queue()`);
}

export function apply(ctx) {
  // Make the resolved runtime destination observable for packaged builds.
  // This is intentionally emitted once per Bridge process and contains only
  // path metadata, never secrets or the full environment.
  writeRecord({
    event: "bridge/diagnostic",
    bridgeDir: bridgeDir(),
    instanceFile: INSTANCE_FILE,
    appData: process.env.APPDATA || "",
    home: os.homedir(),
    packaged: Boolean(process.pkg),
    chatQueue: true,
    // 聊天通道的自检证据：非严格读取 agents 注册表是否可用、已登记的活 agent 数。
    // 安装后看这条记录即可判断「冷会话」缺口是否被注册表兜底补上。
    agentsService: agentRegistry(ctx) ? "ok" : "missing",
    liveAgentCount: liveAgents.size,
  });

  // The pet talks to this queue instead of calling session.prompt/cancel
  // directly.  Control therefore runs beside the real Agent and can cancel,
  // diagnose, and steer it without relying on the web API transport.
  startControlQueue(ctx);

  // 桌宠聊天窗口 → 会话收件箱（档位 A）。与上面的控制队列同构：文件请求 +
  // 轮询认领，回复走 chat-stream-<id>.jsonl。
  //
  // 必须包 try/catch：apply() 抛错会让**整个插件**激活失败，那样连既有的状态/
  // 气泡/审批转发都会一起消失（桌宠会变成瞎子）。新增功能永远不许拖垮既有功能。
  try {
    startChatQueue(ctx);
  } catch (err) {
    console.warn(`[${PLUGIN_ID}] chat queue disabled: ${String(err?.message || err)}`);
    writeRecord({ event: "bridge/chat-disabled", error: String(err?.message || err) });
  }

  // 依赖 cordis 的 context 生命周期：agent/status 监听挂在 agent.ctx 上，
  // agent 销毁时随其 context 自动解绑，不累积 disposer。
  ctx.on("agent/created", ({ agent }) => {
    if (!agent) return;
    for (const id of [agent.id, agent.session?.id]) {
      if (id !== undefined && id !== null) {
        liveAgents.set(String(id), agent);
        knownSessions.add(String(id));
      }
    }
    // 运行时 agent.session 不携带 Web UI 的真实标题/项目名；先写基础记录，
    // 再通过 DSH 官方 apiProxy 的 session.list/workspace.list 获取真实投影。
    writeSessionMeta(agent, agent.session);
    scheduleSessionMetadataRefresh(ctx);
    // 注意：创建时不要写 idle——桌宠端本来就默认 idle 态。
    // 实测 dsh 创建 agent 后 4ms 内必发 running，此时若先写一条幻影 idle，
    // 会占住桌宠端 2 秒换帧节流位，把紧跟的真实 working 整个吞掉。
    agent.ctx.effect(() => {
      agentStates.set(agent, "idle");
      const stop = agent.ctx.on("agent/status", ({ status }) => {
        // running/idle 是连接生命周期的成功/切换信号，不能让上一轮
        // request-error 重试计数泄漏到下一轮。
        resetRetryConnection(String(agent.session?.id || agent.id || ""));
        agentStates.set(agent, status === "running" ? "working" : "idle");
        aggregateWrite();
      });
      // 模型请求错误：agent/request-error 是 cordis agent 上下文事件
      // （agent-loop 用 dispatch.waterfall 发出），不走 session/event——
      // 必须挂在 agent.ctx 上才能收到。供 stuck_detector 判断网络/鉴权/限流类根因。
      const stopErr = agent.ctx.on("agent/request-error", ({ failure }) => {
        const errCode = String((failure && failure.code) || "");
        const errMsg = String((failure && failure.message) || "");
        writeRecord({
          event: "agent/request-error",
          errorCode: errCode.slice(0, 48),
          errorMessage: truncate(errMsg),
        });
        const retrySessionKey = String(agent.session?.id || agent.id || "");
        // 只有同一 session 连续累计达到阈值才写高优先级提醒；每次
        // request-error 仍保留原始记录，便于诊断真实重试过程。
        if (isModelAccessError(errCode, errMsg) && noteRetryConnection(retrySessionKey)) {
          writeRecord({
            event: "model_access",
            errorCode: errCode.slice(0, 48) || "RATE_LIMIT",
            errorMessage: truncate(errMsg),
            sessionId: retrySessionKey,
            consecutiveRetryCount: retryConnectionStats.get(retrySessionKey)?.count || RETRY_EVENT_THRESHOLD,
          });
        } else if (!isModelAccessError(errCode, errMsg)) {
          resetRetryConnection(retrySessionKey);
        }
      });
      return () => {
        if (typeof stop === "function") stop();
        if (typeof stopErr === "function") stopErr();
        // agent 销毁：移出聚合并重算（全部退出时落一条 idle，桌宠回待机）
        agentStates.delete(agent);
        for (const [id, item] of liveAgents) {
          if (item === agent) liveAgents.delete(id);
        }
        aggregateWrite();
      };
    }, `${PLUGIN_ID}.agent()`);
  });

  const cordisRequestSessions = new Map();
  ctx.on("cordis/request-run", (request) => {
    if (!request || request.requiresApproval !== true) return;
    const requestId = String(request.requestId || "");
    cordisRequestSessions.set(requestId, String(request.agentId || ""));
    writeRecord({ event: "cordis/request-run", source: "dsh", agentId: String(request.agentId || ""), sessionId: String(request.agentId || ""), kind: "cordis", payload: request, requestId });
  });
  ctx.on("cordis/request-run-resolved", (resolved) => {
    if (!resolved) return;
    const requestId = String(resolved.requestId || "");
    const sessionId = cordisRequestSessions.get(requestId) || "";
    cordisRequestSessions.delete(requestId);
    writeRecord({ event: "cordis/request-run-resolved", source: "dsh", kind: "cordis", requestId, agentId: sessionId, sessionId, outcome: String(resolved.outcome || "") });
  });

  // 过程汇报：session/event 在插件/根/agent 三层上下文都可达（实测验证）。
  // 注意 dsh 的工具调用不走独立 tool/call 事件——工具名在 assistant/message
  // 事件的 content 块里（type === "tool-call" 的块带 name 字段），
  // web UI 的工具卡片也是这么来的。assistant/message 每步只发一次，无流式重复。
  ctx.on("session/event", (_session, event) => {
    try {
      if (!event) return;
      const type = event.type;
      const sessionId = sessionIdOf(_session, event);
      const agentName = agentLabelFor(sessionId);
      // 只有连续的 llm/retry 才属于同一轮连接异常；切换到任意其他
      // session/event（包括成功结果、工具调用和新的 turn）都开始新一轮统计。
      if (type !== "llm/retry") resetRetryConnection(sessionKeyOf(_session, event));
      // 标题通常在首条用户消息后异步生成；每个 session/event 都触发一次
      // 合并刷新，确保生成标题/改名后 Bridge 最终写出真实名称。
      scheduleSessionMetadataRefresh(ctx);

      // 若此 sessionId 尚未见过，尝试补发 session/meta
      if (!sessionMetaCache.has(sessionId) && _session) {
        writeSessionMeta(liveAgents.get(sessionId) || null, _session);
      }

      // Preserve the current user goal for goal-aware loop detection.  This is
      // still the same state event consumed by dsh_state, only enriched with a
      // bounded text field; full conversation history is never forwarded.
      if (type === "user/message") {
        const data = event.data || {};
        // DSH 的 UserMessage.source.kind 区分真人输入（kind="user"）与
        // agent.inject() 注入上下文（kind="plugin"：system-reminder/技能目录/
        // 记忆等，每轮多条约 1200 字）——转发给桌宠侧，让它只把真人消息当作
        // 「对话开始」触发，不被注入记录污染（dsh_state / 探索看门狗据此过滤）。
        const src = (data && data.source && data.source.kind) || "";
        writeRecord({
          event: "user/message",
          agentName,
          text: messageText(data),
          step: stepOf(event),
          sessionId,
          ...(src ? { sourceKind: src } : {}),
        });
      }

      // 1) 工具调用气泡（ask_user_question 除外——它有专门的 question/requested 常驻气泡）
      //    同时收集模型文本（截断）、记录待跟踪调用（用于卡住检测）。
      if (type === "assistant/message") {
        // data 形状：{ turn, step, message: { content: [...] } }（兼容 data 直接是消息）
        const data = event.data || {};
        const content = (data.message && data.message.content) || data.content;
        let texts = [];
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block) continue;
            if (block.type === "tool-call" && block.name) {
              if (block.name === QUESTION_TOOL) {
                // 兜底：assistant/message 的 tool-call 块也带 arguments，去重后补写
                writeQuestionRequest(
                  block.callId || block.id,
                  extractQuestions(block.arguments),
                  sessionId,
                );
                continue;
              }
              // 与下方独立 tool/call 事件同一条路径写入（按 callId 去重，避免双写）
              const cid = String(block.callId || block.id || "");
              noteToolCall(cid, block.name, block.arguments);
              noteLatestToolCall(block.name, block.arguments);
              if (cid && !writtenToolCallIds.has(cid)) {
                writtenToolCallIds.add(cid);
                writeRecord({
                  event: "tool/call",
                  agentName,
                  tool: String(block.name),
                  argsKey: summarizeArgs(block.arguments),
                  command: commandFromArgs(block.arguments),
                  callId: cid,
                  step: stepOf(event),
                  sessionId,
                });
              }
            } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
              texts.push(block.text);
            }
          }
        }
        // 带截断文本的 assistant/message 记录（供 stuck_detector 分析重试措辞）
        if (texts.length) {
          writeRecord({ event: "assistant/message", agentName, text: truncate(texts.join(" ").replace(/\s+/g, " ")), step: stepOf(event), sessionId });
          // 聊天通道要全文：上面的记录按 TEXT_MAX 截断，只够卡住检测用。
          forwardChatText(sessionId, texts.join("\n\n"), turnOf(event, sessionId));
        } else {
          writeStateEvent("assistant/message", stepOf(event), sessionId);
        }
        // 模型成功产出 = 重试已恢复 → 连续重试计数归零（见上方硬失败判定规则）
        noteTurnRecovery(sessionKeyOf(_session, event));
      }

      // 2) 审批请求：approval/asked 只是 DSH 的会话/审计信号（供 dsh_state 锁存
      //    waiting_approval），**不代表 Web UI 存在待确认的真实审批，绝不能由此
      //    驱动桌宠审批弹窗**——普通工具调用（如 pwsh 跑 Get-Location）一旦被宿主
      //    标成 approval/asked，桥接再升级成 approval/request，桌宠就会挂出一个
      //    永远等不到 approval/resolved 的 sticky 审批气泡。
      //    UI 层审批请求只由权威 mux 帧 approval/requested（带 rpcId+sessionId）
      //    产生（见下方 mux 中继）。approval/asked 仍经 STATE_EVENT_TYPES 转发为
      //    状态/审计事件，不写 approval/request。
      if (type === "approval/decided") {
        const data = event.data || {};
        writeInteractionResolved("approval", sessionId, { rpcId: data.rpcId, approvalId: data.approvalId, callId: data.callId }, data.outcome || data.decision || "approved");
      }
      // approval/asked：仅保留状态/审计转发（下方 STATE_EVENT_TYPES 统一处理），
      // 不再生成 approval/request，杜绝「普通/审计事件 → UI 审批弹窗」的误升级。

      // 2.5) 用户问题交互（阻塞型，与审批同等待遇）：ask_user_question 会暂停
      //     Agent 直到用户选择/回答。tool/call 是权威请求信号，tool/result 用
      //     message.callId 配对表示已解决（answer 已回填给 Agent）。
      //     同时记录卡住检测所需数据（工具名、参数指纹、成败、耗时）。
      if (type === "tool/call") {
        const d = event.data || {};
        // 工具调用 = 模型请求链已恢复推进 → 连续重试计数归零
        noteTurnRecovery(sessionKeyOf(_session, event));
        if (d.name === QUESTION_TOOL) {
          writeQuestionRequest(d.callId, extractQuestions(d.arguments), sessionId);
        }
        // 记录待跟踪调用（覆盖 assistant/message 兜底，去重写入）
        if (d.callId && d.name) {
          noteToolCall(d.callId, d.name, d.arguments);
          noteLatestToolCall(d.name, d.arguments);
          const cid = String(d.callId);
          if (!writtenToolCallIds.has(cid)) {
            writtenToolCallIds.add(cid);
            // 按需清理（防无限增长）
            if (writtenToolCallIds.size > 1024) writtenToolCallIds.clear();
            writeRecord({
              event: "tool/call",
              agentName,
              tool: String(d.name),
              argsKey: summarizeArgs(d.arguments),
              command: commandFromArgs(d.arguments),
              callId: cid,
              step: stepOf(event),
              sessionId,
            });
          }
        }
      } else if (type === "tool/result") {
        const d = event.data || {};
        // 与 toolResultInfo 同一取数路径：当前 dsh 版本 callId 也可能只挂在
        // message.source 下，只看 message.callId 会导致 resolveQuestion 永远
        // 收不到 callId——question/resolved 写不出，桌宠端提醒队列卡死。
        const callId = d.message && (d.message.callId || (d.message.source && d.message.source.callId));
        if (callId) resolveQuestion(callId, sessionId);
        // 问题收尾的 question/resolved 由 resolveQuestion 内部负责写盘（桌宠按它
        // 关闭问题气泡）。这里不再补写 user_action 兜底：resolveQuestion 的第一
        // 动作就是删掉 pendingQuestionCallIds 里的复合键 sessionId|callId，紧随
        // 其后的裸 callId 查询恒为 False，那段写盘永远不可达。
        const info = toolResultInfo(d);
        const pending = consumeToolCall(info.callId) || {};
        const tool = pending.tool || "";
        const durationMs = pending.t0 ? Date.now() - pending.t0 : undefined;
        const argsKey = pending.argsKey || "";
        const timeout = /timeout|timed ?out|超时|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(info.errorText || "") || /timeout/i.test(info.errorCode || "");
        const evidenceKey = `${sessionId}|${tool}|${argsKey}`;
        let evidenceStatus = "unavailable";
        let evidenceHash = "";
        if (!info.isError && info.resultText) {
          evidenceHash = createHash("sha256").update(info.resultText, "utf8").digest("hex").slice(0, 16);
          const previous = lastEvidenceByCallTarget.get(evidenceKey);
          evidenceStatus = previous === evidenceHash ? "same" : "new";
          lastEvidenceByCallTarget.set(evidenceKey, evidenceHash);
          if (lastEvidenceByCallTarget.size > 2048) lastEvidenceByCallTarget.clear();
        }
        writeRecord({
          event: "tool/result",
          agentName: agentLabelFor(sessionId),
          tool,
          argsKey,
          command: pending.command || "",
          callId: info.callId,
          ok: !info.isError,
          timeout: !!timeout,
          errorCode: info.errorCode,
          // 错误正文统一用 errorMessage（与 llm/retry / model_access / llm_error /
          // execution/failed 同一字段名），不再用并行的 errorText 别名。
          errorMessage: info.errorText,
          evidenceStatus,
          evidenceHash,
          ...(info.resultText ? { resultSummary: info.resultText } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          step: stepOf(event),
          sessionId,
        });
        // 硬失败判定：累计本轮工具成败（turn/end 时判定是否最终失败）
        noteTurnToolResult(
          sessionKeyOf(_session, event),
          !info.isError,
          info.errorCode,
          info.errorText,
        );
      }

      // 2.7) turn 开始：重置硬失败判定状态（新一轮从零计数；若上一轮 turn/end
      //      因异常漏发，这里兜底清掉残留统计，绝不跨 turn 累计）
      if (type === "turn/start") {
        resetTurnStats(_turnStats(sessionKeyOf(_session, event)));
        // 聊天通道：记录当前打开的轮次，并让「等下一轮」的聊天请求认领它。
        // 没有这一步，正在跑的他人轮次的输出会被错当成桌宠提问的回答。
        const turn = (event.data || {}).turn;
        if (turn !== undefined && turn !== null) {
          openTurns.set(sessionId, turn);
          bindChatsToTurn(sessionId, turn);
        }
      }

      // 2.75) 模型请求错误：agent/request-error 是 cordis agent 上下文事件，
      //      已在上方 agent/created 的 agent.ctx 监听里转发，不走 session/event——
      //      此处不处理，避免与 agent 上下文监听重复写盘。

      // 2.8) LLM 重试事件（retry 计数 + 失败原因，供 stuck_detector 判断 root cause）
      if (type === "llm/retry") {
        const d = event.data || {};
        const failure = d.failure || {};
        const errorCode = String(failure.code || "");
        const errorMessage = String(failure.message || "");
        writeRecord({
          event: "llm/retry",
          retry: typeof d.retry === "number" ? d.retry : 0,
          errorCode: errorCode.slice(0, 48),
          errorMessage: truncate(errorMessage),
          provider: String(d.provider || ""),
          step: stepOf(event),
          sessionId,
        });
        // 模型访问失败即时提醒：不等到 turn/end，LLM 重试时直接写 model_access 事件。
        // DSH 实测 errorCode 为 "RATE_LIMIT"（消息形如 "429: ..."），旧实现仅
        // 匹配 code==="429"，导致真实模型访问失败永远不触发。改用 isModelAccessError 判定。
        if (isModelAccessError(errorCode, errorMessage) &&
            noteRetryConnection(sessionKeyOf(_session, event))) {
          writeRecord({
            event: "model_access",
            errorCode: errorCode.slice(0, 48) || "RATE_LIMIT",
            errorMessage: truncate(errorMessage),
            sessionId,
            consecutiveRetryCount: RETRY_EVENT_THRESHOLD,
            retry: typeof d.retry === "number" ? d.retry : 0,
          });
        }
        // bad_response_status_code：AI API 返回 404/5xx 等 HTTP 错误，
        // 表示函数/模型不存在或 API 不可用。此类错误与限流不同，直接写入
        // llm_error 事件。errorCode 保留上游真实码（不再替换成 PI_AI_ERROR），
        // 分类语义由 errorKind 承载（errorKind=api → 弹窗走 llm_error.api 文案）。
        if (errorCode === "bad_response_status_code" &&
            noteRetryConnection(sessionKeyOf(_session, event))) {
          writeRecord({
            event: "llm_error",
            errorCode: errorCode.slice(0, 48),
            errorMessage: truncate(errorMessage),
            sessionId,
            retry: typeof d.retry === "number" ? d.retry : 0,
            errorKind: "api",
          });
        }
        // 累计本轮连续重试计数（恢复即清零；turn/end 判定「重试耗尽」时用）
        noteTurnRetry(sessionKeyOf(_session, event), errorCode);
      }

      // 2.85) 硬失败判定（execution/failed，脱敏，不经行为分析直接提醒）
      // 规则：DSH 的 turn/end 自带 data.reason.kind。只有 kind === "error"
      // （本轮真的以出错终止）才可能判硬失败：
      //   - 连续 llm/retry 达到阈值后 DSH 抛错 → 模型重试耗尽（failureType=model_retry_exhausted）
      //   - 本轮有工具失败且无任何成功，且 turn 以 error 结尾 → 工具最终失败（failureType=tool_failed）
      // 正常完成（completed）、被中止（aborted）、被阻塞（blocked）、触达
      // max-tokens 以及 reason 缺失的 turn/end，一律不写 execution/failed——
      // 中途抖动但最终恢复并正常收尾的 turn 绝不误报。
      // 只在 turn/end 时判定并写一条；错误码保留（判根因），错误正文不落盘。
      if (type === "turn/end") {
        const reason = (event.data && event.data.reason) || null;
        const failure = decideTurnEndFailure(reason, turnStatsMap.get(sessionKeyOf(_session, event)));
        if (failure) {
          writeRecord({ ...failure, sessionId });
        }
        _endTurnStats(sessionKeyOf(_session, event));
        resetRetryConnection(sessionKeyOf(_session, event));
        // 聊天通道收尾：只收尾**绑定到这一轮**的聊天请求（桌宠在我正忙时提问，
        // 它等的是它自己那一轮，不能被别人这轮的 turn/end 提前结束）。
        const endTurn = (event.data || {}).turn;
        if (endTurn !== undefined && endTurn !== null && openTurns.get(sessionId) === endTurn) {
          openTurns.delete(sessionId);
        }
        closeChatsForSession(sessionId, endTurn, { reason: String((reason && reason.kind) || "") });
      }

      // 3) 统一状态联动：转发 DSH 原始 session/event 类型为「简单事件」，
      //    桌宠侧 dsh_state.py 据此收敛为 thinking/working/waiting_approval/
      //    success/error（审批锁存依赖 approval/asked 与 approval/decided 成对出现）。
      //    注意 assistant/message、tool/call、tool/result、llm/retry 已在上方
      //    显式处理，不在 STATE_EVENT_TYPES 中，不会重复写入。
      //    转发时携带 step（step/start、turn/start 等），供行为模式检测按 step 去重。
      if (STATE_EVENT_TYPES.has(type)) {
      writeStateEvent(type, stepOf(event), sessionId, agentName);
      // 用户介入信号：approval/decided 或 thread_rolled_back 等用户主动干预事件
      // → 向桌宠发送 user_action 事件，关闭对应弹窗
      if (type === "approval/decided") {
        const data = event.data || {};
        writeRecord({
          event: "user_action",
          action: "approval_decided",
          decision: String(data.decision || ""),
          toolName: String(data.toolName || ""),
          rpcId: String(data.rpcId || ""),
          approvalId: String(data.approvalId || ""),
          sessionId,
          step: stepOf(event),
        });
      }
      } else if (WATCHDOG_EVENT_TYPES.has(type)) {
        const data = event.data || {};
        const extra = { event: type, step: stepOf(event), sessionId, agentName };
        if (type.includes("reasoning")) {
          extra.summary = truncate(data.text || data.content || data.reasoning || "");
        } else if (type.includes("search")) {
          extra.tool = String(data.tool || data.name || "web_search");
          extra.target = truncate(data.query || data.searchQuery || data.url || "");
        } else if (type.includes("command")) {
          extra.tool = String(data.tool || data.name || "shell");
          extra.target = truncate(data.command || data.cmd || "");
        }
        writeRecord(extra);
      }
    } catch {}
  });

  // 交互式 mux 中继：连接 DSH 的 WebSocket mux 流，把带 rpcId 的审批/问题
  // 交互帧转发到 dsh.jsonl（桌宠据此弹可点选气泡并回写 /api/respond）。
  // 失败/断线只退避重连，绝不影响 DSH 主流程。
  muxConnect();
}

export { inject };
// Kept private-by-convention: package tests use this surface to exercise the
// control boundary without starting a DSH host or touching the real queue.
export const __controlTest = { controlAgent, handleControlRequest, liveAgents, knownSessions };
export const __messageTest = { createUserMessage };
// 聊天通道的回归入口（tests/bridge_chat.test.mjs 用假 ctx 直接驱动，不需要 DSH）。
export const __chatTest = {
  activeChats, startChatQueue, handleChatRequest, forwardChatText, closeChatsForSession,
  chatRequestPath, chatStreamPath, bridgeDir,
  // 上传（只 inject 不唤醒）的回归入口：pendingUploads 让测试能确认暂存与清理
  pendingUploads, parseUploadImage, handleAttachRequest,
};
export const __retryTest = {
  threshold: RETRY_EVENT_THRESHOLD,
  reset: resetRetryConnection,
  note: noteRetryConnection,
  isModelAccess: isModelAccessError,
};
export const __hardFailureTest = {
  threshold: RETRY_EXHAUSTED_THRESHOLD,
  decideTurnEnd: decideTurnEndFailure,
  resetTurnStats,
  noteRetry: noteStatsRetry,
  recovery: noteStatsRecovery,
  noteToolResult: noteStatsToolResult,
};
export const __questionTest = {
  questionCallIdentity,
  pendingQuestionCallIds,
  pendingQuestionRpcPairs,
  pendingQuestionOrder,
  registerQuestionCall,
  forgetQuestionCall,
  muxQuestionRequestedRecord,
  muxQuestionResolvedRecord,
};
