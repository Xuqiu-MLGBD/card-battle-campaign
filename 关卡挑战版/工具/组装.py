# -*- coding: utf-8 -*-
"""关卡挑战版 · 组装脚本

把「上游源码/hearthstone-web」+ 本目录的关卡层，组装成一份可跑的成品目录。

它做四件事，都是**可重复、可审计**的：
  1. 把上游的代码与资源复制进本目录（已存在就跳过，不覆盖关卡层自己的文件）
  2. **剥掉炉石的音频与全部美术**：删掉 STRIP_DIRS 那九个目录
     （ost / sounds / voiceovers / media / cards / images / hints / cursor / fonts。
      剥完 src/ 下只剩 scripts 与 stylesheets，也就是「简洁窗体」）
     剥掉不需要改任何代码 —— 静音、去卡图、压平背景引用都由 游戏/外壳.js
     在运行时接管，上游那些文件依旧一字未改
  3. 给 index.html 打补丁：插入 1 个样式表 + 4 个 <script> 标签，其余字节一字不动
  4. 校验结果（标签在不在、顺序对不对、上游代码是否被改过、音频与卡图是否真的没了）

为什么用脚本而不是手工改：这份 fork 与上游的**全部差异**必须能一眼说清。
index.html 的补丁是唯一的「改」，其余全是「加」。

目录约定（阶段 0 搬迁后）
  · 游戏/    —— 我们自己的运行时（外壳/卡库/演出/界面 + 样式），打包只带这个目录
  · 工具/    —— 组装 / 启动 / 备份，本文件在这里
  · 说明/    —— 文档
  · src/     —— **只剩上游文件**（scripts/ 与 stylesheets/），本脚本从上游重新复制

用法（在 工具/ 下跑）:
    python 组装.py                # 组装（含剥音频/卡图）
    python 组装.py --keep-media   # 组装但保留音频与卡图（只想对着上游看差异时用）
    python 组装.py --check        # 只校验，不改任何文件
"""
import filecmp
import hashlib
import os
import re
import shutil
import sys

# 本文件住在 关卡挑战版/工具/ 下，所以「本目录」要往上退一层才是成品根。
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPSTREAM = os.path.join(os.path.dirname(HERE), "上游源码", "hearthstone-web")

# 我们的**运行时**资源（顺序无关）。给它们算一个内容版本号，拼在 <script>/<link> 的 URL 上。
# 为什么要这个：这些文件是逐轮改的，而浏览器/宿主会把它们缓存住 —— 实测过"改了却像没改"
# （只在真机上表现为"伤害不生效"这类诡异症状，其实是旧脚本还在跑）。
# 版本号由内容哈希得出，所以**改了就自动变**，不需要谁记得手动 +1。
RUNTIME = [
    os.path.join("游戏", "样式.css"),
    os.path.join("游戏", "外壳.js"),
    os.path.join("游戏", "事件.js"),
    os.path.join("游戏", "引擎.js"),
    os.path.join("游戏", "卡库.js"),
    os.path.join("游戏", "回合.js"),      # 去上游：发牌 / 回合推进 / 落场 / 胜负（顶掉 index.js + attack.js 那部分）
    os.path.join("游戏", "查找.js"),      # MMD 沙盒适配：根部作用域查找 + 骨架 id 自愈 + 点击留痕
    os.path.join("游戏", "菜单.js"),      # 去上游：菜单开合唯一入口（设置按钮与 ESC 同一入口）
    os.path.join("游戏", "资源.js"),
    os.path.join("游戏", "决策.js"),
    os.path.join("游戏", "文案.js"),      # 架构改进 A：拒绝码 → 中文文案（唯一出处）
    os.path.join("游戏", "检错.js"),      # 全链路检错：层+码+上下文 → 聚合器 → 诊断报告
    os.path.join("游戏", "状态.js"),      # 改进 B：权威状态 + revision + 对账/追平
    os.path.join("游戏", "演出.js"),
    os.path.join("游戏", "界面.js"),
    # 只在**沙盒**里加载、但同样属于"运行时源码"的文件也要进哈希清单 ——
    # 否则"只改了 沙盒.js、构建戳不变"，`建沙盒卡.py --check` 就查不出卡过期（实测踩到过）。
    os.path.join("游戏", "沙盒.js"),
]


def runtime_version():
    h = hashlib.md5()
    for rel in RUNTIME:
        p = os.path.join(HERE, rel)
        with open(p, "rb") as f:
            h.update(f.read())
    return h.hexdigest()[:8]


V = runtime_version()


def v(rel):
    """带版本号的资源路径（写法与 index.html 里最终出现的一模一样）"""
    return rel + "?v=" + V


# 我们自己的文件 —— 复制上游时绝不覆盖它们，也是「自研文件齐全」的清单
OURS = {
    os.path.join("游戏", "外壳.js"),
    os.path.join("游戏", "事件.js"),
    os.path.join("游戏", "引擎.js"),
    os.path.join("游戏", "卡库.js"),
    os.path.join("游戏", "回合.js"),      # 去上游：回合一族（发牌/推进/落场/胜负）
    os.path.join("游戏", "菜单.js"),      # 去上游：菜单开合唯一入口
    os.path.join("游戏", "资源.js"),      # 阶段 C：资源与回合（法力上限 / 法力 / 抽牌补偿）
    os.path.join("游戏", "决策.js"),      # 阶段 E：敌方决策（三档难度）
    os.path.join("游戏", "文案.js"),      # 架构改进 A：拒绝码 → 中文文案（唯一出处）
    os.path.join("游戏", "检错.js"),      # 全链路检错（层 + 码 + 聚合 + 恢复）
    os.path.join("游戏", "状态.js"),      # 改进 B：权威状态（本局的"真相"与版本号）
    os.path.join("游戏", "演出.js"),
    os.path.join("游戏", "界面.js"),
    os.path.join("游戏", "样式.css"),
    os.path.join("工具", "组装.py"),
    os.path.join("工具", "启动.py"),
    os.path.join("工具", "备份.py"),
    os.path.join("说明", "1-怎么跑.md"),
    "test_levels.mjs",
    "test_campaign.mjs",
    "test_engine.mjs",
    "test_对照.mjs",
    os.path.join("工具", "标准对局.json"),
    os.path.join("工具", "对照清单.md"),
}

# 剥掉这九个目录 —— 全是炉石/暴雪的美术与音频，没有一行代码、也没有别处要用的东西。
# 剥完之后 src/ 下只剩 scripts/ 与 stylesheets/，也就是「简洁窗体」。
# 引用它们的 CSS 由 游戏/外壳.js 在运行时压平（否则每次加载会满屏 404）。
STRIP_DIRS = [
    # 音频
    os.path.join("src", "ost"),         # 背景音乐
    os.path.join("src", "sounds"),      # 音效
    os.path.join("src", "voiceovers"),   # 看板娘语音
    os.path.join("src", "media"),       # 开场影片
    # 美术
    os.path.join("src", "cards"),       # 卡图
    os.path.join("src", "images"),      # 牌桌背景 / 英雄立绘 / 卡背 / 卡包 / 状态角标
    os.path.join("src", "hints"),       # 拖牌提示动画（3 个 GIF，14.7 MB）
    os.path.join("src", "cursor"),      # 自定义光标
    os.path.join("src", "fonts"),       # Belwe —— 暴雪的商用字体，必须换掉
]

# index.html 的插入：锚点 → 插在它**后面**。顺序即加载顺序，不能反。
# 我们的四个游戏模块统一挂在 `index.js` 那一行**之前**（直接把这个锚点替换成"我们的 + 它"），
# 这样就不依赖任何具体上游 `<script>` 是否还在 —— 上游脚本被逐个接管、逐个摘掉时，
# 这里一个字都不用改。
INSERTS = [
    # 我们的样式表要排在**上游样式表之后**、而且要在 <head> 里 ——
    # background-image 的请求在解析 body 的那一刻就发出去了，靠脚本注入的样式来不及拦，
    # 实测会白打 11 个 404（背景图 / 光标 / 字体各来一趟）。
    # ⚠ 锚点原本是 animations.css 那一行；阶段 F 把那行摘掉之后，改锚在 styles.css 上
    #   （它是现在最后一张上游样式表，插在它后面正好接上）。
    ('<link rel="stylesheet" href="styles.css">',
     '<link rel="stylesheet" href="' + v("游戏/样式.css") + '">'),
    # ⚠ 这三条要**插在 `index.js` 之前**：卡库.js 里的 ?level 钩子必须赶在 startGame() 发牌动手。
    #   用"插在前面"而不是"插在某条上游标签后面"，是为了不依赖任何具体上游标签还在不在
    #   —— 上游脚本被逐个接管、逐个摘掉时，这里一个字都不用改。
    #   外壳.js 还得排在最前（赶在 index.js / AI.js / elementsController.js 构造 Audio 之前）；
    #   事件.js 必须在 引擎.js 之前（引擎装载时就要取事件层）。
    ('<script src="index.js"></script>',
     # ★ 构建戳（2026-10-04 加）：`HS_BUILD` = 上面那串运行时内容哈希（和 ?v= 同源）。
     #   为什么需要它：出过"有的脚本新、有的脚本旧"的缓存错位，而**沙盒里没有 <script src>**
     #   （脚本由规则注入），报告里那一行 `脚本版本` 于是整行空 —— 光看现象判断不出跑的是哪一版。
     #   有了这一行，独立网页与沙盒都能报出同一个戳，排查时一眼对上"这份报告是哪次构建的"。
     '<script>window.HS_BUILD="' + V + '";</script>\n'
     '<script src="' + v("游戏/外壳.js") + '"></script>\n'
     '<script src="' + v("游戏/事件.js") + '"></script>\n'
     '<script src="' + v("游戏/引擎.js") + '"></script>\n'
     '<script src="' + v("游戏/卡库.js") + '"></script>',
     'before'),
    ('<script src="src/scripts/testing.js"></script>',
     '<script src="' + v("游戏/回合.js") + '"></script>\n'
     '<script src="' + v("游戏/查找.js") + '"></script>\n'
     '<script src="' + v("游戏/菜单.js") + '"></script>\n'
     '<script src="' + v("游戏/资源.js") + '"></script>\n'
     '<script src="' + v("游戏/决策.js") + '"></script>\n'
     '<script src="' + v("游戏/文案.js") + '"></script>\n'
     '<script src="' + v("游戏/检错.js") + '"></script>\n'
     '<script src="' + v("游戏/状态.js") + '"></script>\n'
     '<script src="' + v("游戏/演出.js") + '"></script>\n'
     '<script src="' + v("游戏/界面.js") + '"></script>'),
]

# 加载顺序的硬要求（出现在 index.html 里的先后）
ORDER = [v("游戏/外壳.js"), v("游戏/事件.js"), v("游戏/引擎.js"), v("游戏/卡库.js"),
         v("游戏/回合.js"), v("游戏/查找.js"), v("游戏/菜单.js"), v("游戏/资源.js"), v("游戏/决策.js"), v("游戏/文案.js"),
         v("游戏/检错.js"), v("游戏/状态.js"), v("游戏/演出.js"), v("游戏/界面.js")]

# index.html 的替换：把上游那几行**摘掉**（对应文件留在盘上作对照物，只是页面不再加载）。
#
# ① 开场影片：`<video>` 出现在 body 里、比脚本早，浏览器解析到它时就已经开始抓影片了，
#    外壳.js 再快也晚一步 —— 每次加载白 404 一次。影片本身也不随包分发。
# ② deck.js：**卡数据与卡面渲染都归我们了**（游戏/卡库.js 的丙段 + 丁段）。
# ③ 批次 0 的七个"废件"（合计 1211 行）—— 每个都先查过"整个运行时零引用"才摘：
#      · load.js          开场载入层的显隐（`#contents`/`#load` 现在由 外壳.js + elementsController 各管一半）
#      · fps.js           `window.requestAnimFrame` 垫片 + FPS 显示（垫片只被它自己的计数循环用）
#      · pack_handler.js  卡包开包流程（我们没有开包入口）
#      · snow.js          雪花装饰（炉石味儿，且要 #snowCanvas）
#      · time.js          右上角时钟
#      · testing.js       上游的黑盒自测入口（我们有自己的四套）
#      · window_focus.js  切屏时切 body.className（剥了美术之后没有依赖它的样式）
#    摘法一律"注释掉那一行"，不是删——上游文件仍旧一字未改，`--check` 的逐字节比对照旧成立。
REPLACES = [
    ('<source src="src/media/introcinematic.mp4" type="video/mp4">',
     '<!-- 关卡挑战版：无音频，开场影片已移除（见 游戏/外壳.js） -->'),
    ('<script src="deck.js"></script>',
     '<!-- 关卡挑战版：deck.js 已接管 —— 卡数据进 游戏/卡库.js 丙段、卡面渲染进丁段；上游那份留作对照物 -->'),
    ('<script src="src/scripts/load.js"></script>',
     '<!-- 关卡挑战版：load.js 已摘（开场载入层由 游戏/外壳.js 与 elementsController 接管） -->'),
    ('<script src="src/scripts/fps.js"></script>',
     '<!-- 关卡挑战版：fps.js 已摘（requestAnimFrame 垫片只被它自己的计数循环用） -->'),
    ('<script src="src/scripts/pack_handler.js"></script>',
     '<!-- 关卡挑战版：pack_handler.js 已摘（我们没有开包入口） -->'),
    ('<script src="src/scripts/snow.js"></script>',
     '<!-- 关卡挑战版：snow.js 已摘（雪花装饰） -->'),
    ('<script src="src/scripts/time.js"></script>',
     '<!-- 关卡挑战版：time.js 已摘（右上角时钟） -->'),
    ('<script src="src/scripts/testing.js"></script>',
     '<!-- 关卡挑战版：testing.js 已摘（上游的黑盒自测入口；我们有自己的四套） -->'),
    ('<script src="src/scripts/window_focus.js"></script>',
     '<!-- 关卡挑战版：window_focus.js 已摘（切屏切 body.className，剥美术后无依赖） -->'),
    # ④ 批次 5（阶段 E，2026-10-03）：**敌方决策与三件废件出列**。
    #    摘之前照批次 0 的规矩查过"它挂过哪些全局量"（工具/全局审计.js）：
    #      · AI.js              —— 敌方决策。浏览器装探针跑完两个完整敌方回合，
    #                              `AI()` 与 `computerCardPlace()` **调用次数都是 0**：
    #                              这一拍早由 界面.js 的规划器接管。它挂的 `checkForLoss` 只有它自己用。
    #                              难度档位原本包在它身上（因此全废）→ 已搬进 游戏/决策.js。
    #      · card_effects.js    —— 出牌音效/效果，`cardPlaceSnds` 已被我们换掉（阶段 D），
    #                              `fadeOutInMusic` 只有它自己用。
    #      · fireworks.js       —— 胜利烟花，纯装饰；只被 `#fireworkCanvas` 那个 canvas 用。
    #      · preventInspectElement.js —— **这个文件在上游根本不存在**，标签每次加载必然 404 一次
    #                              （工具/启动.py 里写着这件事）；摘掉即少一个 404。
    ('<script src="src/scripts/AI.js"></script>',
     '<!-- 关卡挑战版：AI.js 已摘（敌方决策进了 游戏/决策.js；这里挂的 checkForLoss 只被它自己用） -->'),
    ('<script src="src/scripts/card_effects.js"></script>',
     '<!-- 关卡挑战版：card_effects.js 已摘（出牌效果由 游戏/界面.js 的执行器读效果表执行） -->'),
    ('<script src="src/scripts/fireworks.js"></script>',
     '<!-- 关卡挑战版：fireworks.js 已摘（胜利烟花是纯装饰） -->'),
    ('<script src="src/scripts/preventInspectElement.js"></script>',
     '<!-- 关卡挑战版：preventInspectElement.js 已摘（上游没有这个文件，标签每次必然 404） -->'),
    # ⑤ 阶段 F（2026-10-03）：**animations.css 出列**。
    #    实测（浏览器里逐条查 selector 匹配）：629 行 / 64 条规则里，只有 2 条（`.fadeOutAnim`
    #    与 `.zoomOutAnim`）能匹配到页面上的元素，而它们属于开场/菜单流程 —— 我们根本不走。
    #    真正被我们界面用到的两个动效（卡落位的缩放弹入、设置抽屉的开合）已用**我们自己的
    #    keyframes** 写进 游戏/样式.css（`.hs-deploy` 与 `#gamemenuContent.openMenuAnim`），
    #    其中卡的类名也一并换成了我们自己的。30 条 @keyframes 全都没人引用。
    ('<link rel="stylesheet" href="src/stylesheets/animations.css">',
     '<!-- 关卡挑战版：animations.css 已摘（两个界面动效已由 游戏/样式.css 用自己的 keyframes 实现） -->'),
]

MARKER = "关卡挑战版"


# 只随包分发这四个第三方文件；其余**页面已经不再加载**的，一律不进工程、不进包。
# 2026-10-04 用户决定：不再保留"上游"这个身份，能删的先删干净。
# 判据是**页面加载不加载**（不是"文件好不好看"）：下面这些都已经由我们自己的实现替代
#   · deck.js        → 卡数据进 游戏/卡库.js 丙段、卡面工厂进丁段
#   · animations.css → 两个界面动效改成我们自己的 keyframes（游戏/样式.css）
#   · AI.js          → 敌方决策进 游戏/决策.js（浏览器探针实测：它零调用）
#   · card_effects.js→ 出牌效果由 游戏/界面.js 的执行器读效果表执行
#   · fireworks / load / fps / pack_handler / snow / time / testing / window_focus
#                    → 批次 0 摘掉的废件（页面早已不加载）
# 仍在页面里、暂时仍需要的第三方代码只有：index.js · attack.js · elementsController.js · styles.css
不再分发 = {
    "deck.js",
    os.path.join("src", "stylesheets", "animations.css"),
    os.path.join("src", "scripts", "AI.js"),
    os.path.join("src", "scripts", "card_effects.js"),
    os.path.join("src", "scripts", "fireworks.js"),
    os.path.join("src", "scripts", "load.js"),
    os.path.join("src", "scripts", "fps.js"),
    os.path.join("src", "scripts", "pack_handler.js"),
    os.path.join("src", "scripts", "snow.js"),
    os.path.join("src", "scripts", "time.js"),
    os.path.join("src", "scripts", "testing.js"),
    os.path.join("src", "scripts", "window_focus.js"),
}


def copy_tree():
    copied = skipped = 0
    # 上游根 README 与我们的文档不同名了（我们的在 说明/ 下），但上游 README 仍要改名保住署名
    RENAME = {"README.md": "README-上游.md"}
    for dirpath, _dirs, files in os.walk(UPSTREAM):
        rel_dir = os.path.relpath(dirpath, UPSTREAM)
        for fn in files:
            rel = fn if rel_dir == "." else os.path.join(rel_dir, fn)
            dst_rel = RENAME.get(rel, rel)          # 先改名，再判是不是我们自己的文件
            if dst_rel in OURS or rel in 不再分发 or dst_rel in 不再分发:
                skipped += 1
                continue
            dst = os.path.join(HERE, dst_rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if os.path.exists(dst) and filecmp.cmp(os.path.join(dirpath, fn), dst, shallow=False):
                skipped += 1
                continue
            shutil.copy2(os.path.join(dirpath, fn), dst)
            copied += 1
    return copied, skipped


def strip_media():
    """删掉炉石的音频与全部美术目录。运行时的静音、去卡图、压平背景引用由 游戏/外壳.js 接管。

    幂等：目录不在就跳过。每次组装都会重跑一遍，所以复制回来的资源会被重新剥掉。
    """
    removed_files = removed_bytes = 0
    for rel in STRIP_DIRS:
        d = os.path.join(HERE, rel)
        if not os.path.isdir(d):
            continue
        for dirpath, _dirs, files in os.walk(d):
            for fn in files:
                removed_files += 1
                try:
                    removed_bytes += os.path.getsize(os.path.join(dirpath, fn))
                except OSError:
                    pass
        shutil.rmtree(d)
    return removed_files, removed_bytes


def patched_html():
    src = os.path.join(UPSTREAM, "index.html")
    with open(src, encoding="utf-8") as f:
        html = f.read()
    for 条 in INSERTS:
        anchor, added = 条[0], 条[1]
        where = 条[2] if len(条) > 2 else 'after'
        if anchor not in html:
            raise SystemExit(f"[ERROR] index.html 里找不到锚点：{anchor}")
        html = html.replace(anchor, (added + "\n" + anchor) if where == 'before'
                            else (anchor + "\n" + added), 1)
    for old, new in REPLACES:
        if old not in html:
            raise SystemExit(f"[ERROR] index.html 里找不到要替换的内容：{old}")
        html = html.replace(old, new, 1)
    # 顶部加一行注释，标明这是打过补丁的副本（可审计）
    # ⚠ 替换文本**不要以 \n 结尾** —— 原来那行 `<html lang="en">` 后面本身就跟着换行，
    #   多一个 \n 会在成品里多出一行空行，`--check` 会判定"与上游不一致"。
    #   另外注意 Python 的隐式字符串拼接：改多行字面量时必须**整段替换**，
    #   只换第一行会把剩下的半截默默接在后面（这个坑刚踩过一次，是 --check 抓出来的）。
    html = html.replace("<html lang=\"en\">",
                        f'<html lang="en">\n<!-- {MARKER}：相对上游只多了 1 个样式表（游戏/样式.css）、8 个 script 标签（游戏/外壳.js、事件.js、引擎.js、卡库.js、资源.js、决策.js、演出.js、界面.js），并摘掉开场影片、deck.js / AI.js / card_effects.js / fireworks.js 等已接管的脚本与两张样式表；我们的资源带内容版本号（?v=），改了就自动变，免得宿主缓存旧脚本。见 说明/1-怎么跑.md -->',
                        1)
    return html


def write_html():
    dst = os.path.join(HERE, "index.html")
    new = patched_html()
    old = open(dst, encoding="utf-8").read() if os.path.exists(dst) else None
    if old == new:
        return False
    with open(dst, "w", encoding="utf-8", newline="") as f:
        f.write(new)
    return True


def _norm_lines(text):
    """把「我们打的那几行」从文本里摘掉（按行、忽略缩进），用于与上游逐字节对比。

    摘掉的三类：
      · 我们插进去的 <script> 标签
      · 以 "<!-- 关卡挑战版" 开头的注释（顶部说明 + 影片那一行的替换结果）
      · 被替换掉的原行（开场影片的 <source>）
    """
    drop = set()
    for 条 in INSERTS:
        drop.update(l.strip() for l in 条[1].splitlines())
    drop.update(old.strip() for old, _new in REPLACES)
    out = []
    for line in text.splitlines():
        s = line.strip()
        if s in drop or s.startswith("<!-- " + MARKER):
            continue
        out.append(line)
    return out


def css_nested_comment_problems():
    """CSS 注释**不能嵌套**：一个 `/*` 之后遇到第一个 `*/` 就结束。

    在注释里顺手再写一句 `/* 青色底 */` 会**提前闭合注释**，后面的内容变成乱码，
    连紧跟其后的那条规则的选择器都被污染 —— 整条规则静默失效，症状极像"样式写对了却没生效"。
    实测踩过一次：`#manacontainer` 整条规则就这么没了，害得"法力槽看不见"查了半天。
    所以这里在组装时静态扫一遍，把这类错误挡在构建阶段。
    """
    problems = []
    for rel in [os.path.join("游戏", "样式.css"),
                os.path.join("src", "stylesheets", "animations.css")]:
        p = os.path.join(HERE, rel)
        if not os.path.exists(p):
            continue
        text = open(p, encoding="utf-8").read()
        depth = 0
        line = 1
        i = 0
        while i < len(text) - 1:
            if text[i] == "\n":
                line += 1
            pair = text[i:i + 2]
            if pair == "/*":
                depth += 1
                if depth > 1:
                    problems.append(
                        f"{rel}:{line} 注释里又出现了 /*（CSS 注释不能嵌套，会提前闭合并把后面的规则吃掉）")
                i += 2
                continue
            if pair == "*/":
                depth = max(0, depth - 1)
                i += 2
                continue
            i += 1
        if depth != 0:
            problems.append(f"{rel} 有未闭合的注释（少了一个 */）")
    return problems


def css_undefined_var_problems():
    """找出「用了但没定义」的 CSS 自定义属性。

    `left: var(--hs-battle-x)` 这种写错变量名的后果很隐蔽：**整条声明被丢弃**
    （不是退回 0，是整句没了），于是元素回落到上游的定位 —— 实测棋盘因此落在 x=0，
    而虚线格排在 x=85，卡片整体左偏 85px。查了半天才挖到。

    口径：定义 = 任意 CSS 文件里出现过 `--名字:`；使用 = 任意文件里的 `var(--名字`。
    带兜底的 `var(--名字, 默认值)` 不算问题。
    """
    css_files = [os.path.join("游戏", "样式.css"),
                 os.path.join("src", "stylesheets", "animations.css"),
                 "styles.css"]
    defined, used = set(), {}
    for rel in css_files:
        p = os.path.join(HERE, rel)
        if not os.path.exists(p):
            continue
        text = open(p, encoding="utf-8").read()
        # 必须先剥掉注释再扫 —— 否则"在注释里说明某个变量名"也会被算成一次使用
        text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
        defined.update(re.findall(r"(--[A-Za-z0-9_-]+)\s*:", text))
        for m in re.finditer(r"var\(\s*(--[A-Za-z0-9_-]+)\s*(,?)", text):
            name, has_fb = m.group(1), m.group(2)
            if not has_fb:                       # 带兜底的跳过
                used.setdefault(name, set()).add(rel)
    return [f"CSS 变量用了但没定义：{n}（出现在 {'、'.join(sorted(fs))}）—— 该条声明会被静默丢弃"
            for n, fs in sorted(used.items()) if n not in defined]


# 纯逻辑文件的硬约束：引擎与事件层不许碰宿主环境，也不许有非确定性来源。
# 它们必须能在 node 里裸跑（这样才有「同一份标准对局 → 同一个末态哈希」这回事）。
# 见 说明/6-架构-重构第二版.md §二.1、说明/5-架构-重构探索.md §八.C。
PURE_FILES = [os.path.join("游戏", "引擎.js"), os.path.join("游戏", "事件.js")]
FORBIDDEN = ["document", "window", "Date.now", "Math.random", "localStorage", "setTimeout"]


def pure_logic_problems():
    problems = []
    for rel in PURE_FILES:
        p = os.path.join(HERE, rel)
        if not os.path.exists(p):
            continue                      # 阶段 1 之前还不存在，不算问题
        text = open(p, encoding="utf-8").read()
        text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)      # 剥块注释
        text = re.sub(r"//[^\n]*", "", text)                   # 剥行注释
        for bad in FORBIDDEN:
            if re.search(r"(?<![\w.$])" + re.escape(bad) + r"(?![\w$])", text):
                problems.append(f"{rel} 里出现了 {bad} —— 引擎/事件层必须是纯逻辑（不碰 DOM、不用全局时钟、不用随机）")
    return problems


def check():
    problems = (css_nested_comment_problems() + css_undefined_var_problems()
                + pure_logic_problems())

    # 1) index.html 的补丁
    dst = os.path.join(HERE, "index.html")
    if not os.path.exists(dst):
        problems.append("index.html 不存在（先跑一次组装）")
    else:
        html = open(dst, encoding="utf-8").read()
        up = open(os.path.join(UPSTREAM, "index.html"), encoding="utf-8").read()
        for 条 in INSERTS:
            for line in 条[1].splitlines():
                if line not in html:
                    problems.append(f"index.html 缺少 {line}")
        # 顺序：外壳 → 卡库 → index.js → AI.js → 演出 → 界面
        order = [html.find(t) for t in ORDER]
        if -1 in order:
            problems.append("脚本标签顺序检查失败：有标签找不到")
        elif order != sorted(order):
            problems.append("脚本标签顺序不对：应为 " + " → ".join(ORDER))
        for old, _new in REPLACES:
            if old in html:
                problems.append("index.html 里开场影片那一行没被替换掉")
        if _norm_lines(html) != _norm_lines(up):
            problems.append("index.html 除插入行与影片那行外与上游不一致（有人改过别的地方？）")

    # 2) **仍在分发的第三方代码**有没有被就地改动（应该一字未改）。
    #    ⚠ 这份清单 = 「页面还在加载的第三方文件」，不是"看着眼熟的文件"：
    #    已经由我们自己的实现替代的（deck.js / AI.js / card_effects.js / animations.css …）**不再分发**，
    #    也就不再参与这条校验 —— 它们连工程里都不该有（见 不再分发）。
    for rel in ["index.js", "styles.css", os.path.join("src", "scripts", "attack.js"),
                os.path.join("src", "scripts", "elementsController.js")]:
        a = os.path.join(UPSTREAM, rel)
        b = os.path.join(HERE, rel)
        if not os.path.exists(b):
            problems.append(f"缺文件：{rel}")
        elif not filecmp.cmp(a, b, shallow=False):
            problems.append(f"上游文件被改动了（本应一字未改）：{rel}")

    # 2b) 我们自己的脚本不该再留在 src/ 里（阶段 0 已搬进 游戏/）
    for rel in OURS:
        if rel.startswith("src" + os.sep):
            problems.append(f"关卡层文件还留在上游目录里：{rel}")

    # 3) 关卡层文件在位
    for rel in sorted(OURS):
        if rel.endswith(".py") or rel.endswith(".md"):
            continue
        if not os.path.exists(os.path.join(HERE, rel)):
            problems.append(f"关卡层文件缺失：{rel}")

    # 4) 炉石的音频与美术必须已经剥净
    for rel in STRIP_DIRS:
        if os.path.isdir(os.path.join(HERE, rel)):
            problems.append(f"炉石美术/音频目录还在（应当已剥掉）：{rel}/")
    # 剥完之后 src/ 下只应剩 scripts 与 stylesheets
    left = sorted(os.listdir(os.path.join(HERE, "src"))) if os.path.isdir(os.path.join(HERE, "src")) else []
    if left and left != ["scripts", "stylesheets"]:
        problems.append(f"src/ 下还有多余目录：{left}（应当只剩 scripts 与 stylesheets）")

    # 5) 外壳.js 必须在 index.js 之前 —— 否则静音、去卡图、压平背景引用都晚了一步
    if os.path.exists(dst):
        html = open(dst, encoding="utf-8").read()
        if html.find("游戏/外壳.js") > html.find('src="index.js"'):
            problems.append("游戏/外壳.js 排在 index.js 之后：静音与去卡图会失效")

    return problems


def main():
    only_check = "--check" in sys.argv
    if not only_check:
        if not os.path.isdir(UPSTREAM):
            raise SystemExit(f"[ERROR] 找不到上游源码目录：{UPSTREAM}")
        copied, skipped = copy_tree()
        changed = write_html()
        print(f"[组装] 复制 {copied} 个上游文件，跳过 {skipped} 个；"
              f"index.html {'已更新' if changed else '无变化'}")
        if "--keep-media" in sys.argv:
            print("[剥资源] 已跳过（--keep-media）")
        else:
            n, b = strip_media()
            print(f"[剥资源] 删除 {n} 个炉石美术/音频文件，共 {b / 1048576:.1f} MB")

    problems = check()
    if problems:
        print("\n[校验] 发现问题：")
        for p in problems:
            print("  ✗", p)
        return 1
    print("[校验] 通过：index.html 补丁正确 · 上游代码一字未改 · 关卡层文件齐全 · "
          "炉石美术与音频已剥净 · 引擎/事件层保持纯逻辑")
    return 0


if __name__ == "__main__":
    sys.exit(main())
