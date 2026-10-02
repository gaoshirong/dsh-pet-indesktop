// 桌宠进程托管（宿主包专用，只做"拉起 + 回收 + 重启"，不碰任何客户端 UI）。
//
// 为什么单独成包：原来的 @local/dsh-pet 既声明 dsh.client 又当 bundle，
// DSH 的 dsh-client-modules 按"行解析到的 package.json 的 name"归属包并硬校验，
// 同一个包被 bundle 层和客户端行同时解析 → required 插件 modules 不激活 →
// **DSH 启动即崩**。本包不声明 dsh.client，因此不会撞那条校验。
//
// 引擎：全功能 Python 版桌宠（PySide6），由 launch-pet.ps1 拉起。
// 这保证了功能完整度与旧版完全一致（121 个配置键、43 个菜单动作、10 域设置页）。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "dsh-pet-host";

// 宿主日志在桌面端不落盘（GUI 进程 stdout 被丢弃），所以自己写一份，
// 否则"选了哪个分支、spawn 了什么、为什么没起来"从外面完全看不见。
const DIAG_LOG = path.join(process.env.USERPROFILE || os.homedir(), ".dsh", "pet-host.log");
function diag(...args) {
  try {
    const text = args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    fs.appendFileSync(DIAG_LOG, `[${new Date().toISOString().slice(11, 19)}] ${text}\n`);
  } catch {
    /* 记日志失败绝不能影响主流程 */
  }
}

// 用户从桌宠右键菜单主动退出时的退出码（launch-pet.ps1 会透传）
const USER_QUIT_CODE = 3;

/**
 * 解析桌宠的安装位置。
 *
 * 发行版不能把路径写死成开发机上的 `D:\DSH-Pet`——别人装到哪由安装脚本决定。
 * 优先顺序：
 *   1. `~/.dsh/dsh-pet-install.json`（由 install/install.ps1 写入：root / launcher / petSource）
 *   2. 插件自身目录的上一级（发行包内 plugin/<name>/ 的同级就是 pet/ 与 installer/）
 *   3. 开发机默认值（保留，便于源码模式开发）
 * 返回 { sourceRoot, launchScript, petDirectory }，任何一项都可能为空串。
 */
function resolveInstallPaths() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const fromPointer = { sourceRoot: "", launchScript: "", petDirectory: "" };
  try {
    const raw = fs.readFileSync(path.join(dshHome, "dsh-pet-install.json"), "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      if (data.petSource) fromPointer.sourceRoot = path.join(String(data.petSource));
      if (data.launcher) fromPointer.launchScript = String(data.launcher);
      // 打包 exe 目录通常与 launcher 同级的 dsh-pet 子目录
      if (data.root) fromPointer.petDirectory = path.join(String(data.root), "pet");
    }
  } catch { /* 未安装（源码开发）时正常走后面的分支 */ }

  // 发行包内自洽布局：<root>/plugin/dsh-pet-host/  ->  <root>/pet, <root>/installer
  const pluginDir = path.dirname(fileURLToPath(import.meta.url));
  const distRoot = path.dirname(path.dirname(pluginDir));
  const fromDist = {
    sourceRoot: path.join(distRoot, "pet"),
    launchScript: path.join(distRoot, "installer", "launch-pet.ps1"),
    petDirectory: path.join(distRoot, "pet"),
  };

  const pick = (key) => {
    for (const candidate of [fromPointer[key], fromDist[key]]) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return "";
  };
  return {
    sourceRoot: pick("sourceRoot"),
    launchScript: pick("launchScript"),
    petDirectory: pick("petDirectory"),
  };
}

const INSTALLED = resolveInstallPaths();

const DEFAULTS = Object.freeze({
  engine: "python",
  // 桌宠路径全部来自 `resolveInstallPaths()`（安装信息 → 发行包自洽布局），
  // **刻意不留开发机路径兜底**：分发出去以后，写死的 D:\DSH-Pet 只会误导
  // 排错（明明目录不存在却按它去 spawn）。解析不到时保持空串，由
  // resolveExecutable 走"没有可用入口"的分支并写出可操作的诊断。
  // exe 与源码是同一份程序的两种形态，功能一致，因此源码优先、exe 作为回退。
  sourceRoot: INSTALLED.sourceRoot || "",
  sourceEntry: "dsh_pet_launcher.py",
  pythonExe: process.env.DSH_PET_PYTHON || "",
  petDirectory: INSTALLED.petDirectory || "",
  launchScript: INSTALLED.launchScript || "",
  executable: "",
  autoStart: true,
  // 需求：桌宠不出现在托盘/溢出区（launch-pet.ps1 每次拉起前会写 show_dock_icon=false）
  trayIcon: false,
  respawn: true,
  respawnMax: 5,
  respawnDelayMs: 4000,
  minUptimeMs: 60000,
});

/**
 * 解析桌宠入口，优先级：显式路径 -> 环境变量 -> 源码包装器 -> 打包 exe。
 *
 * 源码优先于 exe 是刻意的：源码是可读、可改、无需重新打包的形态，
 * 而 exe 只是它的打包快照。两者共用同一份 config.json（都由
 * build_variant.VARIANT = webm-chat 决定目录名），来回切换不丢设置。
 */
function resolveExecutable(settings) {
  try {
    if (settings.executable && fs.existsSync(settings.executable)) return path.resolve(settings.executable);
    const fromEnv = process.env.DSH_PET_EXE;
    if (fromEnv && fs.existsSync(fromEnv)) return path.resolve(fromEnv);

    const sourceEntry = path.join(settings.sourceRoot ?? "", settings.sourceEntry ?? "");
    if (settings.sourceRoot && fs.existsSync(sourceEntry)) return path.resolve(sourceEntry);

    const petDirectory = settings.petDirectory;
    if (!petDirectory || !fs.existsSync(petDirectory)) return "";
    const candidates = fs
      .readdirSync(petDirectory)
      .filter((name) => /^dsh-pet-standalone-.*\.exe$/i.test(name))
      .map((name) => path.join(petDirectory, name))
      .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return candidates.length ? candidates[0].p : "";
  } catch {
    return "";
  }
}

/** 源码模式判定：入口是 .py 包装器。 */
function isSourceEntry(entry) {
  return path.extname(entry).toLowerCase() === ".py";
}

/**
 * 启动桌宠：源码模式直接用解释器执行包装器，打包模式直接执行 exe。
 * 两条路径下返回的都是"桌宠进程本身"，因此回收/重启逻辑保持一致。
 */
function spawnPet(settings, executable) {
  const powershell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";

  // 统一经 launch-pet.ps1 启动：它负责托盘开关、配置目录对齐、优先级、进程树回收，
  // 并且已经实测能同时处理 exe 与 .py 两种入口。经环境变量把入口传给它，
  // 避免它回退到不存在的 D:\DSH\dsh-pet 目录。
  diag("spawn:", powershell, "-File", settings.launchScript, "| entry =", executable);
  return spawn(
    powershell,
    ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", settings.launchScript],
    {
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        DSH_PET_LAUNCHER: executable,
        DSH_PET_SOURCE: isSourceEntry(executable) ? "1" : "",
        DSH_PET_PYTHON: settings.pythonExe ?? "",
      },
    },
  );
}

/**
 * 旧桌宠的 config.json 里有 show_dock_icon，由它自己决定是否注册托盘图标。
 * launch-pet.ps1 也会写，这里再兜一层，保证"托盘不出现"这条硬需求。
 * 配置目录名两种模式一致：打包版取 exe 名，源码版由 build_variant.VARIANT
 * 决定，同为 dsh-pet-standalone-webm-chat。
 */
function petConfigDirName(executable) {
  if (isSourceEntry(executable)) return "dsh-pet-standalone-webm-chat";
  return path.basename(executable, path.extname(executable));
}

/**
 * 旧桌宠的 config.json 里有 show_dock_icon，由它自己决定是否注册托盘图标。
 * launch-pet.ps1 也会写，这里再兜一层，保证"托盘不出现"这条硬需求。
 */
function disableOldPetTrayIcon(executable) {
  try {
    const appData = process.env.APPDATA;
    if (!appData) return;
    const configPath = path.join(appData, petConfigDirName(executable), "config.json");
    if (!fs.existsSync(configPath)) {
      // 首次运行（新电脑第一次启动）：桌宠还没生成 config.json，而它的默认值是
      // show_dock_icon=true。原实现此处直接 return，于是第一次启动会冒出托盘图标，
      // 要等第二次才被修掉（实测症状："装到新电脑后桌宠图标出现在托盘里"）。
      // 这里先播种一份最小配置；桌宠加载时会补齐其余默认键。
      try {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({ version: 4, show_dock_icon: false }, null, 2), "utf8");
        diag("首次运行：已播种配置以关闭托盘图标：", configPath);
      } catch (error) {
        diag("播种配置失败：", error?.message ?? String(error));
      }
      return;
    }
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (config.show_dock_icon === false) {
      diag("show_dock_icon 已是 false（不显示托盘图标）");
      return;
    }
    config.show_dock_icon = false;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    diag(`已把 show_dock_icon 置为 false：${configPath}`);
  } catch (error) {
    diag("关闭托盘图标失败：", error?.message ?? String(error));
  }
}

export function apply(ctx, config = {}) {
  const log = (...a) => {
    try {
      ctx.logger?.info?.(`[${PLUGIN_ID}]`, ...a);
    } catch { /* ignore */ }
  };
  const warn = (...a) => {
    try {
      ctx.logger?.warn?.(`[${PLUGIN_ID}]`, ...a);
    } catch { /* ignore */ }
  };

  const settings = { ...DEFAULTS, ...(config && typeof config === "object" ? config : {}) };
  diag("--- host apply ---");
  diag("config keys =", Object.keys(config ?? {}));
  diag("sourceRoot =", settings.sourceRoot, "| petDirectory =", settings.petDirectory, "| launchScript =", settings.launchScript);

  const executable = resolveExecutable(settings);
  if (!executable) {
    warn(`没找到桌宠入口（源码包装器或打包 exe），跳过拉起。`);
    diag("未找到入口，放弃");
    return;
  }
  if (!fs.existsSync(settings.launchScript)) {
    warn(`没找到启动脚本，跳过拉起：${settings.launchScript}`);
    diag("未找到启动脚本，放弃");
    return;
  }
  diag(`解析到入口 = ${executable}（模式：${isSourceEntry(executable) ? "源码" : "打包 exe"}）`);
  if (settings.trayIcon === false) disableOldPetTrayIcon(executable);

  let child = null;
  let startedAt = 0;
  let respawnCount = 0;
  let disposed = false;
  let respawnTimer = null;

  const isRunning = () => Boolean(child) && child.exitCode === null;

  function start() {
    if (disposed || isRunning()) return;
    try {
      child = spawnPet(settings, executable);
      startedAt = Date.now();
      log(`已拉起桌宠：${isSourceEntry(executable) ? "源码版 " : ""}${path.basename(executable)}`);
      child.on("error", (error) => warn("桌宠启动失败：", error?.message ?? String(error)));
      child.on("exit", (code) => onExit(code));
    } catch (error) {
      warn("桌宠拉起异常：", error?.message ?? String(error));
      diag("spawn 异常：", error?.message ?? String(error));
    }
  }

  function onExit(code) {
    const uptime = Date.now() - startedAt;
    diag(`桌宠进程退出，code = ${code}，运行 ${Math.round(uptime / 1000)}s`);
    child = null;
    if (disposed || !settings.respawn) return;
    if (code === USER_QUIT_CODE) {
      diag("用户主动退出，不再重启");
      return;
    }
    if (code !== 0 && uptime < settings.minUptimeMs) {
      warn(`桌宠启动后仅 ${Math.round(uptime / 1000)}s 就退出（code ${code}），不再重启以避免循环拉起`);
      return;
    }
    if (respawnCount >= settings.respawnMax) {
      warn(`桌宠已重启 ${respawnCount} 次，达到上限，不再重启（DSH 重启后会重新拉起）`);
      return;
    }
    respawnCount += 1;
    log(`将在 ${settings.respawnDelayMs}ms 后第 ${respawnCount}/${settings.respawnMax} 次重启桌宠`);
    respawnTimer = setTimeout(() => {
      respawnTimer = null;
      try {
        start();
      } catch { /* ignore */ }
    }, settings.respawnDelayMs);
    if (typeof respawnTimer.unref === "function") respawnTimer.unref();
  }

  function stop() {
    disposed = true;
    if (respawnTimer) {
      clearTimeout(respawnTimer);
      respawnTimer = null;
    }
    if (!child) return;
    const pid = child.pid;
    // 先 taskkill 整棵树：powershell 是父进程、桌宠是子进程，只 kill 父会留下孤儿桌宠
    try {
      if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch { /* ignore */ }
    setTimeout(() => {
      try {
        if (child && child.exitCode === null) child.kill();
      } catch { /* ignore */ }
    }, 1500);
    diag("已请求结束桌宠进程树，pid =", pid);
    child = null;
  }

  if (settings.autoStart) start();
  ctx.effect(() => () => stop(), `${PLUGIN_ID}: launcher`);
}
