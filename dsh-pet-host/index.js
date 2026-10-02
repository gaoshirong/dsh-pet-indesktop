// 桌宠桌面端插件（宿主半边）唯一入口。
//
// 这是**纯 Node/Electron 侧**的插件：不声明 dsh.client，不向 Web 页面注入任何东西。
// 这样收口的原因：本包此前把"设置面板"并进来并声明了 dsh.client，结果在
// dsh-client-modules 的客户端模块校验上反复把 DSH 拖崩（前后 5 次）。
//
// 而桌宠的能力本来就都在宿主半边：
//   - 进程托管       launcher.js   拉起/回收 pythonw 跑的源码版桌宠
//   - agent 事件 + 聊天通道  bridge.js   inject llm/agentDefaultModel —— 用 DSH 同一个脑子
//   - 会话跳转队列   pet-ui.js    inject settings —— 桌宠请求打开当前 DSH 会话
// 设置不需要 Web 面板：桌宠自带设置窗口（settings_process_isolation 已关，走进程内）。
//
// 三块的 inject 取并集；任一块 apply 抛错都不能拖垮另外两块、更不能拖垮 profile 启动。
import { apply as applyLauncher } from "./launcher.js";
import { apply as applyBridge, inject as bridgeInject } from "./bridge.js";
import { apply as applySettings, inject as settingsInject } from "./pet-ui.js";

export const name = "dsh-pet-host";

/** 三块依赖的宿主服务并集（去重）。 */
export const inject = [
  ...new Set([
    ...(Array.isArray(bridgeInject) ? bridgeInject : []),
    ...(Array.isArray(settingsInject) ? settingsInject : []),
  ]),
];

export function apply(ctx, config = {}) {
  const log = (...a) => {
    try {
      ctx.logger?.info?.("[dsh-pet-host]", ...a);
    } catch { /* ignore */ }
  };
  const warn = (...a) => {
    try {
      ctx.logger?.warn?.("[dsh-pet-host]", ...a);
    } catch { /* ignore */ }
  };

  const parts = [
    ["bridge", applyBridge],
    ["settings/jump", applySettings],
    ["launcher", applyLauncher],
  ];
  for (const [label, fn] of parts) {
    try {
      fn(ctx, config);
      log(`${label} 已装载`);
    } catch (error) {
      warn(`${label} 装载失败：`, error?.message ?? String(error));
    }
  }
}
