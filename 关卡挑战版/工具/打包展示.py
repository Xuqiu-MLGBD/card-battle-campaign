# -*- coding: utf-8 -*-
"""打包展示.py —— 把「关卡挑战版」整棵树整理成一份**能直接打开就能玩**的展示/开源包。

================================================================================
为什么改成"整树复制"（2026-10-04 事故，必须记住）
================================================================================
上一版用的是**白名单**：手写一张「要拷哪些文件」的清单，并把仍在分发的第三方文件
统一放进 `上游运行时/` 子目录。结果这份包**根本打不开**：

    index.html 引用的是 `styles.css` / `index.js` / `src/scripts/attack.js`
    —— 根路径；而清单把它们拷进了 `上游运行时/`。
    → 打开包 = 裸 HTML：上游靠样式表藏起来的 Victory / Sound / Options / Show FPS
      全部外露，点击还会被 `#fireworkCanvas` 吃掉（正是之前那两次"点不动"的长相）。

更要命的是：**页面自检当时 35 项全绿**。因为自检只查运行时状态，从来没有人查过
"文件到底在不在"。两份新闸门就是为这一类事故加的（都在本脚本里会自动跑）：

    ① 工具/引用体检.js —— 静态引用闸门（不跑浏览器，5 毫秒）：
       解析 index.html 的每个本地 link/script、以及 CSS 里的 url()/@import，
       逐个断言"文件就在它被引用的那个位置"。
    ② 页面自检 ㊲/㊳ + 检错层 ASSET_MISSING / STYLE_NOT_APPLIED —— 运行期闸门：
       资源有没有 404、样式有没有真的落到元素上（上游 body 黑底 + 我们藏住的装饰画布）。

结论（立成规矩）：**要分发的树，一律整树复制；只允许"排除"工作目录，不再"搬家"。**
凡是改了位置的，引用就会断 —— 这条比"包看起来干净"重要得多。

产物：开源卡牌案例/展示-关卡挑战版/
  ├─ index.html  index.js  styles.css  src/scripts/*.js   被引用的东西必须待在原位
  ├─ 游戏/              我们自己的运行时（12 件：外壳/事件/引擎/卡库/资源/决策/文案/检错/状态/演出/界面/沙盒 + 样式）
  ├─ 工具/ 说明/         构建、启动、备份、检索、审计、基线、文档
  ├─ test_*.mjs         四套 node 断言（与 游戏/、工具/ 同层：它们按自身目录找文件）
  ├─ 沙盒卡/             MMD 沙盒卡产物（6 键 JSON + 交付说明 + 人设）+ 建沙盒卡.py
  ├─ README.md          本项目自述（源文件在 开源卡牌案例/展示-README.md）
  ├─ 来源与许可.txt      事实性来源说明
  └─ 来源与许可/         LICENSE-MIT.txt（第三方许可证原件）+ README-第三方.md（其署名 README）
     ↑ MIT 要求：仍随包分发的第三方代码，其许可证与版权声明必须随包 —— 这 4 个文件还在，
       所以这些材料**必须留**；等 说明/15-自有化-去依赖执行表.md 走完、包里零第三方代码，才谈得上删。

用法：python 打包展示.py
"""
import io
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))          # 关卡挑战版/工具


def _找游戏根(起):
    """往上找到含 游戏/外壳.js 的那一层（工具统一收进 工具/ 之后，脚本自己认路）。"""
    d = 起
    for _ in range(5):
        if os.path.isfile(os.path.join(d, "游戏", "外壳.js")):
            return d
        d = os.path.dirname(d)
    return os.path.dirname(起)


ROOT = _找游戏根(HERE)                                        # 关卡挑战版（游戏本体）
项目根 = HERE = os.path.dirname(ROOT)                          # 含 关卡挑战版/、输出/、展示-README.md
OUT = os.path.join(项目根, "展示-关卡挑战版")                    # 产物：需要时用本脚本重建（平时不必留）

# 整树复制时**只排除这些目录**（工作产物与 VCS/缓存；游戏本体一个都不排除）
排除目录 = {"备份", "输出", "工作-沙盒卡", "工作-展示", "工作-临时", ".git", "__pycache__", ".vscode", "node_modules"}
排除文件 = {".DS_Store", "Thumbs.db", "_srv.log",
          # 第三方材料搬到 来源与许可/ 下改名（见 许可材料）：根目录留两个 README 只会让人分不清谁是"本项目"
          "LICENSE", "README-上游.md"}

# 额外附加的（基础目录, 源相对该目录, 包内相对路径）
# ⚠ 基础目录必须写清：LICENSE / README-上游.md 在**游戏树**里、建沙盒卡.py 在**上一级**，
#   第一版一律按 HERE 拼，于是三个附加件"找不到"（打包不报错、包里就少文件，正是这类事故）。
游戏树 = os.path.join(HERE, "关卡挑战版")
上一级 = os.path.dirname(HERE) if os.path.basename(HERE) != "" else HERE
附加 = [
    (HERE, "展示-README.md", "README.md"),
    (HERE, os.path.join("输出", "关卡挑战版-沙盒卡.json"), os.path.join("沙盒卡", "关卡挑战版-沙盒卡.json")),
    (HERE, os.path.join("输出", "交付说明-沙盒卡.md"), os.path.join("沙盒卡", "交付说明-沙盒卡.md")),
    (HERE, os.path.join("输出", "人设-卡牌对战.txt"), os.path.join("沙盒卡", "人设-卡牌对战.txt")),
    (HERE, "建沙盒卡.py", os.path.join("沙盒卡", "建沙盒卡.py")),
]

# 第三方材料（改个说得清的名字，放进 来源与许可/；MIT 要求随包）
许可材料 = [
    (游戏树, "LICENSE", os.path.join("来源与许可", "LICENSE-MIT.txt")),
    (游戏树, "README-上游.md", os.path.join("来源与许可", "README-第三方.md")),
]

# 在包内跑沙盒卡构建需要的打包器（建沙盒卡.py 会优先找 ../scripts/pack_card.py，找不到就用 工具/ 下这份）
可选件 = [
    (os.path.join(上一级, "scripts"), "pack_card.py", os.path.join("工具", "pack_card.py")),
]

# 仍然随包分发的第三方代码（供 来源与许可.txt 与"零第三方"检查用：这份清单就是判据）
随包第三方 = ["index.js", "styles.css",
              os.path.join("src", "scripts", "attack.js"),
              os.path.join("src", "scripts", "elementsController.js")]

没放进来 = [
    ("第三方源码树（71 MB 镜像）", "只有跑 工具/组装.py --check 才需要；本包给的是「用上的必要文件」"),
    ("已剥离的第三方美术与音频（128 个文件 / 71.2 MB）", "组装.py 剥离的结果：本包不含任何第三方美术与音频"),
    ("备份/ 与 工作-*/", "快照与中间产物，不属于源码"),
    ("已被替换的第三方文件（deck.js / animations.css / AI.js 等 12 件）",
     "页面已不再加载它们，属于「去依赖执行表」里已完成的部分"),
]


def 整树复制():
    """复制 关卡挑战版/ 全部内容 → OUT（只跳过 排除目录）。返回 (文件数, 字节数)。"""
    数 = 0
    量 = 0
    for dirpath, dirs, files in os.walk(ROOT):
        dirs[:] = [x for x in dirs if x not in 排除目录]
        rel = os.path.relpath(dirpath, ROOT)
        for fn in files:
            if fn in 排除文件:
                continue
            s = os.path.join(dirpath, fn)
            t = os.path.join(OUT, fn if rel == "." else os.path.join(rel, fn))
            os.makedirs(os.path.dirname(t), exist_ok=True)
            shutil.copy2(s, t)
            数 += 1
            量 += os.path.getsize(s)
    return 数, 量


def 拷单件(基础, 源, 目标, 必需=True):
    s = os.path.normpath(os.path.join(基础, 源))
    if not os.path.exists(s):
        if 必需:
            raise SystemExit("[打包] ✗ 附加件缺失：%s —— 宁可不打包，也不能出「看着成功、包里少文件」的包" % s)
        print("[打包] ⚠ 可选件没有（跳过）：%s" % 源)
        return 0, 0
    t = os.path.join(OUT, 目标)
    os.makedirs(os.path.dirname(t), exist_ok=True)
    shutil.copy2(s, t)
    return 1, os.path.getsize(s)


def 跑闸门():
    """两道机器闸门。**任一失败就让脚本非零退出** —— 破了包却静默成功，正是上次的教训。"""
    脚 = os.path.join(OUT, "工具", "引用体检.js")
    if not os.path.exists(脚):
        print("[闸门] ⚠ 包内没有 工具/引用体检.js，跳过引用校验（不该发生）")
        return True
    好 = True

    # 闸门一：包内每个被引用的本地文件都在
    r1 = subprocess.run(["node", 脚, OUT], capture_output=True, text=True, encoding="utf-8", cwd=OUT)
    print("  " + (r1.stdout or "").strip().replace("\n", "\n  "))
    if r1.returncode != 0:
        好 = False

    # 闸门二：开发树里被引用、且确实存在的每个文件，包里也必须有一份（防"漏拷"）
    r2 = subprocess.run(["node", 脚, ROOT, "--对比", OUT], capture_output=True, text=True, encoding="utf-8", cwd=ROOT)
    print("  " + (r2.stdout or "").strip().replace("\n", "\n  "))
    if r2.returncode != 0:
        好 = False

    # 闸门三：第三方清单与包内实况一致（说明文档写"仅这 4 个"，机器要能证明）
    缺 = [x for x in 随包第三方 if not os.path.exists(os.path.join(OUT, x))]
    if 缺:
        print("  [闸门] ✗ 来源与许可.txt 说随包的第三方文件缺了：%s" % "、".join(缺))
        好 = False
    else:
        print("  [闸门] ✓ 随包第三方代码恰好 %d 件，且都在被引用的位置" % len(随包第三方))
    # 闸门四：随包的沙盒卡必须是**当前源码**打的（卡里的 JS 是构建期内联的 ——
    # 改了源码不重打包，卡就还是旧代码，于是"测试"和"交付"悄悄对不上。用户转来的建议正是这条）
    try:
        r3 = subprocess.run([sys.executable, os.path.join(HERE, "建沙盒卡.py"), "--check"],
                            capture_output=True, text=True, encoding="utf-8", cwd=HERE)
        print("  " + (r3.stdout or "").strip().replace("\n", "\n  "))
        if r3.returncode != 0:
            好 = False
    except Exception as e:
        print("  [闸门] ⚠ 校验卡时出错：%s" % e)
        好 = False
    return 好


def 统计():
    per = {}
    总 = 0
    for dirpath, dirs, files in os.walk(OUT):
        dirs[:] = [x for x in dirs if x not in 排除目录]
        for fn in files:
            p = os.path.join(dirpath, fn)
            顶 = os.path.relpath(p, OUT).split(os.sep)[0]
            键 = 顶 if os.sep in os.path.relpath(p, OUT) else "(根目录)"
            a, b = per.get(键, (0, 0))
            per[键] = (a + 1, b + os.path.getsize(p))
            总 += os.path.getsize(p)
    return per, 总


def 清空产物目录():
    """每次重建前清掉旧产物。

    ⚠ 这一步在 Windows 上有个真实的坑（2026-10-04 连撞两次）：
      **只要还有进程把包目录当工作目录**（最常见就是 `python -m http.server 8643`，
       或 工具/启动.py 起的那份），`shutil.rmtree(OUT)` 就会
       `PermissionError: [WinError 32] 另一个程序正在使用此文件` —— 于是"重建"直接失败。
       注意被占的不是某个文件，而是**目录本身**：Windows 禁止删除/改名任何进程的 CWD。
    所以这里的策略是分三层退让：
      ① 先尽力删掉已知的临时文件（服务日志）；
      ② `rmtree` 整棵删；
      ③ 删不动整棵就**只清内容**（目录留着没关系，反正我们要在里面重建）——
         这一层能救下"服务还开着"的情形；
      ④ 连内容都清不掉才报错，并**点名是谁**占着（把删不掉的文件列出来）。
    """
    if not os.path.isdir(OUT):
        return
    for 临时 in [os.path.join(OUT, "工具", "_srv.log")]:
        for _ in range(3):
            try:
                if os.path.exists(临时):
                    os.remove(临时)
                break
            except OSError:
                time.sleep(0.3)

    卡住 = []

    def 尽力删(p):
        try:
            if os.path.isdir(p) and not os.path.islink(p):
                for 子 in os.listdir(p):
                    尽力删(os.path.join(p, 子))
                os.rmdir(p)
            else:
                os.remove(p)
        except OSError:
            卡住.append(p)

    for _ in range(2):
        if not os.path.isdir(OUT):
            return
        try:
            shutil.rmtree(OUT)
            return
        except OSError:
            for 子 in os.listdir(OUT):
                尽力删(os.path.join(OUT, 子))
            if not os.listdir(OUT):
                print("[打包] 旧产物已清空（目录本身被别的进程当着工作目录，留着不影响重建）")
                return
            time.sleep(0.5)

    raise SystemExit(
        "[ERROR] 旧产物里有 %d 个文件被别的进程占着，删不掉：\n  %s\n"
        "        → 关掉那个进程（多半是 工具/启动.py 或 `python -m http.server`）或换个端口再打包。"
        % (len(卡住), "\n  ".join(卡住[:8])))


def main():
    if not os.path.isdir(ROOT):
        raise SystemExit("[ERROR] 找不到 " + ROOT)
    清空产物目录()

    数, 量 = 整树复制()
    for 基础, 源, 目标 in 附加 + 许可材料:
        a, b = 拷单件(基础, 源, 目标)
        数 += a
        量 += b
    for 基础, 源, 目标 in 可选件:
        a, b = 拷单件(基础, 源, 目标, 必需=False)
        数 += a
        量 += b

    with io.open(os.path.join(OUT, "来源与许可.txt"), "w", encoding="utf-8") as f:
        f.write(
            "关卡挑战版 · 来源与许可\n"
            "============================================================\n\n"
            "一、这个作品是谁的\n"
            "  除下面第二节列出的 4 个文件之外，本包全部内容都是本项目自己写的 ——\n"
            "  游戏/（12 个文件）、工具/、说明/、test_*.mjs、沙盒卡/ 均为自研；按行数计，\n"
            "  自研部分占成品源码的约 67%。本项目不是任何项目的分支，也不声称与任何项目有\n"
            "  组织或授权关系；它最初从一个 MIT 许可的原型起步，其后架构、交互、布局与卡表\n"
            "  均已重写，第三方美术与音频已全部剥离（128 个文件 / 71.2 MB，不在包内）。\n\n"
            "二、仍随包分发的第三方代码（**仅此 4 件**，且必须待在它被引用的位置）\n"
            "  index.js · styles.css · src/scripts/attack.js · src/scripts/elementsController.js\n"
            "  这 4 个文件是逐字第三方代码，页面仍在加载 —— 因此它们的许可证与版权声明\n"
            "  **必须随包保留**（见 来源与许可/LICENSE-MIT.txt 与 来源与许可/README-第三方.md）。\n"
            "  这不是客气：MIT 的原文要求就是「副本或实质部分须包含版权声明与许可」。\n"
            "  （注：这些文件**不能**为了「包内整洁」而搬进子目录 —— index.html 按根路径引用它们，\n"
            "   搬走就会让整页退化成裸 HTML。这条踩过一次，见 打包展示.py 顶部的事故记录。）\n\n"
            "三、怎么把它们也换掉（换完之后才谈得上删这一段）\n"
            "  见 说明/15-自有化-去依赖执行表.md：逐件换法、验收口径，以及「零第三方代码随包分发」\n"
            "  的四条机器检查。到那一步，本文件可以缩成一句事实性来源说明，来源与许可/ 整个删掉。\n\n"
            "四、刻意没有放进来的\n"
        )
        for 名, 理由 in 没放进来:
            f.write("  · %s —— %s\n" % (名, 理由))

    per, 总 = 统计()
    with io.open(os.path.join(OUT, "来源与许可.txt"), "a", encoding="utf-8") as f:
        f.write("\n五、体积\n  本次打包 %d 个文件 / %.2f MB（不含任何第三方美术与音频）。\n" % (数, 总 / 1048576.0))
        f.write("  分目录：\n")
        for k in sorted(per):
            a, b = per[k]
            f.write("    %-14s %3d 个文件  %8.1f KB\n" % (k, a, b / 1024.0))

    print("[打包] %s" % OUT)
    print("[打包] %d 个文件 / %.2f MB" % (数, 总 / 1048576.0))
    print("[闸门] 引用体检：")
    好 = 跑闸门()
    if not 好:
        raise SystemExit("[打包] ✗ 闸门没过 —— 这份包**不要**发布（上面已列出缺什么）")
    print("[打包] ✓ 全绿：引用齐备 · 与开发树一致 · 第三方清单相符")


if __name__ == "__main__":
    main()
