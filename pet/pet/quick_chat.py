# -*- coding: utf-8 -*-
"""快速对话气泡（Quick Chat）。

点击桌宠弹出的头顶小气泡输入框；回车发送，AI 回复在气泡内流式显示，
与完整 AI 对话窗口共用同一会话历史（SessionStore / ChatService）。
"""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QBuffer, QByteArray, QEvent, QPoint, QPointF, QRectF, QTimer, Qt
from PySide6.QtGui import QColor, QGuiApplication, QImage, QPainter, QPainterPath, QPen, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMenu,
    QPushButton,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from .speech_bubble import BUBBLE_STYLE_PRESETS
from .speech_bubble_text import truncate_bubble_text

from .chat.models import ChatMessage
from .chat.prompt import PromptBuilder
from .chat.service import ChatService
from .chat.session_store import SessionStore
# 按 active_provider 选实现：base_url 是 dsh:// 时走 DSH 会话，否则维持原 OpenAI 路径
from .chat.dsh_provider import resolve_chat_provider
# 框选截图：覆盖层自带冻结底图（见 pet/screen_region.py）
from .screen_region import ScreenRegionSelector


def _region_diag(msg: str) -> None:
    """转发给覆盖层的诊断日志；取不到就静默（诊断不能影响交互）。"""
    try:
        from .screen_region import _diag

        _diag(msg)
    except Exception:  # noqa: BLE001
        pass

_PAGE_SIZE = 500
#: 回复气泡停留时长：够读完一段回答（桌宠气泡按字数自适应，这里给足）。
_REPLY_BUBBLE_DWELL_MS = 20000
#: 框选看门狗：覆盖层迟迟不发信号（被系统关掉 / 事件丢失）时强制收尾，
#: 否则气泡与桌宠会一直停在隐藏态（实测过"框选后桌宠消失"）。
_CAPTURE_WATCHDOG_MS = 60_000

# 气泡内 AI 回答的展示上限：超长回答不进气泡（头顶气泡只有几百像素），
# 截断到 _REPLY_PREVIEW_LIMIT 字并提示全文在聊天窗（气泡内提供直达按钮）。
_REPLY_PREVIEW_LIMIT = 150
_REPLY_PREVIEW_SUFFIX = "…（全文见聊天窗）"


def _surface_radius(preset: dict) -> float:
    """气泡主体圆角。

    breath_bubble 是有机水滴形（speech_bubble 专属几何，preset 里 radius=0）：
    quick_chat 不支持该形状，按 0 渲染会变直角方框——同一
    self_talk_bubble_style 设置在桌宠气泡与快速对话两套观感。这里用大圆角
    近似，与 speech_bubble 同设置不破解；普通预设用自己的 radius。
    """
    if preset.get("shape") == "breath_bubble":
        return 22.0
    return float(preset.get("radius", 14))


class QuickChatBubble(QFrame):
    def __init__(self, config, pet_window=None, parent=None):
        super().__init__(parent)
        self.config = config
        self.pet_window = pet_window
        self.setObjectName("quick-chat-bubble")
        flags = (
            Qt.WindowType.Tool
            | Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
        )
        self.setWindowFlags(flags)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self._capture_compat = False
        self._capture_host: QWidget | None = None
        self.setMinimumWidth(320)
        self.setMaximumWidth(460)

        style_id = str(config.get("self_talk_bubble_style", "classic_top") or "classic_top")
        self._preset = BUBBLE_STYLE_PRESETS.get(style_id, BUBBLE_STYLE_PRESETS["classic_top"])
        self._tail_up = False

        self.character_id = str(config.get("character", "shenshen"))
        self.settings = config.chat_settings()
        self.prompt_builder = PromptBuilder(Path(__file__).resolve().parent.parent / "assets" / "characters")
        self.store = SessionStore(config.dir, getattr(config, "instance_id", ""))
        self.session = self._get_session()
        # provider 由 active_provider 决定：指向 dsh:// 时用 DSH 会话（同一个脑子），
        # 否则与原来完全一致（OpenAI 兼容实现）。
        self.service = ChatService(provider=resolve_chat_provider(self.settings), parent=self)
        self._active_request_id: str | None = None
        self._reply_full = ""       # AI 回答全文（会话历史/聊天窗用，不截断）
        self._reply_text = ""       # 气泡内展示文本（超上限截断 + 提示看聊天窗）
        self._reply_truncated = False
        self._page = 0
        self._pages: list[str] = []
        self._deactivate_check_pending = False

        self._build()
        self._connect()

    def _build(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 12, 14, 12)
        layout.setSpacing(8)

        header = QHBoxLayout()
        title = QLabel("快速对话")
        title.setObjectName("quick-chat-title")
        self.title_label = title  # 子类（灵动岛气泡）改标题用
        header.addWidget(title)
        header.addStretch(1)
        self.hint_label = QLabel("")
        self.hint_label.setObjectName("quick-chat-hint")
        header.addWidget(self.hint_label)
        self.close_btn = QPushButton("×")
        self.close_btn.setObjectName("quick-chat-close")
        self.close_btn.setFixedSize(24, 24)
        header.addWidget(self.close_btn)
        layout.addLayout(header)

        self.output = QLabel("")
        self.output.setObjectName("quick-chat-output")
        self.output.setWordWrap(True)
        self.output.setMinimumHeight(60)
        self.output.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        self.output_scroll = QScrollArea()
        self.output_scroll.setObjectName("quick-chat-output-scroll")
        self.output_scroll.setWidgetResizable(True)
        self.output_scroll.setFrameShape(QFrame.Shape.NoFrame)
        self.output_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.output_scroll.setMinimumHeight(60)
        self.output_scroll.setMaximumHeight(220)
        self.output_scroll.setWidget(self.output)
        layout.addWidget(self.output_scroll)

        self.page_widget = QWidget()
        self.page_row = QHBoxLayout(self.page_widget)
        self.page_row.setContentsMargins(0, 0, 0, 0)
        self.prev_btn = QPushButton("←")
        self.page_label = QLabel("")
        self.next_btn = QPushButton("→")
        for btn in (self.prev_btn, self.next_btn):
            btn.setObjectName("quick-chat-page")
            btn.setFixedSize(28, 24)
        self.open_chat_btn = QPushButton("去聊天窗")
        self.open_chat_btn.setObjectName("quick-chat-open")
        self.page_row.addWidget(self.prev_btn)
        self.page_row.addWidget(self.page_label)
        self.page_row.addWidget(self.next_btn)
        self.page_row.addStretch(1)
        self.page_row.addWidget(self.open_chat_btn)
        layout.addWidget(self.page_widget)
        self.page_widget.setVisible(False)

        input_row = QHBoxLayout()
        self.input = QLineEdit()
        self.input.setPlaceholderText("输入消息，回车发送…")
        # 框选截图：框完把图挂在 provider 上，随下一条消息一起发给 DSH
        self.capture_btn = QPushButton("截图")
        self.capture_btn.setObjectName("quick-chat-capture")
        self.capture_btn.setToolTip("框选屏幕区域，随消息一起发给 DSH")
        self.capture_btn.clicked.connect(self.capture_region)
        # 关联对话：选定之后桌宠的消息**只走这一只会话**，不再插进用户正在干活的对话
        self.link_btn = QPushButton("关联")
        self.link_btn.setObjectName("quick-chat-link")
        self.link_btn.setToolTip("选择桌宠专属/指定的 DSH 会话；关联后桌宠消息只进那只会话")
        self.link_btn.clicked.connect(self._show_session_menu)
        self.send_btn = QPushButton("发送")
        self.send_btn.setObjectName("quick-chat-send")
        self._pending_image: bytes | None = None
        #: 框选进行中标记：看门狗与 destroyed 回调靠它做幂等收尾
        self._capture_in_flight = False
        self._selector = None
        input_row.addWidget(self.input, 1)
        input_row.addWidget(self.capture_btn)
        input_row.addWidget(self.link_btn)
        input_row.addWidget(self.send_btn)
        layout.addLayout(input_row)

        # 关联状态提示行（未关联时不占位）
        self._link_note = QLabel("")
        self._link_note.setObjectName("quick-chat-link-note")
        self._link_note.setWordWrap(True)
        layout.addWidget(self._link_note)
        self._link_note.setVisible(False)
        self._refresh_link_note()

        # 待发送图片预览：不占视觉重量，随时可撤
        self._preview_row = QWidget()
        preview_row = QHBoxLayout(self._preview_row)
        preview_row.setContentsMargins(0, 0, 0, 0)
        self._preview_thumb = QLabel("")
        self._preview_thumb.setObjectName("quick-chat-preview-thumb")
        self._preview_thumb.setFixedSize(120, 68)
        self._preview_thumb.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._preview_thumb.setScaledContents(False)
        self._preview_note = QLabel("")
        self._preview_note.setObjectName("quick-chat-preview-note")
        self._preview_clear = QPushButton("×")
        self._preview_clear.setObjectName("quick-chat-preview-clear")
        self._preview_clear.setFixedSize(22, 22)
        self._preview_clear.setToolTip("移除截图")
        self._preview_clear.clicked.connect(self.clear_pending_image)
        preview_row.addWidget(self._preview_thumb)
        preview_row.addWidget(self._preview_note, 1)
        preview_row.addWidget(self._preview_clear)
        layout.addWidget(self._preview_row)
        self._preview_row.setVisible(False)

        bg = self._preset["background"]
        fg = self._preset["foreground"]
        border = self._preset["border"]
        self.setStyleSheet(f"""
            QLabel#quick-chat-title, QLabel#quick-chat-hint, QLabel#quick-chat-output,
            QLabel#quick-chat-page {{ background: transparent; color: {fg}; border: none; }}
            QLabel#quick-chat-preview-note {{
                background: transparent; color: {fg}; border: none; font-size: 11px;
            }}
            QLabel#quick-chat-preview-thumb {{
                background: {bg}; border: 1px solid {border}; border-radius: 6px;
            }}
            QScrollArea#quick-chat-output-scroll {{ background: transparent; border: none; }}
            QPushButton {{
                background: {border}; color: {fg}; border: none; border-radius: 8px;
                padding: 3px 8px;
            }}
            QPushButton:hover {{ background: {fg}; color: {bg}; }}
            QPushButton#quick-chat-preview-clear {{
                background: transparent; color: {fg}; border: none; padding: 0;
                font-size: 14px;
            }}
            QPushButton#quick-chat-preview-clear:hover {{ background: {fg}; color: {bg}; }}
            QLineEdit {{
                background: {bg}; color: {fg}; border: 1px solid {border};
                border-radius: 8px; padding: 5px 8px;
            }}
        """)

    def _connect(self) -> None:
        self.close_btn.clicked.connect(self.close)
        self.send_btn.clicked.connect(self._send)
        self.input.returnPressed.connect(self._send)
        self.prev_btn.clicked.connect(lambda: self._show_page(self._page - 1))
        self.next_btn.clicked.connect(lambda: self._show_page(self._page + 1))
        self.open_chat_btn.clicked.connect(self._open_full_chat)
        self.service.started.connect(self._started)
        self.service.delta.connect(self._delta)
        self.service.finished.connect(self._finished)
        self.service.error.connect(self._error)
        self.service.stopped.connect(self._stopped)

    # ------------------------------------------------------------ 绘制
    def paintEvent(self, event) -> None:  # noqa: N802
        del event
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        rect = QRectF(self.rect()).adjusted(6, 8, -6, -8)
        radius = _surface_radius(self._preset)
        body = QPainterPath()
        body.addRoundedRect(rect, radius, radius)
        tail = QPainterPath()
        tip_x = rect.center().x()
        if self._tail_up:
            tip = QPointF(tip_x, rect.top() - 6)
            tail.moveTo(QPointF(tip_x - 8, rect.top() + 2))
            tail.lineTo(tip)
            tail.lineTo(QPointF(tip_x + 8, rect.top() + 2))
        else:
            tip = QPointF(tip_x, rect.bottom() + 6)
            tail.moveTo(QPointF(tip_x - 8, rect.bottom() - 2))
            tail.lineTo(tip)
            tail.lineTo(QPointF(tip_x + 8, rect.bottom() - 2))
        tail.closeSubpath()
        surface = body.united(tail).simplified()

        # 柔和阴影
        shadow = QPainterPath(surface)
        shadow.translate(0, 2)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(self._preset.get("shadow", "#6b542b")))
        painter.drawPath(shadow)

        # 气泡主体
        painter.setBrush(QColor(self._preset["background"]))
        painter.setPen(QPen(QColor(self._preset["border"]), 1))
        painter.drawPath(surface)
        painter.end()

    # ------------------------------------------------------------ 会话
    def _get_session(self):
        sessions = self.store.list(self.character_id)
        return sessions[0] if sessions else self._new_session()

    def refresh_session(self) -> None:
        """从磁盘重取最近会话（公开 seam；角色切换后外部刷新用，替代私访 _get_session）。"""
        self.session = self._get_session()

    def _new_session(self):
        session = self.store.create(
            self.character_id,
            self.settings.active_provider,
            self.prompt_builder.effective_system_prompt(self.settings, self.character_id),
        )
        self.store.save(session)
        return session

    def position_near_pet(self) -> None:
        pet = self.pet_window
        if pet is None or not hasattr(pet, "visible_content_rect"):
            return
        anchor = pet.visible_content_rect()
        host = self._capture_host if self._capture_compat else None
        if host is not None and not host.geometry().isEmpty():
            available = host.geometry()
        else:
            screen = QGuiApplication.screenAt(anchor.center())
            available = screen.availableGeometry() if screen else QGuiApplication.primaryScreen().availableGeometry()
        self.adjustSize()
        w = self.width()
        h = self.height()
        # 位置统一向排布器申请：它知道同一泳道里还有哪些气泡在显示，
        # 会给出互不重叠的坐标（详见 pet/bubble_layout.py）。
        # 拿不到排布器时退回本方法内的兜底算法。
        lane = "below"
        prefer = "down"
        try:
            from .bubble_layout import shared_layout

            pos = shared_layout().acquire("quick-chat", lane, self.size(), anchor, available, prefer=prefer)
            x, y = pos.x(), pos.y()
            # 尾巴朝向由实际落点决定：在桌宠下方则朝上，在上方则朝下
            self._tail_up = y >= anchor.top()
        except Exception:  # noqa: BLE001 - 排布失败不能导致气泡不显示
            x = anchor.center().x() - w // 2
            y = anchor.bottom() + 8
            self._tail_up = True
            if y + h > available.bottom():
                y = anchor.top() - h - 8
                self._tail_up = False
            if y < available.top():
                y = available.top() + 4
        x = max(available.left() + 4, min(x, available.right() - w - 4))
        if host is not None:
            # 直播捕获子模式下只允许落在主窗矩形内；空间不足时夹到窗内，
            # 避免子控件被主窗边界裁掉。
            if h <= available.height():
                y = max(available.top() + 4, min(y, available.bottom() - h - 4))
            else:
                y = available.top() + 4
            self.move(host.mapFromGlobal(QPoint(x, y)))
        else:
            self.move(x, y)
        self.update()

    def set_capture_compat(self, on: bool, host: QWidget | None = None) -> None:
        """直播捕获兼容：把快速对话气泡作为桌宠主窗的子内容渲染（issue #62）。

        开启后快速对话不再是独立 Tool 窗口，而成为主窗子控件，捕获主窗时即可
        看到并操作它；关闭后恢复独立置顶 Tool 窗口形态。
        """
        on = bool(on)
        if on == self._capture_compat:
            return
        if on and host is None:
            return
        was_visible = self.isVisible()
        self._capture_compat = on
        self._capture_host = host if on else None
        if on:
            self.setWindowFlags(Qt.WindowType.Widget)
            self.setParent(host)
        else:
            self.setParent(None)
            flags = (
                Qt.WindowType.Tool
                | Qt.WindowType.FramelessWindowHint
                | Qt.WindowType.WindowStaysOnTopHint
            )
            self.setWindowFlags(flags)
        if was_visible:
            self.position_near_pet()
            self.show()
            if not on:
                self.raise_()
                self.activateWindow()
                self.input.setFocus()
        else:
            # 子模式重挂主窗后不能随父窗显示而自动弹出空白窗。
            self.hide()

    def show_for_pet(self, pet_window=None) -> None:
        if pet_window is not None:
            self.pet_window = pet_window
        self.position_near_pet()
        self.show()
        self.raise_()
        self.activateWindow()
        self.input.setFocus()

    # ------------------------------------------------------------ 关联对话
    def _refresh_link_note(self) -> None:
        """把当前关联状态显示出来；未关联时说明"跟随当前会话"。"""
        try:
            from .chat.dsh_provider import read_pinned_session, resolve_session_id

            pinned = read_pinned_session()
        except Exception:  # noqa: BLE001
            return
        if pinned:
            label = pinned
            try:
                for row in self._available_sessions():
                    if row["sessionId"] == pinned:
                        label = row["title"] or pinned
                        break
            except Exception:  # noqa: BLE001
                pass
            self._link_note.setText(f"已关联对话：{label[:36]}（桌宠消息只进这只）")
        else:
            target = ""
            try:
                target = resolve_session_id()
            except Exception:  # noqa: BLE001
                pass
            self._link_note.setText(
                f"未关联：跟随当前会话{'（' + target[:20] + '…）' if target else ''}"
                "　点「关联」可选一只专属会话"
            )
        self._link_note.setVisible(True)

    def _available_sessions(self) -> list[dict]:
        from .chat.dsh_provider import list_sessions

        return list_sessions(limit=12)

    def _show_session_menu(self) -> None:
        """弹出会话选择菜单。

        菜单里做三件事：选一只已有会话关联 / 关联到"当前会话" / 取消关联。
        「取消关联」回到默认行为——跟随用户当前所在的会话。
        """
        menu = QMenu(self)
        try:
            from .chat.dsh_provider import read_pinned_session

            pinned = read_pinned_session()
        except Exception:  # noqa: BLE001
            pinned = ""

        header = menu.addAction("桌宠的对话只进选中的这一只")
        header.setEnabled(False)
        menu.addSeparator()

        rows = []
        try:
            rows = self._available_sessions()
        except Exception:  # noqa: BLE001
            rows = []
        if rows:
            for row in rows:
                title = row["title"] or "(无标题)"
                mark = "● " if row["sessionId"] == pinned else ""
                action = menu.addAction(f"{mark}{title[:28]}　{row['when']}")
                action.setData(row["sessionId"])
        else:
            empty = menu.addAction("（读不到会话列表）")
            empty.setEnabled(False)

        menu.addSeparator()
        follow = menu.addAction("取消关联（跟随当前会话）")
        follow.setData("")

        chosen = menu.exec(self.link_btn.mapToGlobal(self.link_btn.rect().bottomLeft()))
        if chosen is None:
            return
        session_id = chosen.data()
        try:
            from .chat.dsh_provider import write_pinned_session

            label = next((r["title"] for r in rows if r["sessionId"] == session_id), "")
            if write_pinned_session(str(session_id or ""), label):
                self.hint_label.setText("已关联" if session_id else "已取消关联")
            else:
                self.hint_label.setText("关联失败（看日志）")
        except Exception as exc:  # noqa: BLE001
            self.hint_label.setText(f"关联失败：{type(exc).__name__}")
        self._refresh_link_note()

    # ------------------------------------------------------------ 框选截图
    def capture_region(self) -> None:
        """框选屏幕区域，把结果挂为待发送图片。

        先隐藏气泡：覆盖层是全屏的，气泡若还开着会被一起框进去
        （覆盖层的底图冻结在它出现的那一刻）。
        """
        if self.service.busy:
            # 正在等回复时框选没有落点，直接忽略而不是抛出
            return
        self._capture_in_flight = True
        self._was_visible_before_capture = self.isVisible()
        if self._was_visible_before_capture:
            self.hide()
        QTimer.singleShot(180, self._begin_region_select)
        # 兜底：万一覆盖层既没发 selected 也没发 cancelled（被系统关掉、
        # 或事件没派发到），也必须把气泡放回来——否则桌宠/气泡会一直不显示。
        QTimer.singleShot(self._CAPTURE_WATCHDOG_MS, self._capture_watchdog)

    def _begin_region_select(self) -> None:
        # 覆盖层自己持有引用，信号回调里通过闭包取回裁切结果
        self._selector = ScreenRegionSelector()
        self._selector.selected.connect(self._on_region_selected)
        self._selector.cancelled.connect(self._on_region_cancelled)
        self._selector.destroyed.connect(self._on_selector_destroyed)
        self._selector.show()
        self._selector.raise_()
        self._selector.activateWindow()

    def _on_selector_destroyed(self, *_args) -> None:
        """覆盖层被销毁（含被系统关掉）也必须走恢复，否则界面会卡在隐藏态。"""
        self._selector = None
        self._restore_after_capture()

    def _capture_watchdog(self) -> None:
        if not getattr(self, "_capture_in_flight", False):
            return
        selector = getattr(self, "_selector", None)
        if selector is not None:
            try:
                selector.close()
            except RuntimeError:
                pass  # 底层 C++ 对象已销毁
            self._selector = None
        self.hint_label.setText("框选超时，已取消")
        self._restore_after_capture()

    def _on_region_selected(self, _rect) -> None:
        if not getattr(self, "_capture_in_flight", False):
            return  # 已被看门狗或销毁回调收尾，避免重复恢复
        # 无论编码/预览哪一步出问题，**必须**走到恢复：
        # 之前没有 try/finally，回调中途抛异常就再没人把界面放回来，
        # 表现为"框选后桌宠消失"（日志停在 selected 之后就没了）。
        try:
            pixmap = self._selector.cropped() if getattr(self, "_selector", None) else None
            self._selector = None
            _region_diag(f"selected 回调: 裁切={pixmap is not None and not pixmap.isNull()}")
            data = self._pixmap_to_jpeg(pixmap)
            _region_diag(f"selected 回调: JPEG={len(data) if data else 0} 字节")
            if data:
                self._set_pending_image(data)
            else:
                self.hint_label.setText("截图失败")
        except Exception as exc:  # noqa: BLE001 - 截图失败不该让界面消失
            _region_diag(f"selected 回调异常: {type(exc).__name__}: {exc}")
            try:
                self.hint_label.setText("截图失败")
            except RuntimeError:
                pass
        finally:
            self._restore_after_capture()

    def _on_region_cancelled(self) -> None:
        if not getattr(self, "_capture_in_flight", False):
            return
        self._selector = None
        _region_diag("cancelled 回调")
        self._restore_after_capture()

    def _restore_after_capture(self) -> None:
        """框选结束后把气泡放回来，并确保桌宠本体没有被连带隐藏。

        `destroyed` 与看门狗都可能先到，因此这里必须幂等。
        """
        self._capture_in_flight = False
        pet = self.pet_window
        # 诊断：框选后"桌宠消失"要区分三种成因——
        # 窗口被隐藏 / 被移出屏幕 / 只是被压在别的窗口下面。
        _region_diag(
            "restore: was_visible=%s pet=%s pet_visible=%s geom=%s"
            % (
                getattr(self, "_was_visible_before_capture", None),
                pet is not None,
                pet.isVisible() if pet is not None else None,
                f"{pet.x()},{pet.y()} {pet.width()}x{pet.height()}" if pet is not None else "-",
            )
        )
        if not getattr(self, "_was_visible_before_capture", True):
            return
        self._was_visible_before_capture = False
        self.show_for_pet(self.pet_window)
        # 覆盖层是全屏置顶窗，收起后桌宠可能仍被压在下面或失去可见性；
        # 显式抬一次，避免"框选后桌宠消失"。
        if pet is not None and not pet.isVisible():
            try:
                pet.show()
            except RuntimeError:
                pass
        if pet is not None:
            try:
                pet.raise_()
            except RuntimeError:
                pass

    def _pixmap_to_jpeg(self, pixmap) -> bytes | None:
        """QPixmap -> JPEG 字节，**用 PIL 而不是 Qt 的编码器**。

        为什么不用 `pixmap.save(..., "JPEG")`：本机实测它会**直接崩掉进程**
        （C++ 层崩溃，连 `finally` 都不执行，日志停在调用前一行），
        表现就是"框选后桌宠消失"。PIL 是桌宠识屏本来就在用的编码路径
        （`vision.py` 的 `ImageGrab` + JPEG 质量 70），稳定可靠。

        JPEG 而非 PNG：截图体积小得多，视觉模型无差别。
        """
        if pixmap is None or pixmap.isNull():
            return None
        image = pixmap.toImage()
        if image.isNull():
            return None
        # QImage -> 紧凑 RGB 字节；Qt 的 Format_RGB888 与 PIL 的 "RGB" 逐字节对应
        if image.format() != QImage.Format.Format_RGB888:
            image = image.convertToFormat(QImage.Format.Format_RGB888)
        width, height = image.width(), image.height()
        if width <= 0 or height <= 0:
            return None
        stride = image.bytesPerLine()
        raw = bytes(image.constBits())
        if stride != width * 3:
            # 行有填充：逐行裁剪成紧凑排布，否则 PIL 会整体错位
            raw = b"".join(raw[y * stride: y * stride + width * 3] for y in range(height))
        try:
            from io import BytesIO

            from PIL import Image  # 懒导入：与 vision.py 同口径，不常驻
        except Exception:  # noqa: BLE001 - 没有 PIL 时退回 Qt（可能崩，但不静默丢功能）
            return self._pixmap_to_jpeg_via_qt(pixmap)
        try:
            buffer = BytesIO()
            Image.frombytes("RGB", (width, height), raw).save(buffer, "JPEG", quality=88)
            return buffer.getvalue() or None
        except Exception:  # noqa: BLE001
            return None

    def _pixmap_to_jpeg_via_qt(self, pixmap) -> bytes | None:
        """兜底：Qt 自带编码器（已知在部分环境会崩，仅在无 PIL 时使用）。"""
        buffer = QBuffer(QByteArray())
        buffer.open(QBuffer.OpenModeFlag.WriteOnly)
        if not pixmap.save(buffer, "JPEG", 88):
            return None
        data = bytes(buffer.data())
        buffer.close()
        return data or None

    def _set_pending_image(self, data: bytes) -> None:
        self._pending_image = data
        _region_diag(f"set_pending_image: {len(data)} 字节（发送时会带走）")
        pixmap = QPixmap()
        if pixmap.loadFromData(data, "JPEG"):
            self._preview_thumb.setPixmap(
                pixmap.scaled(
                    self._preview_thumb.size(),
                    Qt.AspectRatioMode.KeepAspectRatio,
                    Qt.TransformationMode.SmoothTransformation,
                )
            )
            _region_diag("set_pending_image: 缩略图已生成")
        else:
            # Qt 的 JPEG **解码**也在个别环境不可靠；即便预览画不出来，
            # 图本身仍在 _pending_image 里，必须照样能发出去。
            _region_diag("set_pending_image: 缩略图生成失败（不影响发送）")
        size_kb = max(1, len(data) // 1024)
        self._preview_note.setText(f"已框选截图（{size_kb} KB）· 可附一句话再发送")
        self._preview_row.setVisible(True)

    def clear_pending_image(self) -> None:
        """撤掉待发送的截图。"""
        self._pending_image = None
        self._preview_thumb.clear()
        self._preview_note.setText("")
        self._preview_row.setVisible(False)
        provider = getattr(self.service, "provider", None)
        if provider is not None and callable(getattr(provider, "clear_pending_image", None)):
            provider.clear_pending_image()

    def _stage_pending_image(self) -> bool:
        """把待发送图片交给 provider；返回是否挂载成功。"""
        data = self._pending_image
        if not data:
            return False
        provider = getattr(self.service, "provider", None)
        stage = getattr(provider, "stage_image", None)
        if not callable(stage):
            # 当前 provider 不支持图片（如 OpenAI 兼容端点）：不静默丢弃
            self.hint_label.setText("当前模型不支持截图提问")
            return False
        stage(data, "image/jpeg")
        return True

    # ------------------------------------------------------------ 发送
    def _send(self) -> None:
        if self.service.busy:
            _region_diag("_send: service 忙 -> 改为停止当前请求（本次不发送）")
            self.service.stop()
            return
        text = self.input.text().strip()
        has_image = bool(self._pending_image)
        _region_diag(
            "_send: 文本=%d 字 待发截图=%s（%s 字节）"
            % (len(text), has_image, len(self._pending_image) if self._pending_image else 0)
        )
        if not text and not has_image:
            return
        # 挂图要在 service.send() 之前完成：provider 在 stream() 里消费它
        image_staged = self._stage_pending_image() if has_image else False
        if has_image and not image_staged:
            # 挂载失败（provider 不支持）：保留图片与输入，让用户能改后再试
            _region_diag("_send: 图片挂载失败，已中止发送")
            return
        _region_diag(f"_send: 图片挂载={image_staged}")
        # 只发图时给会话历史一个可读的占位，否则会话列表里会出现空白条目
        history_text = text or "（截图）"
        self.input.clear()
        # 陈旧快照防护（DS-M7 → R3 P1 硬修）：原子「读-追加-提交」
        synced, _absorbed = self.store.append_message(
            self.session, ChatMessage("user", history_text)
        )
        if synced is None:
            self.session.messages.append(ChatMessage("user", history_text))
            self.store.save(self.session)
        else:
            self.session = synced
        self.output.setText("")
        self._set_reply_text("")
        self._page = 0
        self._pages = []
        self.page_widget.setVisible(False)
        self.hint_label.setText("思考中…")
        config = self.settings.active_config
        config.api_key = self.config.resolve_api_key(config)
        messages = self.prompt_builder.build_messages(
            self.settings, self.character_id, self.session.messages[:-1], text
        )
        # 图**跟着消息走**，不依赖 provider 实例状态。
        #
        # 为什么改成这样：实例属性、模块级字典、落盘副本三种存法都出现过
        # "挂载后 20ms 同一实例读不到"（发送流程里 `ChatService.send()` 会先
        # `stop()` 上一条请求，疑似那条路径把待发状态清掉了）。
        # 而 messages 是本次调用的**参数**，随调用一起进入 `_Worker.run()`，
        # 不存在被别处清理的可能。provider 从最后一条消息里取图。
        if image_staged:
            # 关键：先用局部变量持有这份字节，再挂到消息上。
            # 否则 _pending_image 会被后面的 clear_pending_image() 清空，
            # 而工作线程此刻可能还没读到它 —— 这正是"20ms 后图没了"的成因。
            image_bytes = self._pending_image
            messages[-1]["_dsh_image"] = {
                "data": bytes(image_bytes or b""),
                "mediaType": "image/jpeg",
            }
            _region_diag("_send: 图片已随消息传递 %d 字节" % len(image_bytes or b""))
        self._active_request_id = self.service.send(messages, config)
        # 发送已在飞行中（图已被消息持有），现在才清界面上的待发状态与落盘副本
        if image_staged:
            self.clear_pending_image()
            _region_diag("_send: 已清理界面待发状态（图仍在消息里）")

    def _started(self, request_id: str) -> None:
        if request_id != self._active_request_id:
            return
        self.hint_label.setText("生成中…")

    def _delta(self, request_id: str, text: str) -> None:
        if request_id != self._active_request_id:
            return
        self._set_reply_text(self._reply_full + str(text))
        self._render_reply()

    def _finished(self, request_id: str, text: str) -> None:
        if request_id != self._active_request_id:
            return
        # 落库/聊天窗用全文；气泡展示文本另行截断（见 _set_reply_text）。
        self._set_reply_text(text)
        synced, _absorbed = self.store.append_message(self.session, ChatMessage("assistant", self._reply_full))
        if synced is None:
            self.session.messages.append(ChatMessage("assistant", self._reply_full))
            self.store.save(self.session)
        else:
            self.session = synced
        self._active_request_id = None
        self.hint_label.setText("")
        self._render_reply()

    def _error(self, request_id: str, text: str) -> None:
        if request_id != self._active_request_id:
            return
        self._active_request_id = None
        self.hint_label.setText("")
        self._set_reply_text(f"请求失败：{text}")
        self._render_reply()

    def _stopped(self, request_id: str) -> None:
        if request_id != self._active_request_id:
            return
        self._active_request_id = None
        self.hint_label.setText("已停止")

    # ------------------------------------------------------------ 显示
    def _set_reply_text(self, full_text: str) -> None:
        """记录 AI 回答全文，并算出气泡内展示文本（超限截断 + 提示全文位置）。

        全文与展示文本分开：会话历史/聊天窗始终拿全文，气泡只展示开头一段，
        免得长回答把头顶气泡撑成一堵墙。
        """
        self._reply_full = str(full_text or "")
        self._reply_text = truncate_bubble_text(
            self._reply_full, _REPLY_PREVIEW_LIMIT, _REPLY_PREVIEW_SUFFIX
        )
        self._reply_truncated = self._reply_text != self._reply_full

    def _set_page_controls_visible(self, on: bool) -> None:
        """显示/隐藏分页箭头与页码（截断预览时只保留「去聊天窗」按钮）。"""
        for widget in (self.prev_btn, self.page_label, self.next_btn):
            widget.setVisible(on)

    def _render_reply(self) -> None:
        text = self._reply_text
        # 回复改成在**桌宠头顶的气泡**里显示（漫画式），本气泡下方只留输入。
        #
        # 为什么不在这里滚动显示：桌宠自己的说话气泡已经具备长文本分页、
        # 与状态/告警气泡共处时的避让，以及跟随桌宠移动的能力——再养一个
        # 滚动区等于两套气泡抢同一块屏幕，遮挡问题永远修不干净。
        self._show_reply_in_pet_bubble(text)
        if len(text) > _PAGE_SIZE:
            self._pages = [text[i:i + _PAGE_SIZE] for i in range(0, len(text), _PAGE_SIZE)]
            self._page_label.setText(f"共 {len(self._pages)} 段")
            return
        self._pages = []

    def _show_reply_in_pet_bubble(self, text: str) -> None:
        """把回复写进桌宠头顶气泡；桌宠不在时退回本气泡的输出区（不丢内容）。"""
        pet = self.pet_window
        show = getattr(pet, "show_bubble", None) if pet is not None else None
        if not callable(show):
            self.output.setText(text)
            return
        from .speech_bubble_text import bubble_max_lines
        # 分页与气泡行数上限交给气泡自己；这里只负责把正文递过去。
        if len(text) <= _PAGE_SIZE:
            try:
                show(text, duration_ms=_REPLY_BUBBLE_DWELL_MS)
                return
            except Exception:  # noqa: BLE001 - 气泡显示失败不该吞掉回复
                pass
        # 超长：按气泡能吃下的行数切成几段，逐段交给气泡分页显示
        pages = self._pages or [text]
        try:
            show(pages[0], duration_ms=_REPLY_BUBBLE_DWELL_MS)
        except Exception:  # noqa: BLE001
            self.output.setText(text)
        _ = bubble_max_lines  # 保留导入点，便于后续按行数自适应切段

    def _show_page(self, index: int) -> None:
        if not self._pages:
            return
        self._page = max(0, min(index, len(self._pages) - 1))
        self.output.setText(self._pages[self._page])
        self.page_label.setText(f"{self._page + 1}/{len(self._pages)}")
        self.prev_btn.setEnabled(self._page > 0)
        self.next_btn.setEnabled(self._page < len(self._pages) - 1)

    def _open_full_chat(self) -> None:
        """把 DSH 拉到前台并切到当前会话（原"去聊天窗"按钮）。

        独立大聊天窗已废弃，这个按钮改为跳转 DSH——桌面版 DSH 没有对外入口，
        只能往桥接目录投 `open-session-<id>.json` 请它自己过来（见 pet/dsh_jump.py）。
        投不出去时退回旧行为（让 app 决定开什么），不把按钮变成死键。
        """
        try:
            from .dsh_jump import jump_to_dsh

            if jump_to_dsh():
                self.hint_label.setText("已请 DSH 打开对话…")
                return
        except Exception:  # noqa: BLE001 - 跳转失败不该影响气泡可用性
            pass
        pet = self.pet_window
        if pet is not None and callable(getattr(pet, "on_open_chat", None)):
            pet.on_open_chat()
        elif hasattr(self, "open_chat_callback") and callable(self.open_chat_callback):
            self.open_chat_callback()

    def event(self, event) -> bool:
        if event.type() == QEvent.Type.WindowDeactivate and self.isVisible():
            # Cocoa 在另一个应用内窗口仍活动时首次 show/activate Tool 窗口，
            # 会产生一次过渡性的 WindowDeactivate；此时同步 close 会留下只
            # 有原生灰色底板的空白窗口。下一事件轮的 activeWindow 已稳定，
            # 可以区分这次过渡和用户真正切走焦点。
            if not self._deactivate_check_pending:
                self._deactivate_check_pending = True
                QTimer.singleShot(0, self, self._close_if_still_inactive)
        return super().event(event)

    def _close_if_still_inactive(self) -> None:
        self._deactivate_check_pending = False
        if self.isVisible() and QApplication.activeWindow() is not self:
            self.close()

    def closeEvent(self, event) -> None:  # noqa: N802
        if self.service.busy:
            self.service.stop()
        # 释放排布器里的位置，让别的气泡可以占用这块空间
        try:
            from .bubble_layout import shared_layout

            shared_layout().release("quick-chat")
        except Exception:  # noqa: BLE001
            pass
        if self._capture_compat and self._capture_host is not None:
            setter = getattr(self._capture_host, "set_capture_headroom", None)
            if setter is not None:
                try:
                    setter(0)
                except RuntimeError:
                    pass  # 宿主窗口已在销毁中
        super().closeEvent(event)
