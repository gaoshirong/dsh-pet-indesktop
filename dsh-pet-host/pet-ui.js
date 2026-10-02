// Host half for the DSH pet client plugin.
//
// This package deliberately has no runtime dependencies. Desktop local-plugin
// directories are linked into the profile without a package-local install, so
// a bare import here could prevent the whole DSH profile from starting.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NAMESPACE = "dsh-pet";
const CONFIG_KEYS = [
  "scale",
  "opacity",
  "soundEnabled",
  "notificationsEnabled",
  "selfTalkEnabled",
];
const DEFAULTS = Object.freeze({
  scale: 0.5,
  opacity: 100,
  soundEnabled: true,
  notificationsEnabled: true,
  selfTalkEnabled: true,
  followCurrentSession: true,
  projectRoot: "",
  workspaceId: "",
  sessionId: "",
  openSessionRequest: "",
});

const NUMBER_BOUNDS = {
  scale: [0.2, 1.5],
  opacity: [20, 100],
};

function readNumber(source, key) {
  const value = source[key];
  if (value === undefined) return DEFAULTS[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${key} must be a finite number`);
  }
  const [minimum, maximum] = NUMBER_BOUNDS[key];
  if (value < minimum || value > maximum) {
    throw new TypeError(`${key} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function readBoolean(source, key) {
  const value = source[key];
  if (value === undefined) return DEFAULTS[key];
  if (typeof value !== "boolean") throw new TypeError(`${key} must be a boolean`);
  return value;
}

function readString(source, key) {
  const value = source[key];
  if (value === undefined) return DEFAULTS[key];
  if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
  return value.trim();
}

function normalizeSettings(input) {
  if (input === undefined || input === null) return { ...DEFAULTS };
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("dsh-pet settings must be an object");
  }
  return {
    scale: readNumber(input, "scale"),
    opacity: readNumber(input, "opacity"),
    soundEnabled: readBoolean(input, "soundEnabled"),
    notificationsEnabled: readBoolean(input, "notificationsEnabled"),
    selfTalkEnabled: readBoolean(input, "selfTalkEnabled"),
    followCurrentSession: readBoolean(input, "followCurrentSession"),
    projectRoot: readString(input, "projectRoot"),
    workspaceId: readString(input, "workspaceId"),
    sessionId: readString(input, "sessionId"),
    // 「桌宠点 AI 对话 → DSH 打开那个会话」的请求序号：桌宠每次点击都换一个新值，
    // 客户端半订阅到变化就去 openSession。为什么必须是会变的键：跟随开着时
    // sessionId 与当前会话恒等，同值写入不产生 settings/document-updated 事件，
    // 客户端就没机会切会话（跟随关闭、用户在别的会话里时正是这种情形）。
    openSessionRequest: readString(input, "openSessionRequest"),
  };
}

// The browser settings scope rehydrates schema.toJSON(). This compact envelope
// mirrors Schemastery's public serialized shape while keeping the Host plugin
// dependency-free: `new Schema(envelope)` resolves `uid` against `refs` and
// rewrites every child reference (`dict`, `inner`, `list`, `sKey`) through that
// table (vendor/schemastery/src/index.ts:244-255). The browser validates the
// stored section against this envelope (packages/client/ui-settings/src/client/
// settings-scope.ts:209), so it must stay a faithful superset of what
// `normalizeSettings` returns — a key added to only one of the two either gets
// dropped on write or makes the whole namespace undecodable.
normalizeSettings.toJSON = () => ({
  uid: 101,
  refs: {
    "1": { type: "number", meta: { min: 0.2, max: 1.5, default: 0.5 } },
    "2": { type: "number", meta: { min: 20, max: 100, default: 100 } },
    "3": { type: "boolean", meta: { default: true } },
    "4": { type: "boolean", meta: { default: true } },
    "5": { type: "boolean", meta: { default: true } },
    "6": { type: "string", meta: { default: "" } },
    "7": { type: "string", meta: { default: "" } },
    "8": { type: "string", meta: { default: "" } },
    "9": { type: "boolean", meta: { default: true } },
    "10": { type: "string", meta: { default: "" } },
    "101": {
      type: "object",
      meta: { default: {} },
      dict: {
        scale: 1,
        opacity: 2,
        soundEnabled: 3,
        notificationsEnabled: 4,
        selfTalkEnabled: 5,
        followCurrentSession: 9,
        projectRoot: 6,
        workspaceId: 7,
        sessionId: 8,
        openSessionRequest: 10,
      },
    },
  },
});

function appDataDirectory() {
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

function dshHome() {
  const configured = String(process.env.DSH_HOME || "").trim();
  return configured || path.join(os.homedir(), ".dsh");
}

function petConfigPath() {
  const configured = String(process.env.DSH_PET_CONFIG || "").trim();
  return configured || undefined;
}

function bridgeDirectory() {
  return path.join(appDataDirectory(), "dsh-pet-bridge");
}

/**
 * 桌宠自己的数据目录（win32: %APPDATA%\dsh-pet-standalone-webm-chat）。
 *
 * 存在的理由：桌宠进程**写不进桥接目录**（实测 PermissionError 13），
 * 但写自己的数据目录没问题。因此"桌宠写、插件读"的请求文件
 * （chat-request / open-session）落在那里，由本插件一并认领。
 * 目录名与 pet/config.py 的 APP_DIR_NAME 一致。
 */
function petDataDir() {
  return path.join(appDataDirectory(), "dsh-pet-standalone-webm-chat");
}

function readJson(pathname) {
  try {
    if (!fs.existsSync(pathname)) return undefined;
    const value = JSON.parse(fs.readFileSync(pathname, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(pathname, value) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const temporary = `${pathname}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, pathname);
}

function desiredSettingsPath() {
  return path.join(dshHome(), "pet-desired-settings.json");
}

function readyPath() {
  return path.join(dshHome(), "pet-settings-ready.json");
}

function candidatePetConfigPaths() {
  const configured = petConfigPath();
  if (configured !== undefined) return [configured];
  const root = appDataDirectory();
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith("dsh-pet-standalone"))
    .map(entry => path.join(root, entry.name, "config.json"))
    .filter(pathname => fs.existsSync(pathname))
    .sort((left, right) => {
      try {
        return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
      } catch {
        return 0;
      }
    });
}

function writeIntegration(settings) {
  const document = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    projectRoot: settings.projectRoot,
    workspaceId: settings.workspaceId,
    sessionId: settings.sessionId,
  };
  writeJsonAtomic(path.join(dshHome(), "pet-integration.json"), document);
  writeJsonAtomic(path.join(bridgeDirectory(), "pet-integration.json"), document);
  fs.mkdirSync(bridgeDirectory(), { recursive: true });
  fs.appendFileSync(
    path.join(bridgeDirectory(), "dsh-pet-ui.jsonl"),
    `${JSON.stringify({
      ts: Date.now() / 1000,
      agent: "dsh",
      event: "pet/project-mapping",
      projectRoot: settings.projectRoot,
      workspaceId: settings.workspaceId,
      sessionId: settings.sessionId,
    })}\n`,
    "utf8",
  );
}

// ------------------------------------------------- 桌宠「AI 对话」跳转请求
//
// 桌宠点「AI 对话」时往桥接目录写 `open-session-<id>.json`（pet/dsh_jump.py）。
// 桌面版 DSH 没有任何对外入口（无 deep link、无监听端口、second-instance 丢 argv），
// 桥接目录是外部进程唯一能跟 DSH 说话的地方；这里轮询消费它，把请求转成
// settings 写入 —— 客户端半订阅该命名空间，收到变化就 `uiWorkspace.openSession`。
const JUMP_REQUEST_PREFIX = "open-session-";
const JUMP_POLL_MS = 700;

/** 抢占式取走待处理请求：rename 成功才算自己的，避免与另一次轮询重复处理。
 *
 * 扫两个目录的原因与聊天请求一致：**桌宠进程写不进桥接目录**
 * （实测 PermissionError 13），但写自己的数据目录没问题。
 * 因此跳转请求优先落在 `petDataDir()`，这里一并认领。
 * rename 一律在**源目录内**完成——跨目录 rename 会报 EXDEV（cross-device link）。
 */
function claimJumpRequests() {
  const directories = [bridgeDirectory(), petDataDir()];
  const claimed = [];
  for (const directory of directories) {
    let entries = [];
    try {
      entries = fs.readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith(JUMP_REQUEST_PREFIX) || !name.endsWith(".json")) continue;
      const source = path.join(directory, name);
      const target = `${source}.claimed-${process.pid}`;
      try {
        fs.renameSync(source, target);
      } catch {
        continue; // 别人先抢到了，或者桌宠刚删了它
      }
      claimed.push(target);
    }
  }
  return claimed;
}

/** 读一条已抢占的请求；坏文件返回 undefined（消费方负责删掉它）。 */
function readJumpRequest(pathname) {
  const value = readJson(pathname);
  if (value === undefined) return undefined;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  if (sessionId === "") return undefined;
  const id = typeof value.id === "string" && value.id.trim() !== ""
    ? value.id.trim()
    : `jump-${Date.now().toString(36)}`;
  return { id, sessionId };
}

/**
 * 轮询一轮：把桥接目录里的跳转请求写进 settings 命名空间。
 *
 * 写 `openSessionRequest`（每次都是新值，保证产生 `settings/document-updated`）
 * 之外**也写 `sessionId`**：桌宠请求的目标就是它绑定的会话，正常与 sessionId 相同；
 * 但桌宠的映射文件可能落后于设置（例如手工改过），这时以桌宠请求为准更符合直觉。
 * @param ctx - owning Host plugin context (needs `settings`).
 * @returns 本轮处理掉的请求数（测试与日志用）。
 */
async function pollJumpQueue(ctx) {
  let handled = 0;
  for (const claimedPath of claimJumpRequests()) {
    let request;
    try {
      request = readJumpRequest(claimedPath);
    } finally {
      try {
        fs.unlinkSync(claimedPath);
      } catch {
        // 删不掉也不影响：文件已改名，不会被再次认领
      }
    }
    if (request === undefined) continue;
    ctx.logger?.info?.(`dsh-pet-ui: 桌宠请求打开会话 ${request.sessionId}`);
    try {
      await ctx.settings.mutate(NAMESPACE, [
        { op: "set", path: ["sessionId"], value: request.sessionId },
        { op: "set", path: ["openSessionRequest"], value: request.id },
      ]);
      handled += 1;
    } catch (error) {
      ctx.logger?.warn?.("dsh-pet-ui: 跳转请求写入设置失败");
      ctx.logger?.warn?.(error);
    }
  }
  return handled;
}

/**
 * 起轮询定时器消费跳转请求（与 `dsh-pet-bridge/plugin.mjs` 的 control queue 同一套路）。
 * @param ctx - owning Host plugin context.
 * @returns disposer stopping the poller.
 */
function startJumpQueue(ctx) {
  const timer = setInterval(() => { void pollJumpQueue(ctx); }, JUMP_POLL_MS);
  if (typeof timer.unref === "function") timer.unref();
  const dispose = () => clearInterval(timer);
  if (typeof ctx.effect === "function") {
    ctx.effect(() => dispose, "dsh-pet-ui: jump to DSH session");
  }
  return dispose;
}

function pickOverrides(user, resolved) {
  const overrides = {};  for (const key of CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(user, key)) overrides[key] = resolved[key];
  }
  return overrides;
}

function applyPetConfig(overrides) {
  if (Object.keys(overrides).length === 0) return;
  for (const pathname of candidatePetConfigPaths()) {
    applyPetConfigAt(pathname, overrides);
  }
}

function applyPetConfigAt(pathname, settings) {
  const config = readJson(pathname) || { version: 4 };
  if (Object.prototype.hasOwnProperty.call(settings, "scale")) config.scale = settings.scale;
  if (Object.prototype.hasOwnProperty.call(settings, "opacity")) config.pet_opacity = settings.opacity;
  if (Object.prototype.hasOwnProperty.call(settings, "soundEnabled")) {
    config.click_sound_enabled = settings.soundEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(settings, "notificationsEnabled")) {
    config.system_notifications_enabled = settings.notificationsEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(settings, "selfTalkEnabled")) {
    config.self_talk_enabled = settings.selfTalkEnabled;
  }
  if (
    Object.prototype.hasOwnProperty.call(settings, "soundEnabled")
    || Object.prototype.hasOwnProperty.call(settings, "notificationsEnabled")
  ) {
    const agentLink = config.agent_link && typeof config.agent_link === "object"
      ? config.agent_link
      : {};
    if (Object.prototype.hasOwnProperty.call(settings, "notificationsEnabled")) {
      agentLink.notify_state = settings.notificationsEnabled;
      agentLink.notify_done = settings.notificationsEnabled;
      agentLink.notify_activity = settings.notificationsEnabled;
      agentLink.notify_exec_failed = settings.notificationsEnabled;
    }
    if (Object.prototype.hasOwnProperty.call(settings, "soundEnabled")) {
      agentLink.sound_enabled = settings.soundEnabled;
    }
    config.agent_link = agentLink;
  }
  writeJsonAtomic(pathname, config);
}

/** DSH settings service is the Host half's only required dependency. */
export const inject = ["settings"];

/**
 * Register the durable pet settings section and project its resolved value
 * onto the PySide6 pet's external JSON configuration.
 * @param ctx - owning Host plugin context.
 */
export function apply(ctx) {
  let source = () => DEFAULTS;
  const publish = () => {
    const settings = normalizeSettings(source());
    try {
      let user = {};
      try {
        const descriptor = ctx.settings.describe()
          .find(candidate => candidate.ns === NAMESPACE);
        if (descriptor?.user && typeof descriptor.user === "object") {
          user = descriptor.user;
        }
      } catch {
        // A transient describe failure must not overwrite the pet with defaults.
      }
      const overrides = pickOverrides(user, settings);
      applyPetConfig(overrides);
      writeJsonAtomic(desiredSettingsPath(), {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        overrides,
      });
      writeIntegration(settings);
      writeJsonAtomic(readyPath(), {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      ctx.logger?.warn?.("dsh-pet-ui: failed to apply settings");
      ctx.logger?.warn?.(error);
    }
  };
  ctx.settings.installSection(ctx, NAMESPACE, normalizeSettings, { ...DEFAULTS }, {
    setSource: next => { source = next; },
    onChange: publish,
  });
  startJumpQueue(ctx);
}

// Test seam for `tests/ui_follow.test.mjs`: rehydrating this envelope with the
// real `@deepseek-ai/schemastery` proves the added toggle keeps the namespace
// decodable, and pins the envelope, the Host defaults, and the client defaults
// to one key set. Cordis reads `inject` / `apply` from this module and ignores
// the remaining exports (apps/desktop-host/src/local-plugins.ts:181 inserts the
// module URL as a loader entry), so these two names change no runtime behavior.
export { DEFAULTS, normalizeSettings, startJumpQueue, pollJumpQueue, claimJumpRequests, readJumpRequest };
