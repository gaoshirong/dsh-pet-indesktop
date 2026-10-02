# -*- coding: utf-8 -*-
"""dsh-pet 源码版启动入口（Python 包装器）。

用途：让 DSH 的 launch-pet.ps1 能以「一个可执行文件」的方式拉起**源码版**桌宠，
而不需要先 PyInstaller 打包。DSH 会把本文件当作 $Executable 传入，并以
``<venv>\\Scripts\\python.exe dsh_pet_launcher.py`` 的形式执行。

为什么需要这一层：
- 直接指向 ``pythonw.exe -m pet`` 时，自启项（pet/autostart.py 用 sys.executable）
  会丢掉 ``-m pet``，注册成裸 pythonw 而无法启动桌宠；
- ``pet/__main__.py`` 的相对导入需要 ``pet`` 是包路径下的模块，这里显式把
  源码目录放进 sys.path，等价于在源码目录执行 ``python -m pet``。

参数与产品完全一致：``--settings``、``--slot N``、``--instance ID`` 等一律透传。
"""
from __future__ import annotations

import os
import sys

# 源码根目录：pet/ 包的父目录，即 <repo>/src
SRC_ROOT = os.path.dirname(os.path.abspath(__file__))
# packaging/ 里有构建期生成的 build_variant.py（VARIANT = "webm-chat"），
# pet/config.py 以顶层模块名 `build_variant` 导入它。打包版把它放在 sys.path
# 上；源码版需要这里补一次，否则 APP_DIR_NAME 回退成共享目录
# %APPDATA%\dsh-pet-standalone，与现 exe 的配置目录不一致（设置/存档会分叉）。
for _extra in (SRC_ROOT, os.path.join(SRC_ROOT, "packaging")):
    if _extra not in sys.path:
        sys.path.insert(0, _extra)


def main() -> int:
    from pet.__main__ import _main

    return _main()


if __name__ == "__main__":
    sys.exit(main())
