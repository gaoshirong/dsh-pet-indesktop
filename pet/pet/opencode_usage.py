# -*- coding: utf-8 -*-
"""OpenCode Zen / Go 的**用量**查询（GET /zen/go/v1/usage）。

与 `balance.py`（DeepSeek 的金额余额）并列：DeepSeek 给的是"还剩多少钱"，
OpenCode 给的是"三个时间窗各用了百分之多少 + 何时重置"。

## 接口（官方，API Key 认证）

    GET https://opencode.ai/zen/go/v1/usage
    Authorization: Bearer <OPENCODE_GO_API_KEY>

    {
      "usage": {
        "rolling": { "status": "ok", "percent": 25, "resetsAt": "..." },  # $12 / 5 小时
        "weekly":  { "status": "ok", "percent": 50, "resetsAt": "..." },  # $30 / 周
        "monthly": { "status": "ok", "percent": 10, "resetsAt": "..." }   # $60 / 月
      }
    }

## 两个必须注意的语义

1. `percent` 是 **0-100**（不是 0-1），展示时直接用；若要折算成"已用比例"记得除 100。
2. `status == "rate-limited"` 表示该窗口**已限流**，此时 `percent` 可能仍然很低
   （实测样例：`percent: 5` 但已限流）。**只看百分比会误导**，所以状态必须一起显示。

## Key 从哪来

`OPENCODE_GO_API_KEY` 在多数机器上**不是环境变量**——DSH 把它明文放在
`~/.dsh/.credentials.yaml` 的 `refs:` 段（`OPENCODE_GO_API_KEY: <值>`）。
因此读取顺序：环境变量 → 该凭据文件。
"""

from __future__ import annotations

import json
import os
import re
import socket
import urllib.error
import urllib.request
from pathlib import Path

#: 官方用量端点（opencode-go 路由的 baseUrl 是 https://opencode.ai/zen/go）
USAGE_URL = "https://opencode.ai/zen/go/v1/usage"

#: 三个窗口的展示名与顺序（对应 $12/5h、$30/周、$60/月）
WINDOW_LABELS: tuple[tuple[str, str], ...] = (
    ("rolling", "5小时"),
    ("weekly", "本周"),
    ("monthly", "本月"),
)

#: credentials.yaml 里我们要找的键名
KEY_NAME = "OPENCODE_GO_API_KEY"


def _credentials_path() -> Path:
    dsh_home = os.environ.get("DSH_HOME") or str(Path.home() / ".dsh")
    return Path(dsh_home) / ".credentials.yaml"


def read_opencode_key() -> str:
    """取 OPENCODE_GO_API_KEY：环境变量优先，其次 DSH 凭据文件的 `refs:` 段。

    凭据文件是简单 YAML，这里只做**行扫描**而不引入 PyYAML（桌宠依赖里没有它，
    为一个键引入解析器不值得）。解析失败返回空串，由调用方给出可读提示。
    """
    from_env = str(os.environ.get(KEY_NAME) or "").strip()
    if from_env:
        return from_env
    try:
        text = _credentials_path().read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    # 只在 refs: 段里找，避免误取 records 段里同名的其它内容
    match = re.search(r"^refs:\s*$(.*?)(?=^\S|\Z)", text, re.M | re.S)
    section = match.group(1) if match else text
    for line in section.splitlines():
        stripped = line.strip()
        if stripped.startswith(f"{KEY_NAME}:"):
            value = stripped.split(":", 1)[1].strip().strip("'\"")
            return value
    return ""


def _ssl_context(verify: bool = True):
    import ssl

    if verify:
        try:
            import certifi

            return ssl.create_default_context(cafile=certifi.where())
        except Exception:  # noqa: BLE001 - 没有 certifi 就用系统默认
            return ssl.create_default_context()
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


def fetch_opencode_usage(api_key: str = "", timeout: float = 10.0, verify_ssl: bool = True) -> dict:
    """查询用量，返回 `{window: {percent, status, resetsAt, exhausted}}`。

    失败抛 `balance.BalanceError`（与 DeepSeek 余额共用同一个异常类型，
    便于上层统一走气泡提示）。
    """
    from .balance import BalanceError

    key = str(api_key or "").strip() or read_opencode_key()
    if not key:
        raise BalanceError(f'未配置 {KEY_NAME}')

    request = urllib.request.Request(
        USAGE_URL,
        headers={
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            # 该服务前置有 Cloudflare：缺少客户端标识的请求可能被 403。
            # 这里带上与官方 CLI 一致的形态，避免"能聊天却读不到用量"。
            "User-Agent": "opencode",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=_ssl_context(verify_ssl)) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise BalanceError(f'HTTP {exc.code}') from exc
    except (socket.timeout, TimeoutError) as exc:
        raise BalanceError('请求超时') from exc
    except urllib.error.URLError as exc:
        reason = str(getattr(exc, "reason", "") or "")
        if "timed out" in reason.lower() or "timeout" in reason.lower():
            raise BalanceError('请求超时') from exc
        raise BalanceError(f'网络连接失败：{reason}') from exc
    except json.JSONDecodeError as exc:
        raise BalanceError('返回内容不是合法 JSON') from exc

    usage = payload.get("usage") if isinstance(payload, dict) else None
    if not isinstance(usage, dict):
        raise BalanceError('返回内容里没有 usage 字段')

    result: dict[str, dict] = {}
    for window, _label in WINDOW_LABELS:
        item = usage.get(window)
        if not isinstance(item, dict):
            continue
        raw_percent = item.get("percent")
        try:
            percent = max(0.0, min(100.0, float(raw_percent)))
        except (TypeError, ValueError):
            percent = 0.0
        status = str(item.get("status") or "").strip()
        result[window] = {
            "percent": percent,
            "status": status,
            # rate-limited 时百分比不可信，单独标出来给展示层用
            "limited": status.lower() == "rate-limited",
            "resetsAt": str(item.get("resetsAt") or ""),
        }
    if not result:
        raise BalanceError('返回内容里没有可识别的用量窗口')
    return result


def _friendly_reset(raw: str) -> str:
    """把 ISO 时间转成"还剩多久"；解析不了就原样返回日期部分。"""
    text = str(raw or "").strip()
    if not text:
        return ""
    try:
        from datetime import datetime, timezone

        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        remain = moment.timestamp() - datetime.now(timezone.utc).timestamp()
        if remain <= 0:
            return "即将重置"
        hours, minutes = int(remain // 3600), int((remain % 3600) // 60)
        if hours >= 24:
            return f"{hours // 24}天{hours % 24}小时后重置"
        if hours >= 1:
            return f"{hours}小时{minutes}分后重置"
        return f"{max(1, minutes)}分后重置"
    except (TypeError, ValueError):
        return text[:16]


def format_opencode_usage(usage: dict) -> str:
    """格式化成气泡文案：`OpenCode 用量：5小时 25% · 本周 50% · 本月 10%`。

    限流的窗口标「已限流」而不是只报百分比——实测 percent 可能仍很低，
    只看数字会让人以为还有余量。
    """
    parts: list[str] = []
    for window, label in WINDOW_LABELS:
        item = usage.get(window)
        if not item:
            continue
        if item.get("limited"):
            parts.append(f"{label} 已限流")
        else:
            parts.append(f"{label} {item.get('percent', 0):.0f}%")
    if not parts:
        return "OpenCode 用量：无数据"
    head = "OpenCode 用量：" + " · ".join(parts)
    # 重置时间取第一个"用得多"的窗口，避免一句话塞三段时间
    busiest = max(
        (usage.get(w) for w, _ in WINDOW_LABELS if usage.get(w)),
        key=lambda item: (1 if item.get("limited") else 0, item.get("percent", 0)),
        default=None,
    )
    reset = _friendly_reset((busiest or {}).get("resetsAt", "")) if busiest else ""
    return f"{head}（{reset}）" if reset else head
