# -*- coding: utf-8 -*-
"""DSH 会话 provider：让桌宠的对话/识屏走 DSH 自己的会话（"同一个脑子"）。

## 背景

`config.json` 里的 `dsh-session` provider 一直存在（`base_url = dsh://session`），
但桌宠侧从来没有对应的实现——上游仓库里没有这个文件。所以选中它时会走到
HTTP 路径，报 `unknown url type: dsh`（识屏）或直接把请求发去不存在的地址（聊天）。

## 通道

与 DSH 侧插件 `@local/dsh-pet` 的 `bridge.js` 配对（协议实现在它的
"桌宠聊天 → DSH 会话"一节）：

    请求   <bridge>/chat-request-<id>.json   原子的（临时文件 + 改名）
    流     <bridge>/chat-stream-<id>.jsonl   插件 append，每行一条记录
    取消   <bridge>/chat-cancel-<id>.json

流记录：
    {"kind":"delta","text":...}      增量正文，累加即全文
    {"kind":"done","reason":...}     结束（reason 可能是 "attached"）
    {"kind":"error","error":...}     失败（bad-request / session-not-live / ...）
    {"kind":"accepted",...}          attach 的投递回执

请求字段（插件侧上限，超出会被截断）：
    id, sessionId, text(<=12000), persona(<=2000),
    operation: "ask"(默认) | "attach", uploadHandle,
    image{mediaType, data(base64, 解码后 <=4MB)}

## 为什么图片要走 attach + ask 两步

插件里对冷会话（无活 Agent）有一条硬规则：**裸 base64 塞进 prompt 会渲染成
"[Image attachment unavailable]" 并让整条请求失败**。必须先 attach 让 DSH 自己
收编成附件、拿到 uploadHandle，再用 handle 提问。热会话会把图 inject 进收件箱。
"""

from __future__ import annotations

import base64
import json
import os
import tempfile
import threading
import time
import uuid
import weakref
from pathlib import Path
from typing import Any, Iterator

#: 轮询间隔：与插件侧 CHAT_POLL_MS 对齐
POLL_SECONDS = 0.12
#: 整体超时：插件侧请求 10 分钟过期，这里留一点余量
DEFAULT_DEADLINE_SECONDS = 600.0
#: 单张图片上限（解码后字节）；插件侧上限 4MB
MAX_IMAGE_BYTES = 4 * 1024 * 1024
#: 与插件侧 CHAT_MAX_TEXT 对齐
MAX_TEXT = 12000
MAX_PERSONA = 2000


class DshSessionError(RuntimeError):
    """DSH 会话通道失败。"""


#: 待发送图片：`{id(provider): (weakref(provider), (data, media_type))}`。
#: 用模块级字典而非实例属性——实测实例属性出现过"写入后立刻读不到"的怪象
#: （同一实例、21ms 内），模块级存储在排查期间更可靠；弱引用保证实例回收时
#: 条目自动失效，不会积累内存。
_PENDING_IMAGES: dict[int, tuple[Any, tuple[bytes, str]]] = {}


#: 诊断日志：worker 线程里的阻塞/异常不落桌宠日志，而"一直思考中"正是
#: "worker 没返回"的表现。所以自己写一份。
#:
#: 位置选择：**先写桌宠自己的配置目录**（它必然可写，那里已有 config.json 与
#: pet-*.log），桥接目录只作为次选。之前只写桥接目录导致"日志根本没出现"，
#: 无法区分"没调用"与"写不进去"。
def _diag_candidates() -> list[Path]:
    candidates: list[Path] = []
    appdata = os.environ.get("APPDATA") or str(Path.home())
    # 桌宠配置目录：与 pet/config.py 的 APP_DIR_NAME 一致
    candidates.append(Path(appdata) / "dsh-pet-standalone-webm-chat" / "dsh-provider.log")
    candidates.append(Path(appdata) / "dsh-pet-bridge" / "dsh-provider.log")
    return candidates


def diag(msg: str) -> None:
    """尽力写一行诊断；写不进去也绝不抛错（诊断不能影响主流程）。"""
    import datetime

    stamp = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]
    line = f"{stamp} [pid={os.getpid()} tid={threading.get_ident()}] {msg}\n"
    for path in _diag_candidates():
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(line)
            return
        except Exception:  # noqa: BLE001
            continue


def bridge_dir() -> Path:
    """桥接目录：与 DSH 侧插件 `bridgeDir()` 一致（%APPDATA%\\dsh-pet-bridge）。"""
    appdata = os.environ.get("APPDATA") or str(Path.home())
    return Path(appdata) / "dsh-pet-bridge"


def _dsh_home() -> Path:
    return Path(os.environ.get("DSH_HOME") or (Path.home() / ".dsh"))


def read_integration() -> dict:
    """读 `pet-integration.json`（由 DSH 侧 pet-ui 维护的"跟随当前会话"投影）。

    两个可能位置都看：桥接目录与 ~/.dsh。返回 {} 表示拿不到。
    """
    for path in (bridge_dir() / "pet-integration.json", _dsh_home() / "pet-integration.json"):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                return data
        except (OSError, ValueError):
            continue
    return {}


def live_session_id_from_bridge() -> str:
    """从桥接事件文件里取最近一次出现的会话 id。

    为什么需要这个兜底：`pet-integration.json` 只在 sessionId **变化**时才被
    pet-ui 写入（同值不写），所以它可能是很久以前的值——实测就停在旧会话上。
    而 DSH 侧 bridge 每次事件都带 sessionId，且文件按时间追加，
    因此"最新事件里的 sessionId"就等于**当前活着的会话**。
    """
    directory = bridge_dir()
    try:
        candidates = sorted(
            (p for p in directory.glob("dsh-*.jsonl") if p.is_file()),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return ""
    for path in candidates[:4]:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()[-80:]
        except OSError:
            continue
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            session_id = str((record or {}).get("sessionId") or "").strip()
            if session_id:
                return session_id
    return ""


def pinned_session_path() -> Path:
    """桌宠"关联对话"的落盘位置（桌宠自己的数据目录，它可写）。"""
    return pet_data_dir() / "pet-target-session.json"


def read_pinned_session() -> str:
    """读取桌宠关联的会话 id；未关联返回空串。"""
    try:
        path = pinned_session_path()
        if not path.exists():
            return ""
        data = json.loads(path.read_text(encoding="utf-8"))
        return str((data or {}).get("sessionId") or "").strip()
    except (OSError, ValueError):
        return ""


def write_pinned_session(session_id: str, label: str = "") -> bool:
    """把桌宠关联到指定会话（空串 = 取消关联，回到"跟随当前会话"）。

    关联之后，桌宠发出的消息**只走这个会话**，不再插进用户正在干活的对话——
    这正是"不影响其他工作"的实现方式。写盘用原子替换，避免读到半个文件。
    """
    target = pinned_session_path()
    if not str(session_id or "").strip():
        try:
            target.unlink(missing_ok=True)
            diag("已取消关联（回到跟随当前会话）")
            return True
        except OSError as exc:
            diag(f"取消关联失败：{exc!r}")
            return False
    payload = {
        "sessionId": str(session_id).strip(),
        "label": str(label or "").strip(),
        "pinnedAt": time.time(),
    }
    try:
        _write_json_atomic(target, payload)
        diag(f"已关联到会话 {payload['sessionId']}（{payload['label'] or '无标题'}）")
        return True
    except Exception as exc:  # noqa: BLE001
        diag(f"关联失败：{type(exc).__name__}: {exc}")
        return False


def list_sessions(limit: int = 12) -> list[dict]:
    """列出 DSH 里的可选会话（供桌宠"关联对话"菜单使用）。

    数据来源：`~/.dsh/storages/session_projcache/sessions/*.json`——这是 DSH 自己
    维护的会话索引（明文 JSON），比逐个解压 `session.v4.jsonl.zstd` 便宜得多。
    标题取**首轮 prompt 的前若干字**（DSH 的会话名也在别处，但索引里没有；
    首轮内容对用户辨认最直观），时间取 `lastPromptAt`（最近活动）优先、否则创建时间。
    """
    dsh_home = _dsh_home()
    cache_dir = dsh_home / "storages" / "session_projcache" / "sessions"
    rows: list[dict] = []
    try:
        candidates = sorted(cache_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return rows
    for path in candidates:
        if len(rows) >= limit:
            break
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        record = (data or {}).get("record") or {}
        identity = record.get("identity") or {}
        rows_map = record.get("rows") or {}
        meta = rows_map.get("sessionListMetadata") or {}
        meta_val = meta.get("val") if isinstance(meta, dict) else meta
        turns = ((rows_map.get("turnOutline") or {}).get("val") or {}).get("turns") or []
        title = ""
        for turn in turns:
            candidate = str((turn or {}).get("prompt") or "").strip()
            if candidate:
                title = candidate
                break
        last_at = (meta_val or {}).get("lastPromptAt") if isinstance(meta_val, dict) else None
        created = identity.get("createdAt")
        stamp = last_at or created
        when = ""
        if isinstance(stamp, (int, float)) and stamp > 0:
            when = time.strftime("%m-%d %H:%M", time.localtime(stamp / 1000.0))
        rows.append(
            {
                "sessionId": str(identity.get("sessionId") or path.stem),
                "title": title[:60],
                "when": when,
                "cwd": str(identity.get("cwd") or ""),
                "turns": len(turns),
            }
        )
    return rows


def resolve_session_id(explicit: str = "") -> str:
    """解析要投递到哪个 DSH 会话。

    优先级：
      1. 显式传入；
      2. **桌宠已关联的会话**（用户在桌宠里选定，见 read_pinned_session）——
         放在最前是为了"不影响其他工作"：关联后无论用户在哪只会话里干活，
         桌宠的消息都只进它关联的那一只；
      3. 桥接事件里的当前活跃会话（未关联时的默认行为）；
      4. pet-integration.json 的 sessionId（稳定但可能陈旧）。
    都拿不到就返回空串，由插件侧报 session-not-live（比瞎猜一个会话安全）。
    """
    explicit = str(explicit or "").strip()
    if explicit:
        return explicit
    pinned = read_pinned_session()
    if pinned:
        return pinned
    live = live_session_id_from_bridge()
    if live:
        return live
    return str(read_integration().get("sessionId") or "").strip()


def request_open_session(session_id: str = "") -> bool:
    """请求 DSH 前台打开目标会话（桌宠"去 DSH"按钮的落点）。

    协议端在 DSH 侧 `pet-ui.js`：它轮询桥接目录里的 `open-session-<id>.json`，
    认领后把请求转成 settings 写入，客户端半据此 `uiWorkspace.openSession`。
    桌面版 DSH **没有对外入口**（无 deep link、无监听端口、second-instance 丢 argv），
    桥接目录是外部进程唯一能跟它说话的通道，所以只能这样"请求"而不能直接调。

    返回是否成功投出请求（拿不到会话 id 时为 False）。
    """
    target = resolve_session_id(session_id)
    if not target:
        diag("request_open_session: 拿不到会话 id，放弃")
        return False
    path = bridge_dir() / f"open-session-{uuid.uuid4().hex}.json"
    try:
        _write_json_atomic(path, {"id": uuid.uuid4().hex, "sessionId": target})
        diag(f"request_open_session: 已投出 -> {path.name} target={target}")
        return True
    except Exception as exc:  # noqa: BLE001
        diag(f"request_open_session 失败：{type(exc).__name__}: {exc}")
        return False


def pet_data_dir() -> Path:
    """桌宠自己的数据目录（写请求就落在这里）。

    目录名与 `pet/config.py` 的 `APP_DIR_NAME` 一致（变体 webm-chat）。
    本机实测：这个目录**稳定可写**（诊断日志一直写在这里），
    而桥接目录只能读、写会 PermissionError(13)。
    """
    appdata = os.environ.get("APPDATA") or str(Path.home())
    return Path(appdata) / "dsh-pet-standalone-webm-chat"


#: 兼容旧名（内部暂存也曾用这个名字）
_staging_dir = pet_data_dir


def request_dir() -> Path:
    """聊天请求文件的落盘目录 = 桌宠自己的数据目录。

    为什么不写桥接目录（协议原本的位置）：实测桌宠进程写桥接目录会
    `PermissionError(13)`，甚至 `tempfile.mkstemp(dir=桥接目录)` 会**静默挂死**。
    因此把"桌宠写、插件读"这一半换到桌宠可写处；
    DSH 侧插件已改为**同时认领**两个目录（bridgeDir + 本目录），
    其余方向不变：chat-stream / chat-cancel 仍由插件写在桥接目录、桌宠读取。
    """
    return pet_data_dir()


def _pending_image_path() -> Path:
    """待发截图的落盘位置（见 DshSessionProvider.stage_image 的说明）。"""
    return pet_data_dir() / ".pending-chat-image.jpg"


def _write_json_atomic(path: Path, payload: dict) -> None:
    """原子写出：暂存文件 + os.replace，全程带诊断。

    先前"卡在写文件"时只能看到"没有下一条日志"，分不清是 mkstemp、write 还是
    replace 挂住。现在每一步都留痕；并且**不再使用 tempfile.mkstemp**（它会挂死），
    改用可预测文件名的暂存 + 同卷改名。
    """
    text = json.dumps(payload, ensure_ascii=False)
    diag(f"  [_write] 开始 target={path} 字节={len(text)}")

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        staging = path.parent / f".chatreq-{os.getpid()}-{threading.get_ident()}.tmp"
        diag(f"  [_write] 写暂存 {staging.name}")
        with open(staging, "w", encoding="utf-8") as fh:
            fh.write(text)
        diag("  [_write] 暂存完成，准备 os.replace")
        os.replace(staging, path)
        diag("  [_write] os.replace 完成（原子）")
        return
    except OSError as exc:
        diag(f"  [_write] 暂存+改名失败 {exc!r}，尝试直写")

    try:
        diag("  [_write] 直写目标 ...")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        diag("  [_write] 直写成功")
    except OSError as exc:
        diag(f"  [_write] 直写也失败 {exc!r}")
        raise DshSessionError(f"写不出聊天请求文件：{path}（{exc.strerror}）") from exc


def _image_field(image_bytes: bytes, media_type: str = "image/png") -> dict:
    """把图片编码成插件要求的 image 字段，并做尺寸前置校验。"""
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise DshSessionError(
            f"图片过大：{len(image_bytes)} 字节，上限 {MAX_IMAGE_BYTES}（插件会拒绝）"
        )
    if not image_bytes:
        raise DshSessionError("图片为空")
    return {"mediaType": media_type, "data": base64.b64encode(image_bytes).decode("ascii")}


class DshSessionProvider:
    """把一次提问投进 DSH 会话，并把流式回复按增量产出。

    与 `OpenAICompatibleProvider` 的接口保持一致：
        stream(messages, config, cancel_event, response_holder=None) -> Iterator[str]
    因此它可以直接替换进现有的 `ChatService`。
    """

    def __init__(self, session_id: str = "") -> None:
        self.session_id = str(session_id or "")
        self._request_ids: list[str] = []
        #: 由 stage_image() 挂载、下一次 stream() 消费
        self._pending_image: tuple[bytes, str] | None = None
        diag(f"DshSessionProvider 实例创建 id={id(self):#x} session={self.session_id!r}")

    # ---- 对外主入口 ----
    def stream(
        self,
        messages: list[dict[str, Any]],
        config: Any,
        cancel_event: threading.Event,
        response_holder: list | None = None,
        *,
        image: bytes | None = None,
        image_media_type: str = "image/png",
        deadline_seconds: float = DEFAULT_DEADLINE_SECONDS,
    ) -> Iterator[str]:
        self._request_ids = []
        # 取图顺序：**消息自带**优先（最可靠——它是本次调用的参数，
        # 随 `_Worker.run()` 一起进来，没有第二个写入方能碰它），
        # 其次才是实例/落盘挂载（保留兼容，供不经气泡的调用点使用）。
        if image is None:
            from_message = _image_from_messages(messages)
            if from_message is not None:
                image, image_media_type = from_message
                diag(f"取用消息自带图片 media={image_media_type} 字节={len(image)}")
        if image is None:
            diag(f"stream 取图前: 实例={id(self):#x} has_pending={self.has_pending_image()}")
            staged = self._consume_pending_image()
            if staged is not None:
                image, image_media_type = staged
                diag(f"取用挂载图片 media={image_media_type} 字节={len(image)}")
        diag(f"stream 开始 messages={len(messages or [])} image={image is not None} 显式session={self.session_id!r}")
        session_id = resolve_session_id(self.session_id)
        diag(f"解析会话 -> {session_id!r}")
        if not session_id:
            raise DshSessionError(
                "拿不到 DSH 会话 id：pet-integration.json 里没有 sessionId。"
                "请在 DSH 里打开桌宠联动（跟随当前会话）后再试。"
            )

        text = _last_user_text(messages)
        persona = _system_prompt(messages)
        diag(f"文本长度={len(text)} persona长度={len(persona)}")
        if not text.strip() and image is None:
            raise DshSessionError("没有可发送的内容（既无文本也没有图片）")

        upload_handle = ""
        if image is not None:
            upload_handle = self._attach(session_id, image, image_media_type, cancel_event, deadline_seconds)
            if not text.strip():
                # 只发图没打字：**必须**补一句默认提问。
                # 只 attach 不 ask 的话，会话收到了图却没有要求，回出来是空的
                # （实测症状："模型未返回任何内容"）。
                # 这句话是给 DSH 的指令、不是给人设的台词，所以直白说明意图。
                text = (
                    "（主人框选了一块屏幕给我看，但没留言。）"
                    "请看看这张图，用你的人设口吻回应一两句就好——"
                    "关心、吐槽、好奇都可以，主要根据画面里正在发生的事情来说。"
                )
                diag("只发图未留言：已补默认提问")
        diag("进入 _ask ...")
        yield from self._ask(session_id, text, persona, upload_handle, cancel_event, deadline_seconds)

    def cancel(self) -> None:
        """通知插件取消所有在飞请求（用于 ChatService.stop 的 response_holder 钩子）。"""
        for request_id in list(self._request_ids):
            try:
                _write_json_atomic(bridge_dir() / f"chat-cancel-{request_id}.json", {"id": request_id})
            except OSError:
                pass
        self._request_ids = []

    # ---- 待发送图片（框选截图用） ----
    #
    # 存储放在模块级、以"实例指纹 + 弱引用"为键，而不是实例属性。
    # 原因：实测出现过「stage_image 写入后 21ms、同一个实例上读就没了」，
    # 而查遍 ChatService/_Worker 都没有清空它的代码——实例属性可能有我们
    # 没看到的写入方。模块级字典没有这个不确定性；弱引用保证实例回收时
    # 条目自动消失，不会积累内存。
    def stage_image(self, data: bytes, media_type: str = "image/jpeg") -> None:
        """把一张图挂到下一次 `stream()` 上。

        `ChatService` 只会向 `provider.stream` 透传 `response_holder` 这类
        它自己探到的参数，所以图片走"预先挂载"这条路，不必改动
        `chat/service.py`。

        **落盘优先**：内存挂载在这台机器上出现过"写入成功、20ms 后同一实例
        读不到"的怪象（实例属性与模块级字典都复现过），而文件 I/O 一路稳定
        （聊天请求的原子写从未失败过）。因此同时写一份到桌宠自己的数据目录，
        `stream()` 时优先读文件——跨调用传状态，文件比内存可靠。
        """
        _PENDING_IMAGES[id(self)] = (weakref.ref(self), (bytes(data), str(media_type or "image/jpeg")))
        written = False
        try:
            _pending_image_path().write_bytes(bytes(data))
            written = True
        except OSError as exc:
            diag(f"stage_image: 落盘失败 {exc!r}（仍有内存副本）")
        diag(
            f"stage_image: {len(data)} 字节 media={media_type} 实例={id(self):#x} "
            f"内存={self.has_pending_image()} 落盘={written}"
        )

    def _pending(self) -> tuple[bytes, str] | None:
        entry = _PENDING_IMAGES.get(id(self))
        if entry is None or entry[0]() is not self:
            return None
        return entry[1]

    def _pending_from_disk(self) -> tuple[bytes, str] | None:
        """读走落盘的待发图片（读后即删，保证一张图只跟一条消息）。"""
        path = _pending_image_path()
        try:
            if not path.exists():
                return None
            data = path.read_bytes()
            media = "image/jpeg"
            meta = path.with_suffix(".meta")
            if meta.exists():
                media = meta.read_text(encoding="utf-8").strip() or media
            if not data:
                return None
            diag(f"_pending_from_disk: 取到 {len(data)} 字节 media={media}（保留文件）")
            return (data, media)
        except OSError as exc:
            diag(f"_pending_from_disk 失败：{exc!r}")
            return None

    def has_pending_image(self) -> bool:
        if self._pending() is not None:
            return True
        if getattr(self, "_pending_image", None) is not None:
            return True
        try:
            return _pending_image_path().exists()
        except OSError:
            return False

    def clear_pending_image(self) -> None:
        _PENDING_IMAGES.pop(id(self), None)
        self._pending_image = None
        try:
            path = _pending_image_path()
            path.unlink(missing_ok=True)
            path.with_suffix(".meta").unlink(missing_ok=True)
        except OSError:
            pass

    def _consume_pending_image(self) -> tuple[bytes, str] | None:
        """取用一次即清空（图片只跟一条消息走）。落盘的那份优先。"""
        staged = self._pending() or getattr(self, "_pending_image", None)
        _PENDING_IMAGES.pop(id(self), None)
        self._pending_image = None
        if staged is None:
            # 内存里没有（可能被别的路径取走过）：改读落盘副本。
            # 落盘那份**不在这里删**，见 _pending_from_disk 的说明。
            staged = self._pending_from_disk()
        return staged

    # ---- 内部：attach / ask ----
    def _attach(
        self,
        session_id: str,
        image: bytes,
        media_type: str,
        cancel_event: threading.Event,
        deadline_seconds: float,
    ) -> str:
        request_id = uuid.uuid4().hex
        self._request_ids.append(request_id)
        payload = {
            "id": request_id,
            "sessionId": session_id,
            "operation": "attach",
            "image": _image_field(image, media_type),
        }
        self._dispatch(payload)

        handle = ""
        for record in self._tail(request_id, cancel_event, deadline_seconds):
            kind = str(record.get("kind") or "")
            if kind == "accepted":
                handle = str(record.get("handle") or "")
            elif kind == "done":
                return handle or str(record.get("handle") or "")
            elif kind == "error":
                # 收编失败时插件会丢掉这张图继续投递；这里也不让整轮失败
                return ""
        return handle

    def _ask(
        self,
        session_id: str,
        text: str,
        persona: str,
        upload_handle: str,
        cancel_event: threading.Event,
        deadline_seconds: float,
    ) -> Iterator[str]:
        request_id = uuid.uuid4().hex
        self._request_ids.append(request_id)
        payload: dict[str, Any] = {
            "id": request_id,
            "sessionId": session_id,
            "text": text[:MAX_TEXT],
        }
        if persona:
            payload["persona"] = persona[:MAX_PERSONA]
        if upload_handle:
            payload["uploadHandle"] = upload_handle
        self._dispatch(payload)

        emitted = 0
        for record in self._tail(request_id, cancel_event, deadline_seconds):
            kind = str(record.get("kind") or "")
            if kind == "delta":
                chunk = str(record.get("text") or "")
                if chunk:
                    emitted += len(chunk)
                    yield chunk
            elif kind == "done":
                if emitted == 0:
                    reason = str(record.get("reason") or "")
                    raise DshSessionError(f"DSH 会话没有返回任何内容（reason={reason or 'done'}）")
                return
            elif kind == "error":
                raise DshSessionError(
                    f"DSH 会话报错：{record.get('error') or '未知'}"
                    + (f"（{record.get('detail')}）" if record.get("detail") else "")
                )

    def _dispatch(self, payload: dict) -> None:
        request_id = str(payload["id"])
        # 落在**桌宠可写**的目录（request_dir()），不是桥接目录：
        # 实测桌宠写桥接目录会 PermissionError(13)；DSH 侧插件已改为两处都认领。
        target = request_dir() / f"chat-request-{request_id}.json"
        diag(f"_dispatch 写出请求 -> {target}")
        try:
            _write_json_atomic(target, payload)
        except BaseException as exc:  # noqa: BLE001
            diag(f"_dispatch 写失败：{type(exc).__name__}: {exc}")
            raise
        diag("_dispatch 完成")

    def _tail(
        self,
        request_id: str,
        cancel_event: threading.Event,
        deadline_seconds: float,
    ) -> Iterator[dict]:
        """增量读 chat-stream-<id>.jsonl，逐行解析为记录。

        只读完整行（以 \\n 结尾）——插件是同步 append 单行，但读取端仍按半行防御，
        否则可能读到写了一半的 JSON。
        """
        path = bridge_dir() / f"chat-stream-{request_id}.jsonl"
        started = time.monotonic()
        offset = 0
        buffer = ""
        diag(f"_tail 开始等待 -> {path.name}（deadline={deadline_seconds:.0f}s）")
        last_tick = started
        while True:
            if cancel_event is not None and cancel_event.is_set():
                diag("_tail 收到取消")
                self.cancel()
                return
            if time.monotonic() - started > deadline_seconds:
                diag("_tail 超时退出")
                raise DshSessionError(f"等待 DSH 会话超时（{deadline_seconds:.0f}s）")
            # 每 10 秒记一次心跳，便于区分"卡在等待"与"根本没进循环"
            if time.monotonic() - last_tick > 10:
                last_tick = time.monotonic()
                diag(f"_tail 心跳：已等 {time.monotonic()-started:.0f}s，流文件存在={path.exists()}")
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as fh:
                    fh.seek(offset)
                    chunk = fh.read()
                    offset = fh.tell()
            except FileNotFoundError:
                chunk = ""
            except OSError:
                chunk = ""
            if chunk:
                buffer += chunk
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                    except ValueError:
                        continue  # 忽略坏行，不中断整轮
                    if isinstance(record, dict):
                        yield record
                        if str(record.get("kind") or "") in ("done", "error"):
                            return
            time.sleep(POLL_SECONDS)


# ---- 消息列表 -> 请求字段 ----
def _image_from_messages(messages: list[dict[str, Any]]) -> tuple[bytes, str] | None:
    """从消息列表里取随消息携带的图片（键 `_dsh_image`，由气泡挂上）。

    图跟着**消息**走而不是跟着 provider 实例走：messages 是本次调用的参数，
    随 `_Worker.run()` 一起进入 provider，不存在被别处清理的窗口。
    实测实例属性/全局字典/落盘三种"挂载"都会在发送流程里丢失，故以此为主路径。
    """
    for message in reversed(messages or []):
        payload = message.get("_dsh_image") if isinstance(message, dict) else None
        if not isinstance(payload, dict):
            continue
        data = payload.get("data")
        if not isinstance(data, (bytes, bytearray)) or not data:
            continue
        media_type = str(payload.get("mediaType") or "image/jpeg")
        return (bytes(data), media_type)
    return None


def _last_user_text(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages or []):
        if str(message.get("role") or "") == "user":
            return _content_to_text(message.get("content"))
    return ""


def _system_prompt(messages: list[dict[str, Any]]) -> str:
    for message in messages or []:
        if str(message.get("role") or "") == "system":
            return _content_to_text(message.get("content"))
    return ""


def _content_to_text(content: Any) -> str:
    """兼容 str 与 OpenAI 的 content 数组两种形态。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text") or ""))
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(p for p in parts if p)
    return ""


# ---- 给现有代码用的解析入口 ----
def is_dsh_endpoint(config: Any) -> bool:
    """判断该 provider 配置是否指向 DSH 会话（base_url 以 dsh:// 开头）。"""
    base = str(getattr(config, "base_url", "") or "")
    return base.strip().lower().startswith("dsh://")


def resolve_chat_provider(settings: Any):
    """按当前选中的 provider 决定用哪个实现。

    这是把桌宠接到 DSH 的唯一开关：`active_provider` 指向 dsh:// 时返回
    `DshSessionProvider`，否则维持原来的 OpenAI 兼容实现（行为不变）。
    """
    from .providers import OpenAICompatibleProvider  # 延迟导入，避免循环依赖

    try:
        active = str(getattr(settings, "active_provider", "") or "")
        config = settings.providers.get(active) if hasattr(settings, "providers") else None
    except Exception:  # noqa: BLE001 - 配置形态异常时安全回退
        return OpenAICompatibleProvider()
    if config is not None and is_dsh_endpoint(config):
        return DshSessionProvider()
    return OpenAICompatibleProvider()


def ask_about_screen_via_dsh(
    jpeg_bytes: bytes,
    app_info: str,
    system_prompt: str,
    session_id: str = "",
    prompt_suffix: str = "",
    deadline_seconds: float = DEFAULT_DEADLINE_SECONDS,
) -> str:
    """识屏的 DSH 版本：框选/整屏截图直接投进 DSH 会话，返回完整回复文本。

    对应 `vision.ask_about_screen` 的返回语义（非流式，返回最终文本）。
    """
    user_text = (
        f"（参考元数据：主人当前前台应用为 {app_info or '未知'}）\n"
        "这是主人当前的屏幕截图。用你的人设口吻回应一两句就好"
        "（关心、吐槽、好奇都可以）。请主要根据画面里正在发生的事来回应；"
        "窗口标题只是参考，不要逐字念出。"
    )
    if prompt_suffix:
        user_text += "\n" + prompt_suffix
    provider = DshSessionProvider(session_id)
    cancel = threading.Event()
    parts: list[str] = []
    messages = [
        {"role": "system", "content": system_prompt or ""},
        {"role": "user", "content": user_text},
    ]
    for chunk in provider.stream(
        messages,
        config=None,
        cancel_event=cancel,
        image=jpeg_bytes,
        image_media_type="image/jpeg",
        deadline_seconds=deadline_seconds,
    ):
        parts.append(chunk)
    return "".join(parts)
