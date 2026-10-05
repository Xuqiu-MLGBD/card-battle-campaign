# -*- coding: utf-8 -*-
"""开演示站：让仓库首页那条链接点开就能直接玩（GitHub Pages）

为什么需要它：GitHub 不会把仓库里的 index.html 当网页跑（点开只看到源码），
必须启用 Pages；而**免费账号下 Pages 只对公开仓库开放** —— 所以"能点开就玩"
这个功能的前提是把仓库转公开。这一步会改变代码的可见性，因此：
  · 默认只做 `--dry` 体检，**不动可见性、不开 Pages**；
  · 明确加 `--公开` 才转公开并启用 Pages（可用 `--私有` 再转回来）。

用法（在 关卡挑战版/ 下）：
    python 工具/开演示站.py            # 体检：现在能不能开、开了会给什么链接
    python 工具/开演示站.py --公开      # 转公开 + 启用 Pages + 等首次部署完，打印试玩链接
    python 工具/开演示站.py --私有      # 反悔：转回私有（Pages 会随之失效）
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def _找项目根(起):
    """往上找含 .git 的那一层当项目根（工具收进 工具/ 后，别把 cwd 算错）。"""
    d = 起
    for _ in range(5):
        if os.path.isdir(os.path.join(d, ".git")):
            return d
        d = os.path.dirname(d)
    return os.path.dirname(起)


项目 = _找项目根(HERE)


def 找程序(名, 候选):
    from shutil import which
    p = which(名)
    if p:
        return p
    for c in 候选:
        if os.path.isfile(c):
            return c
    return None


GH = 找程序("gh", [r"C:\Program Files\GitHub CLI\gh.exe"])
GIT = 找程序("git", [r"C:\Program Files\Git\cmd\git.exe"])


def 环境():
    """把 Git 的目录塞进 PATH 再调 gh/git。
    ⚠ 实测坑：`gh repo view` 会**内部调用 git**（在仓库目录里时用它解析仓库）；
      而这个脚本的 PATH 可能还是安装 Git 之前那份 —— 于是 gh 报
      "unable to find git executable in PATH"（看起来像 gh 坏了，其实是找不到 git）。"""
    e = os.environ.copy()
    if GIT:
        e["PATH"] = os.path.dirname(GIT) + os.pathsep + e.get("PATH", "")
    return e


def 跑(命令, 允许失败=False):
    r = subprocess.run(命令, cwd=项目, capture_output=True, env=环境())
    出 = (r.stdout or b"").decode("utf-8", "ignore") + (r.stderr or b"").decode("utf-8", "ignore")
    if r.returncode != 0 and not 允许失败:
        raise SystemExit("[出错] " + " ".join(命令) + "\n" + 出.strip())
    return r.returncode, 出.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--公开", action="store_true", help="转公开（Pages 在免费账号下只支持公开仓库）")
    ap.add_argument("--私有", action="store_true", help="转回私有（演示站会失效）")
    ap.add_argument("--dry", action="store_true", help="只看状态，不改任何东西")
    a = ap.parse_args()
    if not GH:
        raise SystemExit("✗ 没找到 gh（GitHub CLI）。装：winget install --id GitHub.cli -e")

    _, 仓库 = 跑([GH, "repo", "view", "--json", "nameWithOwner,visibility,url,homepageUrl"], 允许失败=True)
    try:
        信息 = json.loads(仓库)
    except Exception:
        raise SystemExit("✗ 取不到仓库信息（这个目录还不是 GitHub 仓库？先跑 工具/发布到GitHub.py）")
    全名 = 信息["nameWithOwner"]
    账号 = 全名.split("/")[0]
    仓库名 = 全名.split("/")[1]
    链接 = "https://%s.github.io/%s/" % (账号.lower(), 仓库名)
    print("仓库：" + 全名 + "（" + 信息["visibility"] + "）")
    print("试玩链接会是：" + 链接)

    # Pages 现状
    码, 页 = 跑([GH, "api", "repos/%s/pages" % 全名], 允许失败=True)
    有页 = (码 == 0)
    print("Pages：" + ("已启用（" + (json.loads(页).get("html_url") or 链接) + "）" if 有页 else "未启用"))

    if a.私有:
        跑([GH, "api", "-X", "PATCH", "repos/" + 全名, "-f", "private=true"])
        print("✓ 已转回私有（演示站随之失效；代码可能已被别人克隆过，这点改不回来）")
        return 0

    if not a.公开:
        print("\n体检结论：")
        if 信息["visibility"] == "PRIVATE":
            print("  · 仓库现在是**私有**，免费账号下 Pages 用不了 —— 想开演示站要转公开：")
            print("      python 工具/开演示站.py --公开")
            print("  · 不想公开：可以保留私有，改用 Cloudflare Pages / Netlify 从私有仓库部署（要给它们账号授权）。")
        else:
            print("  · 仓库是公开的，直接跑 `python 工具/开演示站.py --公开` 即可启用 Pages（不改可见性）。")
        return 0

    if 信息["visibility"] == "PRIVATE":
        跑([GH, "api", "-X", "PATCH", "repos/" + 全名, "-f", "private=false"])
        print("✓ 已转为公开仓库")

    # 启用 Pages：build_type=workflow 表示"由 Actions 部署"（对应 .github/workflows/pages.yml）
    if not 有页:
        码, 出 = 跑([GH, "api", "-X", "POST", "repos/%s/pages" % 全名, "-f", "build_type=workflow"], 允许失败=True)
        if 码 != 0 and "already" not in 出:
            print("· 启用 Pages 时报：" + 出[:200])
            print("  （若是套餐限制：公开仓库才免费；企业/私有需 Pro）")
        else:
            print("✓ 已启用 Pages（Actions 部署）")
    else:
        print("· Pages 已启用，跳过")

    # 触发一次部署（工作流文件得先推上去）
    跑([GIT, "push"], 允许失败=True)
    跑([GH, "workflow", "run", "pages.yml"], 允许失败=True)
    print("· 已触发部署，等它跑完（约 1 分钟）…")
    for i in range(24):
        time.sleep(5)
        码, 状 = 跑([GH, "run", "list", "--workflow", "pages.yml", "--limit", "1", "--json", "status,conclusion"], 允许失败=True)
        try:
            条 = json.loads(状)[0]
        except Exception:
            条 = {}
        if 条.get("status") == "completed":
            print("· 部署结果：" + str(条.get("conclusion")))
            break
    print("\n点开就能玩：" + 链接)
    print("（首屏可能要等十几秒，GitHub 首次发布有缓存）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
