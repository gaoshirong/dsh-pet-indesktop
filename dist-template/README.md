# DSH 桌宠（dsh-pet-indesktop）

把原来独立的桌宠程序接进 **DSH（DeepSeek Harness）**：桌宠由 DSH 拉起、和 DSH 会话联动、
可以框选屏幕把图发给你正在用的那个会话，回复直接显示在桌宠头顶的气泡里。

## 效果

| 功能 | 说明 |
|---|---|
| 桌宠进程托管 | DSH 启动时自动拉起桌宠，退出时回收；**没有黑控制台窗口** |
| 聊天接 DSH | 点桌宠头顶气泡说话 → 消息进入**你当前的 DSH 会话**，回复流式显示在桌宠头顶气泡 |
| 框选截图提问 | 气泡上的"截图"按钮 → 拖框选屏幕区域 → 连同问题发给 DSH（附一句话，或只发图） |
| 看看屏幕 | 右键桌宠 → 截全屏交给 DSH 评论 |
| agent 事件联动 | DSH 干活时桌宠会播对应音效、播"写代码"等动画 |
| 余额 | 点击桌宠查 DeepSeek 余额（**与聊天账号独立**，聊天走 DSH 不影响余额） |
| 气泡不打架 | 多个气泡（状态/说话/输入）围绕桌宠自动排布，互不遮挡 |

## 安装

### 前置

- Windows 10/11
- DSH 已安装

### 步骤

1. 解压（**不要**直接双击 exe 运行，先解压整个目录）
2. 右键 `install\install.ps1` → **使用 PowerShell 运行**
   （或在 PowerShell 里执行 `powershell -ExecutionPolicy Bypass -File install\install.ps1`）
3. **重启 DSH** 即可

安装脚本会做三件事：

- 把本目录复制到一个稳定的安装位置（默认 `%LOCALAPPDATA%\dsh-pet`，可用 `-Target` 改）
- 把 `@local/dsh-pet-host` 插件目录链接进 DSH 的 desktop profile
- 在 profile 的 `package.json` 里把该插件加入 `dsh.profile.bundles`（**写入前自动备份，UTF-8 无 BOM**）

### 卸载

删除安装目录，并在 DSH profile 的 `package.json` 中移除
`@local/dsh-pet-host` 那一项（安装时的备份文件可用来还原）。

## 目录结构

```
dsh-pet/
├─ plugin/dsh-pet-host/      DSH 宿主插件（Node 侧，桥接与进程托管）
├─ pet/                      桌宠程序本体（Python / PySide6）
├─ installer/launch-pet.ps1  启动器（DSH 用它拉起桌宠）
├─ install/install.ps1       安装脚本
└─ README.md
```

## 常见问题

**桌宠启动后没反应？**
看 `%TEMP%\dsh-pet-diag\` 下的日志（`pet-stdout.log` / `pet-stderr.log` / `pet-launch-trace.log`）。

**聊天没进 DSH 会话？**
确认桌宠设置里"模型服务"选的是 **DSH 会话**（而不是某个独立 API）。
选了独立 API 就会绕过 DSH 单独走。

**余额查不出来？**
余额需要 DeepSeek 官方账号的 API Key。在设置里给某个 provider 填上 Key 即可——
余额用的账号与聊天用的账号是**分开配置**的（`balance_provider`），互不影响。

**桌宠拖不到屏幕边缘？**
确认 `assets/characters/<角色>/videos/manifest.json` 里有 `body_box` 字段。
缺少它时定位会退回整张画布，画布透明留白会占位导致提前停住。

## 许可

桌宠本体沿用原项目许可；DSH 插件部分见 `plugin/dsh-pet-host/`。
