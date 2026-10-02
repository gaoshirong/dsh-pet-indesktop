# -*- coding: utf-8 -*-
"""桌宠 -> DSH 的会话跳转请求（插件侧 `pet-ui.js` 注释里点名的那个文件）。

DSH 侧 `pet-ui.js` 轮询桥接目录里的 `open-session-<id>.json`：

    桌宠写 open-session-<id>.json {id, sessionId}
      -> pet-ui 抢占（rename 成 .claimed-<pid>）并读取
      -> 写进 settings 命名空间（openSessionRequest + sessionId）
      -> 客户端半收到变化后 uiWorkspace.openSession(...)

桌面版 DSH 没有对外入口（无 deep link、无监听端口、second-instance 丢 argv），
所以"把 DSH 拉到前台并切到某个会话"只能通过桥接目录请求。

**桌宠进程写桥接目录是被允许的**（实测：写 chat-request 会 PermissionError，
但写 open-session 不会）——两者的差别在 DSH 侧的文件策略，跳转请求属于白名单。
若哪天写失败，本模块只记录诊断并返回 False，不抛错打断界面。
"""

from __future__ import annotations

from .chat.dsh_provider import diag, request_open_session, resolve_session_id

#: 便于其它模块按旧名导入
__all__ = ["request_open_session", "resolve_session_id", "jump_to_dsh"]


def jump_to_dsh(session_id: str = "") -> bool:
    """请求 DSH 前台打开会话；返回是否投出成功。

    `session_id` 留空时自动解析当前活跃会话（优先桥接事件里的最新会话，
    其次 `pet-integration.json`）。
    """
    return request_open_session(session_id)
