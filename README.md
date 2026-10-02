# dsh-pet-indesktop — DSH 桌宠

把 [dsh-pet-indesktop](https://github.com/MerZlin/dsh-pet-indesktop) 桌宠接进
**DSH（DeepSeek Harness）**：桌宠由 DSH 拉起，聊天直接走你正在用的 DSH 会话，
还能框选屏幕把图发给会话。

> 桌宠本体来自 **MerZlin** 的 MIT 项目（见 [LICENSE](LICENSE)）。
> 本仓库提供的是**DSH 接入层**（宿主插件 + 启动/安装脚本）与为接入所做的适配改动。

## 效果

| 功能 | 说明 |
|---|---|
| 进程托管 | DSH 启动时拉起桌宠、退出时回收；**无黑控制台窗口** |
| 聊天接 DSH | 点桌宠头顶气泡说话 → 消息进入**当前 DSH 会话**，回复流式显示在桌宠头顶气泡 |
| 框选截图提问 | 气泡上的"截图"按钮 → 拖框选区域 → 连同问题发给 DSH |
| 看看屏幕 | 右键桌宠 → 截全屏交给 DSH 评论 |
| agent 事件联动 | DSH 干活时桌宠播对应音效与动画 |
| 余额 | 点击桌宠查 DeepSeek 余额（账号与聊天**分开配置**，互不影响） |
| 多气泡排布 | 状态/说话/输入气泡围绕桌宠自动排布，互不遮挡 |

## 下载安装

**普通用户**：到 [Releases](../../releases) 下载 `dsh-pet-portable.zip`，然后

1. 解压（**不要**直接双击 exe，先解压整个目录）
2. 右键 `install\install.ps1` → **使用 PowerShell 运行**
3. **重启 DSH**

安装脚本会顺带把 Python 环境准备好：在本机寻找可用的 Python 3，在发行包根目录建
`python\` 虚拟环境并安装 `pet\requirements.txt` 的依赖（约需 1-3 分钟，PySide6 较大），
再把解释器路径记录下来供启动器使用。**你不需要自己配置 Python**。

> 如果本机完全没有 Python 3，脚本会给出提示。此时可先装官方 Python
> （<https://www.python.org/downloads/>，安装时勾选 *Add python.exe to PATH*），
> 再运行一次安装脚本即可。
> 注意：Windows 应用商店的 `python.exe` 是**占位程序**（运行只提示去商店安装），
> 安装脚本与启动器都会识别并跳过它。

**从源码安装**：见下方「自行构建」。

## 仓库结构

```
├─ pet\                    桌宠本体源码（Python / PySide6，来自上游项目）
├─ dsh-pet-host\           DSH 宿主插件（Node 侧：进程托管 + 桥接）
├─ dist-template\          发行模板：install.ps1 / build-dist.ps1 / README
├─ docs\UPSTREAM-README.md 上游项目原始说明
└─ LICENSE                 MIT（版权归原作者 Merzlin）
```

## 自行构建

### 方式一：源码包（目标机需自备 Python 与依赖）

```powershell
pip install -r pet\requirements.txt
powershell -ExecutionPolicy Bypass -File dist-template\build-dist.ps1 -Mode source
```

### 方式二：自包含包（用户无需安装 Python，推荐）

先做 PyInstaller onedir 构建：

```powershell
cd pet
pip install pyinstaller
powershell -ExecutionPolicy Bypass -File scripts\build_onedir.ps1 -Variant webm-chat
```

再组装发行包：

```powershell
cd ..
powershell -ExecutionPolicy Bypass -File dist-template\build-dist.ps1 -Mode frozen
```

产物：`dsh-pet-dist\` 与 `dsh-pet-portable.zip`。

## 工作原理

```
DSH（Electron）
 └─ 宿主插件 dsh-pet-host          ← 运行在 DSH 的 Node 进程里
     ├─ launcher.js   解析桌宠路径（~/.dsh/dsh-pet-install.json 或发行包布局）
     │                 spawn installer\launch-pet.ps1 → pythonw 跑桌宠
     ├─ bridge.js     桥接：转发 agent 事件；收桌宠的聊天请求 →
     │                 投进 DSH 会话（sessionController.prompt 队列）→ 流式回写
     └─ pet-ui.js     跟随当前会话（pet-integration.json）

桌宠（Python / PySide6）
 └─ pet/chat/dsh_provider.py      把对话/识屏接到 DSH 会话
     pet/screen_region.py         框选截图覆盖层
     pet/bubble_layout.py         多气泡排布
     pet/dsh_jump.py              请求 DSH 前台打开会话
```

**文件协议**（桥接目录 `%APPDATA%\dsh-pet-bridge\`）：

| 方向 | 文件 |
|---|---|
| 桌宠 → DSH | `chat-request-<id>.json`（写在桌宠数据目录，插件一并认领） |
| DSH → 桌宠 | `chat-stream-<id>.jsonl`、`chat-cancel-<id>.json` |
| 会话跟随 | `pet-integration.json` |

## 已知限制

- 仅 Windows（启动器与安装脚本是 PowerShell；桌宠本体上游支持多平台）
- 聊天与"看看屏幕"依赖**当前 DSH 会话**；DSH 未运行时无法对话
- `body_box`：角色若缺 `videos/manifest.json` 的 `body_box`，桌宠会因画布透明留白
  而拖不到屏幕边缘（本仓库已为 `shenshen` 补好，其他角色需自行测量）

## 许可

MIT，版权归原作者 **Merzlin**（见 [LICENSE](LICENSE)）。
本仓库的接入层改动同样以 MIT 提供。
