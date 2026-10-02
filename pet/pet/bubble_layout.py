# -*- coding: utf-8 -*-
"""气泡排布管理：让多个气泡同时显示而互不遮挡。

## 问题

桌宠有几套独立的气泡——头顶说话气泡（`PetSpeechBubble`）、快速对话气泡
（`QuickChatBubble`）、灵动岛对话（`IslandChatBubble`），加上 DSH 工作状态/
告警气泡。它们各自按"锚点 + 固定偏移"算坐标，彼此不知道对方存在，
于是**同一时刻出现两个就必然重叠**（实测：状态气泡压住对话框内容）。

## 做法

把"谁占哪儿"收敛到**一个进程级排布器**：

- 每个气泡在显示前 `acquire(...)` 领一块位置，关闭/隐藏时 `release(...)`；
- 同一泳道（lane）内**按注册顺序自上而下堆叠**，后来的排在已有块下面（lane=above
  时向上堆），因此同一时刻多个气泡也不重叠；
- 泳道分开：`above`（桌宠头顶，状态/说话/告警）与 `below`（桌宠脚下，输入框），
  两车道天然不冲突；
- 屏幕边界兜底：堆出屏幕就反向堆或夹回可见区域。

## 边界

只管理**位置**，不管气泡的内容、生命周期与显示时长；拿不到 `pet` 锚点时退化为
"不参与排布"（调用方按原逻辑定位），因此任何一处接入失败都不会让气泡消失。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from PySide6.QtCore import QPoint, QRect

#: 同一泳道内相邻气泡的间距（逻辑像素）
GAP = 8
#: 距离锚点的初始间距
ANCHOR_GAP = 8


@dataclass
class _Slot:
    """一个已登记气泡占用的矩形与它的身份。"""

    key: str
    lane: str
    rect: QRect


@dataclass
class BubbleLayout:
    """进程级气泡排布器（一个实例足够——桌宠的气泡都在 GUI 线程创建）。"""

    slots: list[_Slot] = field(default_factory=list)

    # ------------------------------------------------------------ 登记
    def acquire(self, key: str, lane: str, size, anchor: QRect, available: QRect, *, prefer: str = "") -> QPoint:
        """为 `key` 领一块位置，返回**全局坐标**左上角。

        key      : 气泡身份（同一 key 重复 acquire 会先释放旧块，等价"移动"）
        lane     : 'above' 头顶 / 'below' 脚下 / 'left' 左侧 / 'right' 右侧
        size     : 气泡尺寸（QSize）
        anchor   : 桌宠可见内容矩形（全局）
        available: 可用屏幕矩形（全局）
        prefer   : 覆盖 lane 的默认方向：'' 用 lane 默认，'up'/'down' 强制
        """
        self.release(key)
        width, height = int(size.width()), int(size.height())

        lane_slots = [s for s in self.slots if s.lane == lane]

        if lane in ("left", "right"):
            # 侧向泳道：同侧已有气泡时继续向外（远离桌宠）堆，纵向居中于锚点
            if lane_slots:
                if lane == "left":
                    edge = min(s.rect.left() for s in lane_slots)
                    x = edge - GAP - width
                else:
                    edge = max(s.rect.right() for s in lane_slots)
                    x = edge + GAP
            else:
                x = (
                    anchor.left() - ANCHOR_GAP - width
                    if lane == "left"
                    else anchor.right() + ANCHOR_GAP
                )
            y = anchor.center().y() - height // 2
            # 横向兜底：放不下就翻到另一侧，再不行夹回屏内
            if x < available.left():
                if lane == "left":
                    x = anchor.right() + ANCHOR_GAP
                else:
                    x = available.left() + 4
            if x + width > available.right():
                if lane == "right":
                    x = anchor.left() - ANCHOR_GAP - width
                if x < available.left():
                    x = available.left() + 4
            y = max(available.top() + 4, min(y, available.bottom() - height - 4))
            self.slots.append(_Slot(key=key, lane=lane, rect=QRect(QPoint(x, y), size)))
            return QPoint(x, y)

        above = lane == "above" if not prefer else prefer == "up"

        # 同泳道已有气泡时，贴着最外侧那块继续堆（above 向上、below 向下）
        if lane_slots:
            if above:
                edge = min(s.rect.top() for s in lane_slots)
                y = edge - GAP - height
            else:
                edge = max(s.rect.bottom() for s in lane_slots)
                y = edge + GAP
        else:
            y = anchor.top() - ANCHOR_GAP - height if above else anchor.bottom() + ANCHOR_GAP

        x = anchor.center().x() - width // 2

        # 纵向兜底：堆出屏幕就翻到另一侧
        if y < available.top():
            if above:
                y = anchor.bottom() + ANCHOR_GAP
                above = False
            else:
                y = available.top() + 4
        if y + height > available.bottom():
            if not above:
                y = anchor.top() - ANCHOR_GAP - height
                above = True
            if y < available.top():
                y = available.top() + 4
        # 横向夹回可见区
        x = max(available.left() + 4, min(x, available.right() - width - 4))

        self.slots.append(_Slot(key=key, lane=lane, rect=QRect(QPoint(x, y), size)))
        return QPoint(x, y)

    def release(self, key: str) -> None:
        """气泡隐藏/关闭时释放它的位置（不存在则无操作）。"""
        if not key:
            return
        self.slots = [s for s in self.slots if s.key != key]

    def release_all(self) -> None:
        self.slots.clear()

    # ------------------------------------------------------------ 查询
    def active_keys(self) -> list[str]:
        return [s.key for s in self.slots]

    def rect_of(self, key: str) -> QRect | None:
        for slot in self.slots:
            if slot.key == key:
                return QRect(slot.rect)
        return None


#: 进程级单例：所有气泡共享同一份占用表
_layout = BubbleLayout()


def shared_layout() -> BubbleLayout:
    """取共享排布器（测试可替换 `pet.bubble_layout._layout`）。"""
    return _layout
