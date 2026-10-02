# -*- coding: utf-8 -*-
"""屏幕框选：覆盖整个虚拟桌面，拖拽选出矩形区域并交回其坐标。

## 为什么要自己冻结一张底图

框选覆盖层本身是全屏窗口。如果等到鼠标松开才去截屏，截到的会是**覆盖层自己**
（半透明遮罩 + 选区边框），而不是用户想框的画面。因此覆盖层在出现的那一刻
就把整个虚拟桌面截成一张 QPixmap 作为背景显示，用户框的、以及最终裁切用的，
都是这同一张图——所见即所得，也没有时序竞态。

底图同时写进剪贴板：用户框选时若想放弃，Ctrl+V 仍能贴到刚才的画面。
"""

from __future__ import annotations

from PySide6.QtCore import QPoint, QRect, Qt, Signal
from PySide6.QtGui import QColor, QGuiApplication, QKeySequence, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QWidget

#: 小于这个尺寸视为误触（单击而非框选），直接取消
MIN_SELECTION = 8


#: 绘制日志限流：拖动会持续触发 paintEvent，逐次落盘会把磁盘打满并拖慢交互
_PAINT_LOG_INTERVAL = 0.5
_last_paint_log = 0.0


def _diag_paint(msg: str) -> None:
    global _last_paint_log
    import time

    now = time.monotonic()
    if now - _last_paint_log < _PAINT_LOG_INTERVAL:
        return
    _last_paint_log = now
    _diag(msg)


def _diag(msg: str) -> None:
    """逐步诊断：框选是全屏交互，一旦卡住整个 Qt 事件循环都会静默，
    桌宠自己的日志也不会有新行。写一份独立的、逐步的记录，
    用来判断究竟卡在哪一步（建覆盖层 / 截底图 / 进剪贴板 / 绘制 / 收尾）。
    """
    try:
        import datetime
        import os
        from pathlib import Path

        appdata = os.environ.get("APPDATA") or str(Path.home())
        target = Path(appdata) / "dsh-pet-standalone-webm-chat" / "dsh-region.log"
        target.parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]
        with open(target, "a", encoding="utf-8") as fh:
            fh.write(f"{stamp} [pid={os.getpid()}] {msg}\n")
    except Exception:  # noqa: BLE001 - 诊断失败绝不影响交互
        pass


def virtual_desktop_geometry() -> QRect:
    """整个虚拟桌面的并集矩形（多屏时为所有屏幕的外接矩形）。

    逐屏 grabWindow 在 Windows 高 DPI 下容易错位，因此这里用
    `QScreen.grabWindow(0)` 截整个虚拟桌面：它在 Windows 上返回的就是
    完整虚拟桌面，一次拿全。
    """
    geometry = QRect()
    for screen in QGuiApplication.screens():
        geometry = geometry.united(screen.geometry())
    return geometry


def grab_virtual_desktop() -> tuple[QPixmap, QRect]:
    """截取整个虚拟桌面，返回 (底图, 虚拟桌面矩形)。

    底图尺寸与矩形尺寸一致（devicePixelRatio 交给 Qt 处理），
    因此 `pixmap.copy(rect - geometry.topLeft())` 就是所见即所得的裁切。
    """
    geometry = virtual_desktop_geometry()
    screen = QGuiApplication.primaryScreen()
    pixmap = QPixmap()
    _diag(f"grab: 开始 geometry={geometry.width()}x{geometry.height()} screen={screen is not None}")
    if screen is not None:
        # grabWindow(0) = 整个虚拟桌面（Windows 语义）
        pixmap = screen.grabWindow(0)
        _diag(f"grab: grabWindow 返回 null={pixmap.isNull()} size={pixmap.width()}x{pixmap.height()} dpr={pixmap.devicePixelRatio()}")
    if pixmap.isNull():
        return QPixmap(), geometry
    # 某些平台返回的尺寸可能因 DPR 与逻辑矩形不同，按逻辑矩形对齐一份副本，
    # 使后续坐标换算恒定（避免把选区裁到图外）。
    if pixmap.size() != geometry.size():
        pixmap = pixmap.scaled(
            geometry.size(),
            Qt.AspectRatioMode.IgnoreAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
    return pixmap, geometry


class ScreenRegionSelector(QWidget):
    """全屏框选覆盖层。

    - 拖拽：画出选区（实时显示尺寸）
    - 松开：`selected(QRect)`（坐标为**屏幕全局坐标**）
    - Esc / 右键 / 过小选区：`cancelled()`
    """

    selected = Signal(QRect)
    cancelled = Signal()

    def __init__(self) -> None:
        super().__init__(None)
        _diag("Selector.__init__: 开始")
        self._backdrop, self._geometry = grab_virtual_desktop()
        _diag(f"Selector.__init__: 底图就绪 null={self._backdrop.isNull()}")
        self._origin: QPoint | None = None
        self._current: QPoint | None = None
        self._dragging = False
        #: 本次框选是否已有结论（selected / cancelled 之一），供 closeEvent 去重
        self._settled = False

        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        # 不抢焦点会导致 Esc/键盘收不到，因此这里要焦点，但用光标提示"框选"
        self.setCursor(Qt.CursorShape.CrossCursor)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setGeometry(self._geometry)
        _diag(f"Selector.__init__: 几何已设 {self._geometry.width()}x{self._geometry.height()}")

        # 底图进剪贴板：放弃框选后仍可粘贴刚看到的画面。
        # 这一步在大分辨率下代价不低（2559x1391 全图同步写剪贴板），
        # 因此单独埋点，便于判断它是否是卡顿来源。
        if not self._backdrop.isNull():
            _diag("Selector.__init__: 开始写剪贴板")
            QGuiApplication.clipboard().setPixmap(self._backdrop)
            _diag("Selector.__init__: 剪贴板写入完成")

        self._hint = "拖动框选区域 · Esc 取消"
        _diag("Selector.__init__: 完成")

    # ------------------------------------------------------------ 绘制
    def paintEvent(self, event) -> None:  # noqa: N802 - Qt 命名
        _diag_paint("paintEvent: 开始")
        painter = QPainter(self)
        if not self._backdrop.isNull():
            painter.drawPixmap(self.rect(), self._backdrop)
        else:
            painter.fillRect(self.rect(), QColor(0, 0, 0, 160))

        selection = self._selection_rect()
        if selection.isNull():
            # 未开始拖拽：整屏压暗，只留提示
            painter.fillRect(self.rect(), QColor(0, 0, 0, 110))
        else:
            # 选区外压暗、选区内保持原亮度（四块矩形，避免逐像素处理）
            shade = QColor(0, 0, 0, 110)
            full = self.rect()
            painter.fillRect(QRect(full.left(), full.top(), full.width(), selection.top() - full.top()), shade)
            painter.fillRect(
                QRect(full.left(), selection.bottom() + 1, full.width(), full.bottom() - selection.bottom()),
                shade,
            )
            painter.fillRect(QRect(full.left(), selection.top(), selection.left() - full.left(), selection.height()), shade)
            painter.fillRect(
                QRect(selection.right() + 1, selection.top(), full.right() - selection.right(), selection.height()),
                shade,
            )
            pen = QPen(QColor(255, 255, 255), 1)
            painter.setPen(pen)
            painter.drawRect(selection.adjusted(0, 0, -1, -1))
            label = f"{selection.width()} × {selection.height()}"
            painter.setPen(QColor(255, 255, 255))
            painter.drawText(selection.adjusted(6, 6, -6, -6), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop, label)

        painter.setPen(QColor(255, 255, 255, 230))
        painter.drawText(self.rect().adjusted(0, 18, 0, 0), Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop, self._hint)
        painter.end()

    # ------------------------------------------------------------ 选区
    def _selection_rect(self) -> QRect:
        if self._origin is None or self._current is None:
            return QRect()
        return QRect(self._origin, self._current).normalized()

    # ------------------------------------------------------------ 事件
    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.RightButton:
            self._cancel()
            return
        if event.button() != Qt.MouseButton.LeftButton:
            return
        self._origin = event.position().toPoint()
        self._current = self._origin
        self._dragging = True
        _diag(f"mousePress: origin={self._origin.x()},{self._origin.y()}")
        self.update()

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if not self._dragging:
            return
        self._current = event.position().toPoint()
        self.update()

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if event.button() != Qt.MouseButton.LeftButton or not self._dragging:
            return
        self._dragging = False
        rect = self._selection_rect()
        _diag(f"mouseRelease: rect={rect.width()}x{rect.height()}")
        if rect.width() < MIN_SELECTION or rect.height() < MIN_SELECTION:
            _diag("mouseRelease: 选区过小 -> 取消")
            self._cancel()
            return
        # 局部坐标 -> 屏幕全局坐标
        global_rect = rect.translated(self._geometry.topLeft())
        crop = self.crop(rect)
        _diag(f"mouseRelease: 裁切完成 null={crop is None or crop.isNull()}")
        self._settled = True
        self.close()
        self.deleteLater()
        if crop is None or crop.isNull():
            _diag("mouseRelease: 裁切为空 -> cancelled")
            self.cancelled.emit()
            return
        self._cropped = crop
        _diag("mouseRelease: 发出 selected")
        self.selected.emit(global_rect)

    def keyPressEvent(self, event) -> None:  # noqa: N802
        if event.key() == Qt.Key.Key_Escape or event.matches(QKeySequence.StandardKey.Cancel):
            self._cancel()
            return
        super().keyPressEvent(event)

    def closeEvent(self, event) -> None:  # noqa: N802
        """任何关闭路径都要给出结果信号。

        被窗口管理器关掉、Alt+F4、或调用方直接 `close()` 时，如果既不报
        `selected` 也不报 `cancelled`，调用方就会卡在"已隐藏、等结果"的状态
        ——实测表现为「框选后桌宠消失」。这里统一收口成一次 `cancelled`
        （调用方本来就对重复信号做了幂等）。
        """
        super().closeEvent(event)
        if not self._settled:
            self._settled = True
            self.cancelled.emit()

    def _settle(self) -> None:
        """标记本次框选已有结论，避免 closeEvent 再补一次取消。"""
        self._settled = True

    def _cancel(self) -> None:
        self._settled = True
        self.close()
        self.deleteLater()
        self.cancelled.emit()

    # ------------------------------------------------------------ 结果
    def crop(self, local_rect: QRect) -> QPixmap | None:
        """从冻结的底图上裁出选区（局部坐标）。"""
        if self._backdrop.isNull():
            return None
        return self._backdrop.copy(local_rect)

    def cropped(self) -> QPixmap | None:
        """最近一次成功框选的裁切结果（`selected` 之后可取）。"""
        return getattr(self, "_cropped", None)


def select_region_blocking() -> QPixmap | None:
    """同步框选（供不便接信号的调用点用）；取消返回 None。

    内部自建事件循环：框选本身是模态交互，阻塞调用方是符合预期的。
    """
    from PySide6.QtCore import QEventLoop

    selector = ScreenRegionSelector()
    result: dict[str, QPixmap | None] = {"pixmap": None}
    loop = QEventLoop()

    def on_selected(_rect: QRect) -> None:
        result["pixmap"] = selector.cropped()
        loop.quit()

    selector.selected.connect(on_selected)
    selector.cancelled.connect(loop.quit)
    selector.show()
    selector.raise_()
    selector.activateWindow()
    loop.exec()
    return result["pixmap"]
