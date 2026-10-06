# -*- coding: utf-8 -*-
"""建沙盒卡.py —— 把「关卡挑战版」打成一张**能实装游玩**的沙盒同层卡（6 键导入 JSON）

和上一轮 `尝试进卡.py` 的区别：那次只是"把整页代码塞进正则"（结论写在 MMD-适配说明 §6.4：
**json 能导入但跑不起来** —— 缺骨架、且没走 SDK 舞台）。这一次补上那三块：

  ① **骨架**：从 index.html 抽出 body 里的 DOM（`#game`/`#cards`/`#opposinghero`…），
     作为一个模块注入（`window.HS_SKELETON`），由 `游戏/沙盒.js` 在游戏脚本之前塞进舞台根节点。
  ② **SDK 适配**：`游戏/沙盒.js`（舞台开关 / 返回原生 / 页内换关 / 存档）。
  ③ **换关不再重载**：`卡库.js` 抽出 `HS_APPLY_LEVEL()`、`外壳.js` 留 `HS_RESTART_HOOK` 与
     `CAMPAIGN_REBOOT()`、`界面.js` 留 `HS_UI_REBOOT()` —— 沙盒里换关必须页内完成。

两个打包期的变换（都要可验证）：
  · **剥 JS 注释**：我们的源码注释很厚（几万 UTF-16），而规则额度是按长度算的。
    剥完仍按文件边界装箱；每个模块剥完都要过 `node --check`（语法不对就当场报错）。
  · **给 CSS 加根前缀**：上游 `styles.css` 里有 `body` / `*` 这类全局选择器，
    直接注入会把平台聊天页一起改掉 ✗。所以把选择器统统前缀成 `#hs-sandbox-root …`
    （`html/body/:root` → 根节点自己；`@media` 递归；`@keyframes/@font-face` 原样留）。

用法：python 建沙盒卡.py            # 产物落在 输出/关卡挑战版-沙盒卡.json
"""
import importlib.util
import io
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _找游戏根(起):
    """往上找到**含 游戏/外壳.js 的那一层**当游戏根。
    工具已统一收进 游戏树/工具/ 下，这样脚本不论放在哪儿都自己认路。"""
    d = 起
    for _ in range(5):
        if os.path.isfile(os.path.join(d, "游戏", "外壳.js")):
            return d
        d = os.path.dirname(d)
    return 起


ROOT = _找游戏根(HERE)                       # 游戏树（含 游戏/ 的那一层）
项目根 = os.path.dirname(ROOT)               # 含 关卡挑战版/ 与 输出/ 的那一层
OUT = os.path.join(项目根, "输出")
WORK = os.path.join(项目根, "工作-沙盒卡")    # 中间产物落在项目根（不与游戏树混）
PACKER = os.path.join(os.path.dirname(项目根), "scripts", "pack_card.py")
if not os.path.exists(PACKER):               # 独立树/展示包里：用工具目录里那份副本
    PACKER = os.path.join(HERE, "pack_card.py")

spec = importlib.util.spec_from_file_location("pack_card", PACKER)
pc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pc)
utf16 = pc.utf16len

# ── 加载顺序 = 真实顺序（沙盒里没有 index.html 的 <script> 标签，顺序全靠这张表） ──
MODULES = [
    "OUT-构建戳",                    # 打包期生成：`window.HS_BUILD` —— 和网页 ?v= 同源的构建戳
    "OUT-骨架",                      # 打包期生成：骨架字符串（必须最先，游戏脚本加载期就要 DOM）
    "游戏/沙盒.js",                   # SDK 适配层（建根 + 注入骨架；舞台开关；页内换关；存档）
    "游戏/外壳.js", "游戏/事件.js", "游戏/引擎.js", "游戏/卡库.js",
    "游戏/回合.js", "游戏/查找.js", "游戏/菜单.js", "游戏/资源.js", "游戏/决策.js", "游戏/文案.js", "游戏/检错.js", "游戏/状态.js", "游戏/演出.js", "游戏/界面.js",
]
CSS = ["游戏/样式.css"]      # 2026-10-05 批次 E：styles.css 已出列（声明迁进 游戏/样式.css）
根选择器 = "#hs-sandbox-root"
上限 = 20000          # 单条规则的**硬口径**：用户 2026-10-05 要求"导出后每条 ≤ 20000 字符"（编辑器上限）。
                      # 宿主还有一条更高的硬上限（导入路径 100000），但我们按更严的那条走。
                      # 做法见下面 分片/切CSS：过大的模块切成"字符串片 + 载入器"，CSS 按括号平衡切片 ——
                      # **架构不变**（同一份源码、同一个闭包、加载顺序不变），只是分几条规则运输。


# ─────────────────────────────────────────────────────────────── 骨架
def 抽骨架():
    """从 index.html 的 <body> 里抽 DOM。

    ⚠ 用**字符串切**而不是正则：第一版写的是 `re.search(r"<body[^>]*>(.*)</body>", html, re.S)`，
      结果只抓到一半（骨架从 `#mainmenu` 开始、到 `#computerTurn` 就断了）—— 而游戏缺了
      `#contents`/`#game` 就完全跑不起来。所以这里改成按**首尾锚点**切，并加一条断言：
      抽出来必须含 `id="contents"` / `id="game"` / `id="cards"`，缺一个就当场报错（别等装上卡白屏）。

    ⚠ 用户上游那份 index.html 的结构**不是**标准的：`<div id="contents">`（装 `#vs` 与双方名字标签）
      出现在 `</head>` 与 `<body>` **之间**，所以按 `<body>…</body>` 切永远抓不到它 ——
      而游戏缺了 `#contents` 就完全跑不起来（`#game` 宽 0、血量读不出来、自检 ①⑥⑨ 全红）。
      这里改成**从 `</head>` 之后一直切到 `</body>`**，并加一条断言：抽出来必须含
      `id="contents"` / `id="game"` / `id="cards"` / `id="opposinghero"`，缺一个就当场报错。

    留 inline <script>（它定义了 showGameMenu，我们的「设置」按钮在调它）；
    去掉所有外链 <script src> / <link>（那些由规则注入）。"""
    html = pc.read(os.path.join(ROOT, "index.html"))
    a = html.find("</head>")
    b = html.rfind("</body>")
    if a < 0 or b < 0 or b < a:
        raise SystemExit("[ERROR] index.html 里找不到 </head>…</body>")
    body = html[a + len("</head>"):b]
    body = re.sub(r'<script[^>]*\ssrc="[^"]*"[^>]*>\s*</script>\s*', "", body)     # 外链脚本
    body = re.sub(r'<link[^>]*>\s*', "", body)                                     # 样式表
    body = re.sub(r'<video[^>]*cinematicVideo[^>]*>.*?</video>\s*', "", body, flags=re.S)
    for 必须有 in ['id="contents"', 'id="game"', 'id="cards"', 'id="opposinghero"']:
        if 必须有 not in body:
            raise SystemExit("[ERROR] 抽出来的骨架缺 " + 必须有 + " —— 这样装上去游戏跑不起来")
    return body.strip()


def 写骨架模块(body):
    os.makedirs(WORK, exist_ok=True)
    p = os.path.join(WORK, "骨架.js")
    with io.open(p, "w", encoding="utf-8") as f:
        # 用 JSON 转义（含 </script> 的安全化：把 < 转成 \u003c，免得字符串里出现 </script> 截断规则）
        s = json.dumps(body, ensure_ascii=False).replace("<", "\\u003c")
        f.write("/* 打包期生成：index.html 的 body 骨架（见 建沙盒卡.py）。不要手改。 */\n")
        f.write("window.HS_SKELETON = " + s + ";\n")
    return p


# ─────────────────────────────────────────────────────────────── 剥注释
def 剥注释(js):
    """去掉 /* */ 与 // 注释。**不碰字符串 / 模板串 / 正则字面量**。
    判正则：前一个有意义字符是 ( , = : [ ! & | ? { } ; + - * % ~ ^ 或 return/typeof 之类的关键字。"""
    out, i, n = [], 0, len(js)
    前一个 = ""            # 上一个有意义字符
    while i < n:
        c = js[i]
        # 字符串
        if c in "\"'":
            j = i + 1
            while j < n:
                if js[j] == "\\":
                    j += 2
                    continue
                if js[j] == c:
                    break
                j += 1
            out.append(js[i:j + 1]); i = j + 1; 前一个 = c
            continue
        # 模板串（含 ${} 内嵌，简化处理：整体照抄到收尾反引号）
        if c == "`":
            j = i + 1
            while j < n:
                if js[j] == "\\":
                    j += 2
                    continue
                if js[j] == "`":
                    break
                j += 1
            out.append(js[i:j + 1]); i = j + 1; 前一个 = "`"
            continue
        # 注释
        if c == "/" and i + 1 < n and js[i + 1] == "*":
            j = js.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c == "/" and i + 1 < n and js[i + 1] == "/":
            j = js.find("\n", i)
            i = n if j < 0 else j
            continue
        # 正则字面量
        if c == "/" and (前一个 == "" or 前一个 in "(,=:[!&|?{};+-*%~^<>"):
            j = i + 1; 类 = False
            while j < n:
                ch = js[j]
                if ch == "\\":
                    j += 2; continue
                if ch == "[":
                    类 = True
                elif ch == "]":
                    类 = False
                elif ch == "/" and not 类:
                    break
                elif ch == "\n":
                    break
                j += 1
            j += 1
            while j < n and js[j].isalpha():
                j += 1
            out.append(js[i:j]); i = j; 前一个 = "/"
            continue
        out.append(c)
        if not c.isspace():
            前一个 = c
        i += 1
    # 注释块被挖掉后会留下连续空行，压一下（行号不再有意义，报错看的是 node --check 的结论）
    s = "".join(out)
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s


def 处理模块(rel):
    p = os.path.join(ROOT, rel)
    src = pc.read(p)
    if rel.endswith(".js"):
        src = 剥注释(src)
        # 语法必须过 —— 剥注释剥坏了要在这里当场发现，而不是等到装上卡白屏
        os.makedirs(WORK, exist_ok=True)
        t = os.path.join(WORK, "_check.js")
        with io.open(t, "w", encoding="utf-8") as f:
            f.write(src)
        r = subprocess.run(["node", "--check", t], capture_output=True)
        if r.returncode != 0:
            raise SystemExit("[ERROR] 剥注释之后语法不对：" + rel + "\n" + r.stderr.decode("utf-8", "ignore")[:800])
    return src


# ─────────────────────────────────────────────────────────────── CSS 根前缀
def 前缀选择器(sel):
    """只给**全局/裸元素**选择器加根前缀，id/class 选择器原样留。

    为什么不全加前缀（第一版就是全加，实测挂了两处）：
      · 我们的面板（主页面、关卡浮层、任务区…）是**挂在 document.body 上**的，不在根节点里 ——
        全加前缀之后它们一条样式都拿不到，页面直接是"裸 HTML"✗；
      · 上游 `elementsController.js` 也会往 body 上加节点（`#load`/`#gamemenu`/提示气泡…），同一个问题。
    只前缀 `*` / `html` / `body` / 裸标签名，就把"会污染平台聊天页"的那几条挡住了
    （`body` 背景、`*` 字体、`button`/`img` 外观），而 `#game`/`.cardinplay`/`#load` 这些
    只可能命中我们自己的东西 —— 平台聊天页不会用这些 id/class。"""
    sel = sel.strip()
    if not sel:
        return sel
    if sel.startswith(根选择器):
        return sel
    if ":root" in sel:
        # `:root` 是**文档根**，在我们的根节点里永远匹配不到 —— 直接把它换成根节点自己。
        # （第一版漏了这一步，产出的是后代选择器 `#hs-sandbox-root :root` → 整块 `--hs-*` 变量全废：
        #  实测症状是 `#game` 宽 0、格宽 0、血量位置全歪 —— 沙盒里那几条自检红的共同根因。）
        sel = sel.replace(":root", "").strip()
        if not sel:
            return 根选择器
        if sel.startswith((">", "+", "~")):
            return 根选择器 + " " + sel
        return sel if sel.startswith(("#", ".", "[")) else (根选择器 + " " + sel)
    if sel in ("html", "body", "*") or re.match(r"^(html|body)\b", sel):
        tail = re.sub(r"^(html|body)\b\s*", "", sel).strip()
        if not tail:
            return 根选择器
        return (根选择器 + " " + tail) if not tail.startswith((">", "+", "~")) else (根选择器 + tail)
    # 裸标签名 / 裸通配（可带伪类）：button、img:hover、*::after、div > span…
    首 = re.match(r"^([a-zA-Z*][a-zA-Z0-9-]*)(?=[^a-zA-Z0-9_-]|$)", sel)
    if 首:
        return 根选择器 + " " + sel
    return sel          # 以 # 或 . 或 [ 打头 → 是我们自己的东西，原样


def 前缀CSS(css):
    out, i, n = [], 0, len(css)
    while i < n:
        c = css[i]
        if c == "@":
            # @ 规则：@media / @supports 要递归；@keyframes / @font-face / @charset / @import 原样
            m = re.match(r"@([a-zA-Z-]+)", css[i:])
            名 = m.group(1).lower() if m else ""
            起 = i
            深 = 0
            j = i
            while j < n:
                if css[j] == "{":
                    深 += 1
                elif css[j] == "}":
                    深 -= 1
                    if 深 == 0:
                        break
                elif css[j] == ";" and 深 == 0:
                    break
                j += 1
            段 = css[起:j + 1]
            if 名 in ("media", "supports", "container", "layer"):
                头 = 段[:段.index("{") + 1]
                身 = 段[段.index("{") + 1:-1]
                out.append(头 + 前缀CSS(身) + "}")
            else:
                out.append(段)
            i = j + 1
            continue
        if c == "}":
            out.append(c); i += 1; continue
        # 普通规则：选择器 { … }
        j = css.find("{", i)
        if j < 0:
            out.append(css[i:]); break
        选择器 = css[i:j]
        选择器 = ",".join(前缀选择器(x) for x in 选择器.split(","))
        k = css.find("}", j)
        体 = css[j:k + 1] if k >= 0 else css[j:] + "}"
        # 体里可能有嵌套 @media（极少），这里原样带过
        out.append(选择器 + 体)
        i = (k + 1) if k >= 0 else n
    return "".join(out)


def 处理CSS(rel):
    css = pc.read(os.path.join(ROOT, rel))
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)         # 先剥注释（CSS 的注释不影响选择器）
    return 前缀CSS(pc.minify_css(css))


# ─────────────────────────────────────────────────────────────── 打包
def 写构建戳模块():
    """生成 `window.HS_BUILD` 模块 —— 与网页 `?v=` **同一个哈希**（都取自 组装.py 的 runtime_version()）。

    为什么沙盒卡需要它：沙盒里没有 `<script src>`（脚本由规则注入），报告里"脚本版本"那一行
    本来会是空的，排查时说不清"这份报告是哪次构建跑出来的"。有了这行，网页与沙盒报同一个戳。
    做法：直接 import 组装.py 取它的 V（那个模块级常量就是运行时内容哈希）—— 不在两处各算一遍，
    免得"戳"和 `?v=` 对不上（那比没有更糟）。"""
    spec = importlib.util.spec_from_file_location("组装", os.path.join(ROOT, "工具", "组装.py"))
    模 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(模)
    t = os.path.join(WORK, "构建戳.js")
    with io.open(t, "w", encoding="utf-8") as f:
        f.write('window.HS_BUILD="%s";\n' % 模.V)
    return t


# ─────────────────────────────────────────────── 分片：让**每条规则**都 ≤ 20000
# 用户 2026-10-05 的要求：导出后每条正则条目都不超过 20000 字符（编辑器的上限），**总体架构不变**。
#
# 难处在 JS：模块内部共享一个闭包（`界面.js` 有上百个闭包变量），按函数拆成独立模块意味着
# 要把这些变量搬进命名空间 —— 那是伤筋动骨的重构，而且会破坏"同一份源码、同一段加载顺序"。
# 所以这里走**数据分片**：把整份源码当作字符串，分几条规则运进去，最后一条规则把字符串拼回来
# 再 `(0,eval)` 执行 —— 同一个 IIFE、同一个闭包、加载位置不变，只是"运输方式"换了。
# （平台自己就是用 `(0,eval)` 执行规则里的脚本的，所以这条路在沙盒里是通的。）
#
# CSS 则简单：在**规则边界**切片，每片一个独立标记（同一条标记在沙盒里只会生效一次）。
单条上限 = 20000        # 用户要的口径：导出后每条 ≤ 20000 字符
片预算 = 15000          # 每片原始字符预算（留出 JSON 转义与包装的余量）


def 分片(源码, 名):
    """把一份源码切成若干条"字符串片"。每片形如：
         window.__hsP_x=window.__hsP_x||[];window.__hsP_x.push("<一段源码>");
       字符串用 JSON 转义（引号/反斜杠安全），并把 `<` 写成 \\u003c（免得平台按 </script> 提前截断）。"""
    键 = "__hsP_" + re.sub(r"[^0-9A-Za-z]", "_", 名)
    片 = []
    for i in range(0, len(源码), 片预算):
        段 = 源码[i:i + 片预算]
        字面 = json.dumps(段, ensure_ascii=False).replace("<", "\\u003c")
        片.append('window.%s=window.%s||[];window.%s.push(%s);' % (键, 键, 键, 字面))
    return 片


def 载入器(名):
    """把分片拼回来执行（`(0,eval)` 在全局作用域跑我们那份 IIFE），然后**把字符串删掉**。
       用 `delete` 而不是置 null：导出本局信息里会把 window 上的残留列出来，留着 null 键会被误当成"没清干净"。"""
    键 = "__hsP_" + re.sub(r"[^0-9A-Za-z]", "_", 名)
    return '(0,eval)(window.%s.join(""));\ntry{ delete window["%s"]; }catch(e){ window["%s"]=null; }\n' % (键, 键, 键)


def 切CSS(整):
    """CSS 按"**括号平衡**的 `}` 边界"切片：只在一层花括号收完处断，
    绝不断在 `@media { … }` 中间（那会让这一片整块失效）。"""
    片, 起, 深 = [], 0, 0
    for i, ch in enumerate(整):
        if ch == "{":
            深 += 1
        elif ch == "}":
            深 -= 1
            if 深 <= 0 and (i + 1 - 起) >= 片预算:
                片.append(整[起:i + 1])
                起, 深 = i + 1, 0
    if 起 < len(整):
        片.append(整[起:])
    return [p for p in 片 if p.strip()] or [整]


def 当前源码版本():
    """当前源码的构建戳 = 组装.py 的 runtime_version()（与网页 `?v=` 同源）。"""
    spec = importlib.util.spec_from_file_location("组装", os.path.join(ROOT, "工具", "组装.py"))
    模 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(模)
    return 模.V


def 卡里的版本(路径):
    """从已生成的卡 JSON 里读出构建戳（没有就返回 None）。"""
    try:
        s = io.open(路径, encoding="utf-8").read()
    except OSError:
        return None
    m = re.search(r'HS_BUILD=\\?"([0-9a-f]{6,})', s)
    return m.group(1) if m else None


def 校验卡():
    """`--check`：**源码与卡对不对得上**。

    为什么必须有一道这样的闸（2026-10-04 用户转来的建议，一针见血）：
      卡里的 JS 是**构建期内联**的 —— 改了源码不重打包，卡里就还是旧代码，
      于是"我这边测的是新代码、他那边跑的是旧卡"，而**两边看起来都正常**。
      更坏的是旧代码里的 bug（例如 状态.js 往不存在的路径写）会一直被"实测"到，
      让人以为修没生效。构建戳就是为了让这件事**可判定**：卡里的 `HS_BUILD`
      必须等于当前源码的哈希。不等 = 卡过期，重新打包再导入。"""
    版本 = 当前源码版本()
    卡 = os.path.join(OUT, "关卡挑战版-沙盒卡.json")
    if not os.path.exists(卡):
        print("[校验卡] ✗ 还没有卡：先跑 python 建沙盒卡.py")
        return 1
    里 = 卡里的版本(卡)
    if not 里:
        print("[校验卡] ✗ 卡里没有构建戳（是旧版卡，或打包时没走 写构建戳模块）")
        return 1
    if 里 != 版本:
        print("[校验卡] ✗ 卡过期：卡里 %s，当前源码 %s" % (里, 版本))
        print("          → 跑 python 建沙盒卡.py 重新打包，再重新导入")
        return 1
    print("[校验卡] ✓ 源码与卡一致（构建戳 %s）" % 版本)
    return 0


def main():
    if "--check" in sys.argv:
        raise SystemExit(校验卡())
    os.makedirs(WORK, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)

    body = 抽骨架()
    骨架 = 写骨架模块(body)
    戳 = 写构建戳模块()

    mods = []
    for rel in MODULES:
        if rel == "OUT-构建戳":
            mods.append({"name": "构建戳", "file": os.path.relpath(戳, WORK)})
            continue
        if rel == "OUT-骨架":
            mods.append({"name": "骨架", "file": os.path.relpath(骨架, WORK)})
            continue
        src = 处理模块(rel)
        名 = os.path.splitext(os.path.basename(rel))[0]
        safe = re.sub(r"[^0-9A-Za-z\u4e00-\u9fa5]+", "-", rel).strip("-")
        包 = "<script>%s</script>" % src
        if utf16(包) <= 单条上限:
            t = os.path.join(WORK, safe + ".js")
            with io.open(t, "w", encoding="utf-8") as f:
                f.write(src)
            mods.append({"name": 名, "file": os.path.relpath(t, WORK)})
            continue
        # ★ 过大模块：切成"字符串片 + 载入器"（见 分片说明 的注释）
        for k, 片 in enumerate(分片(源码=src, 名=safe), 1):
            t = os.path.join(WORK, "%s-片%d.js" % (safe, k))
            with io.open(t, "w", encoding="utf-8") as f:
                f.write(片)
            mods.append({"name": "%s片%d" % (名, k), "file": os.path.relpath(t, WORK)})
        t = os.path.join(WORK, safe + "-载入.js")
        with io.open(t, "w", encoding="utf-8") as f:
            f.write(载入器(safe))
        mods.append({"name": "%s载入" % 名, "file": os.path.relpath(t, WORK)})

    csss = []
    for i, rel in enumerate(CSS):
        safe = re.sub(r"[^0-9A-Za-z\u4e00-\u9fa5]+", "-", rel).strip("-")
        整 = 处理CSS(rel)
        for k, 段 in enumerate(切CSS(整), 1):
            t = os.path.join(WORK, "%s-%d.css" % (safe, k))
            with io.open(t, "w", encoding="utf-8") as f:
                f.write(段)
            # ⚠ 每条 CSS 规则必须有自己的标记：打包器默认标记是 `/{{party-css}}/`，
            #    而沙盒里**同一条标记只会生效一次** —— 两条共用就等于第二条整块丢失。
            #    （上一轮 尝试进卡.py 在 9 段 CSS 上踩过同一个坑：改了标记才出得来。）
            csss.append({"file": os.path.relpath(t, WORK),
                         "name": "样式%d-%d" % (i + 1, k),
                         "find": "/{{hs-css-%d-%d}}/" % (i + 1, k)})

    配置 = {
        "_note": "由 开源卡牌案例/建沙盒卡.py 生成 —— 沙盒同层卡（完整网页游戏）",
        "chatVersion": 1, "pageDepth": 2,
        "statusbar": "🃏 卡牌对战 · 点一下打开牌桌",
        "beginning": "（这张卡里有一张牌桌。）\n\n"
                     "五关阶梯：第一关双方各只有 1 个部署位，第二关 2 个，一直到第五关 5 个，"
                     "逐关解锁；另有自由对练，双方各 1 / 3 / 5 格随你挑。\n\n"
                     "花色与身材都照炉石那套：每回合涨一点法力、出一张牌、打一次，"
                     "打人不挨反击，除非对面写着「反击」；出手要付体力，没出手的回合结束会回血。\n\n"
                     "牌桌会自己结算胜负，你只管出牌。想回去说话，点右上角「返回原生界面」。",
        "personality": "（见同目录 人设-卡牌对战.txt，导入后手工粘贴进人设框）",
        "modules": mods,
        "css": csss,
        "idBase": -1,
        "splitThreshold": 单条上限,      # 打包器的门禁 = 用户要的口径（导出后每条 ≤ 20000）
    }
    配置路径 = os.path.join(WORK, "配置.json")
    with io.open(配置路径, "w", encoding="utf-8") as f:
        json.dump(配置, f, ensure_ascii=False, indent=1)

    输出 = os.path.join(OUT, "关卡挑战版-沙盒卡.json")
    r = subprocess.run([sys.executable, PACKER, 配置路径, "--out", 输出, "--verbose"],
                       capture_output=True)
    txt = r.stdout.decode("utf-8", "ignore") + r.stderr.decode("utf-8", "ignore")
    print(txt.strip()[-4000:])
    if r.returncode != 0:
        raise SystemExit("[ERROR] 打包器失败")

    j = json.load(io.open(输出, encoding="utf-8"))
    超 = [(x["scriptName"], utf16(x["replaceString"])) for x in j["regex_scripts"] if utf16(x["replaceString"]) > 上限]
    print("\n[体检] 顶层键：%s（%d 个）" % (", ".join(j.keys()), len(j)))
    print("[体检] 规则数：%d（硬上限 130）" % len(j["regex_scripts"]))
    print("[体检] 单条最长：%d UTF-16（硬口径 %d＝用户要求：导出后每条 ≤ 20000 字符；宿主单条真上限 100000）"
          % (max(utf16(x["replaceString"]) for x in j["regex_scripts"]), 上限))
    print("[体检] 超门禁的规则：%s" % (超 if 超 else "无"))
    print("[产物] " + 输出)


if __name__ == "__main__":
    main()
