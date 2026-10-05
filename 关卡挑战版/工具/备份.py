# -*- coding: utf-8 -*-
"""关卡挑战版 · 快照备份

在动手改任何东西**之前**先跑一次，把整个 `关卡挑战版/` 存一份带时间戳的副本到 `备份/`。

为什么只备份这一个目录（约 0.5 MB）：
  · `上游源码/`（71 MB）是**原封不动的上游**，而 `组装.py` 每次都会校验
    「上游代码一字未改」—— 所以上游那部分永远可以从它那里重建，不需要备份；
  · `index.html` 与剥掉的美术/音频也由 `组装.py` 从上游重新生成；
  · **真正不可再生的，只有我们自己写的那几个文件**（见下面 OURS 列表）。
    但整个 关卡挑战版 加一起才 0.5 MB，索性整目录快照，省得漏。

用法（在 工具/ 下跑，快照落在 开源卡牌案例/备份/）:
    python 备份.py                 # 存一份，打印路径
    python 备份.py 备注            # 带备注存一份
    python 备份.py --list          # 列出已有快照
    python 备份.py --restore <名字> # 用某个快照覆盖回去（会先自动再备份一次当前状态）
"""
import os
import shutil
import sys
import time

# 本文件住在 关卡挑战版/工具/ 下
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                          # 关卡挑战版/
WORK = os.path.dirname(ROOT)                          # 开源卡牌案例/
SRC = ROOT
BAK = os.path.join(WORK, "备份")

OURS = [
    os.path.join("游戏", "外壳.js"),
    os.path.join("游戏", "事件.js"),
    os.path.join("游戏", "引擎.js"),
    os.path.join("游戏", "卡库.js"),
    os.path.join("游戏", "资源.js"),
    os.path.join("游戏", "决策.js"),
    os.path.join("游戏", "文案.js"),
    os.path.join("游戏", "检错.js"),
    os.path.join("游戏", "状态.js"),
    os.path.join("游戏", "演出.js"),
    os.path.join("游戏", "界面.js"),
    os.path.join("游戏", "样式.css"),
    "index.html",
    os.path.join("工具", "组装.py"),
    os.path.join("工具", "启动.py"),
    os.path.join("工具", "备份.py"),
    os.path.join("工具", "标准对局.json"),
    os.path.join("工具", "对照清单.md"),
    os.path.join("工具", "说明检索.js"),      # 找说明里的一句话（findstr 处理不了中文，用它）
    os.path.join("工具", "全局审计.js"),      # 摘上游文件前查"它挂过哪些全局量"
    os.path.join("说明", "1-怎么跑.md"),
    "test_levels.mjs", "test_campaign.mjs", "test_engine.mjs", "test_对照.mjs",
]


def stamp():
    return time.strftime("%Y-%m-%d_%H%M%S")


def snapshot(note=""):
    if not os.path.isdir(SRC):
        raise SystemExit(f"[ERROR] 找不到 {SRC}")
    name = stamp() + (("_" + note) if note else "")
    dst = os.path.join(BAK, name)
    shutil.copytree(SRC, dst)
    n = sum(len(f) for _, _, f in os.walk(dst))
    size = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(dst) for f in fs)
    print(f"[备份] {dst}  （{n} 个文件，{size / 1048576:.2f} MB）")
    missing = [r for r in OURS if not os.path.exists(os.path.join(dst, r))]
    print("[备份] 自研文件齐全 ✓" if not missing else f"[备份] ⚠ 缺: {missing}")
    return dst


def list_():
    if not os.path.isdir(BAK):
        print("（还没有任何快照）")
        return
    names = sorted(os.listdir(BAK), reverse=True)
    if not names:
        print("（还没有任何快照）")
        return
    for n in names:
        p = os.path.join(BAK, n)
        if not os.path.isdir(p):
            continue
        t = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(os.path.getmtime(p)))
        print(f"  {n}   （存于 {t}）")


def restore(name):
    src = os.path.join(BAK, name)
    if not os.path.isdir(src):
        raise SystemExit(f"[ERROR] 没有这个快照：{name}")
    snapshot("恢复前")          # 覆盖前先把现状留一份，避免"恢复错了就没退路"
    for entry in os.listdir(src):
        s, d = os.path.join(src, entry), os.path.join(SRC, entry)
        if os.path.isdir(s):
            shutil.rmtree(d, ignore_errors=True)
            shutil.copytree(s, d)
        else:
            shutil.copy2(s, d)
    print(f"[恢复] 已用 {name} 覆盖 {SRC}（覆盖前的状态也存了一份）")


if __name__ == "__main__":
    if "--list" in sys.argv:
        list_()
    elif "--restore" in sys.argv:
        i = sys.argv.index("--restore")
        if i + 1 >= len(sys.argv):
            raise SystemExit("用法: python 备份.py --restore <快照名>")
        restore(sys.argv[i + 1])
    else:
        note = " ".join(a for a in sys.argv[1:] if not a.startswith("--"))
        snapshot(note)
