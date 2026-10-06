# -*- coding: utf-8 -*-
"""就地重打版本戳（组装.py 的补充工具）

为什么需要它：`组装.py` 是"从**上游镜像**重新拼一份 index.html"，而那份 71 MB 镜像已经不在盘上了
（用户清理时删了）。于是改了 `游戏/*.js` 之后，index.html 里那些 `?v=<md5>` 与 `HS_BUILD`
还停在旧值 —— 后果有两个：① 浏览器可能继续用缓存里的旧脚本；② `建沙盒卡.py --check`
比"卡里的构建戳 vs 当前源码哈希"会判成"卡过期"，让你没法确认交付是否对得上。

它做的事只有一件：算出当前运行时哈希，把 index.html 里**所有**该带戳的地方就地改成同一个值。
不改任何代码、不新增/删除标签、不碰上游那 4 个文件。

用法：
    python 工具/重打版本戳.py            # 就地改（会先打印改了哪些行）
    python 工具/重打版本戳.py --dry       # 只看会改什么
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _找游戏根(起):
    d = 起
    for _ in range(5):
        if os.path.isfile(os.path.join(d, "游戏", "外壳.js")):
            return d
        d = os.path.dirname(d)
    return 起


ROOT = _找游戏根(HERE)


def 当前版本():
    """与 组装.py 的 runtime_version() 同一算法（同一份 RUNTIME 列表、同样的拼接顺序）。"""
    import hashlib
    import importlib.util
    spec = importlib.util.spec_from_file_location("组装", os.path.join(HERE, "组装.py"))
    模 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(模)                 # 它只定义常量与函数，导入无副作用
    return 模.V


def main():
    dry = "--dry" in sys.argv
    V = 当前版本()
    p = os.path.join(ROOT, "index.html")
    if not os.path.isfile(p):
        raise SystemExit("找不到 " + p)
    with open(p, encoding="utf-8") as f:
        s = f.read()

    改 = []

    # ① 所有 游戏/xxx? v=旧  → 新
    def 换(m):
        旧 = m.group(2)
        if 旧 != V:
            改.append("%s  %s → %s" % (m.group(1), 旧, V))
        return m.group(1) + "?v=" + V      # ⚠ 别把 ?v= 写丢：丢了就成 游戏/外壳.jsba71098a（404、整页白）
    s2 = re.sub(r'((?:游戏|src)/[^"?\s]+)\?v=([0-9a-f]{6,})', 换, s)

    # ② window.HS_BUILD="旧" → 新
    def 换戳(m):
        旧 = m.group(1)
        if 旧 != V:
            改.append("HS_BUILD  %s → %s" % (旧, V))
        return 'window.HS_BUILD="' + V + '";'
    s3 = re.sub(r'window\.HS_BUILD="([0-9a-f]{6,})";', 换戳, s2)

    if not 改:
        print("[戳] 已经是最新（%s），没改任何东西" % V)
        return 0
    print("[戳] 当前源码版本：%s" % V)
    for x in 改:
        print("     " + x)
    if dry:
        print("[戳] （--dry：没有写回）")
        return 0
    with open(p, "w", encoding="utf-8", newline="") as f:
        f.write(s3)
    print("[戳] 已写回 index.html（共 %d 处）" % len(改))
    return 0


if __name__ == "__main__":
    sys.exit(main())
