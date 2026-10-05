# -*- coding: utf-8 -*-
"""发布到 GitHub（关卡挑战版 → 一个仓库）

为什么做成脚本：挂 GitHub 只差"授权 + 建仓 + 推送"三步，但每一步都有坑
（身份没配 / 远程已存在 / 换行被改写 / 把 备份/ 一起推上去）。这里一次做完，并逐条报状态。

用法：
    python 工具/发布到GitHub.py                 # 默认：私有，仓库名 card-battle-campaign
    python 工具/发布到GitHub.py --public
    python 工具/发布到GitHub.py --name 我的仓库名
    python 工具/发布到GitHub.py --dry           # 只看检查结果，不建仓不推送

前置（只需一次）：装好 Git 与 GitHub CLI，并登录一次 —— 脚本会告诉你怎么登。
"""
import argparse
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))          # 关卡挑战版/工具


def _找游戏根(起):
    d = 起
    for _ in range(5):
        if os.path.isfile(os.path.join(d, "游戏", "外壳.js")):
            return d
        d = os.path.dirname(d)
    return 起


ROOT = _找游戏根(HERE)                     # 关卡挑战版
项目 = os.path.dirname(ROOT)               # 开源卡牌案例（= 仓库根）


def 找程序(名, 候选):
    p = shutil.which(名)
    if p:
        return p
    for c in 候选:
        if os.path.isfile(c):
            return c
    return None


GIT = 找程序("git", [r"C:\Program Files\Git\cmd\git.exe"])
GH = 找程序("gh", [r"C:\Program Files\GitHub CLI\gh.exe"])


def 跑(命令, 允许失败=False):
    r = subprocess.run(命令, cwd=项目, capture_output=True)
    出 = (r.stdout or b"").decode("utf-8", "ignore") + (r.stderr or b"").decode("utf-8", "ignore")
    if r.returncode != 0 and not 允许失败:
        raise SystemExit("[出错] 命令失败：" + " ".join(命令) + "\n" + 出.strip())
    return r.returncode, 出.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="card-battle-campaign")
    ap.add_argument("--public", action="store_true", help="默认私有；加这个才是公开")
    ap.add_argument("--dry", action="store_true", help="只体检，不建仓不推送")
    a = ap.parse_args()

    print("== 体检 ==")
    if not GIT:
        raise SystemExit("✗ 没找到 git。装一个：winget install --id Git.Git -e")
    if not GH:
        raise SystemExit("✗ 没找到 GitHub CLI。装一个：winget install --id GitHub.cli -e")
    print("✓ git  " + GIT)
    print("✓ gh   " + GH)
    print("✓ 仓库根 " + 项目)

    # 登录状态
    _, 状态 = 跑([GH, "auth", "status"], 允许失败=True)
    登录了 = "Logged in to" in 状态 or "✓ Logged in" in 状态
    if not 登录了:
        print("\n✗ 还没登录 GitHub。请先在你的终端里跑这一条（会开浏览器，约 30 秒）：\n")
        print("    " + GH + " auth login --hostname github.com --git-protocol https --web\n")
        print("  登录完再跑一次本脚本即可（其余步骤它自动做）。")
        return 2
    账号 = ""
    m = re.search(r"account\s+([0-9A-Za-z-]+)", 状态)
    if m:
        账号 = m.group(1)
    print("✓ 已登录" + ("：" + 账号 if 账号 else ""))

    # 本地仓库
    _, 分支 = 跑([GIT, "rev-parse", "--abbrev-ref", "HEAD"], 允许失败=True)
    if "fatal" in 分支 or not 分支:
        print("· 还没有本地仓库，初始化并提交一个")
        跑([GIT, "init", "-b", "main"])
        跑([GIT, "add", "-A"])
        跑([GIT, "commit", "-q", "-m", "首个提交"])
    print("✓ 本地分支：" + 分支)

    # 身份：用账号的 noreply 邮箱（提交才会挂到你头像上）
    if 账号:
        跑([GIT, "config", "user.name", 账号])
        跑([GIT, "config", "user.email", 账号 + "@users.noreply.github.com"])
        # ⚠ 只在**还没推送过**的时候改写作者。
        #   第一版每跑一次都 `--amend --reset-author`，于是"首提交"的哈希每次都变 ——
        #   推过一次之后再跑，本地与远端就**分叉**（ahead 2 / behind 1），还得强推。
        #   判据：远端有没有 main 这个分支（没有 = 从没推过）。
        未推过 = "main" not in 跑([GIT, "ls-remote", "--heads", "origin", "main"], 允许失败=True)[1]
        if 未推过:
            跑([GIT, "commit", "--amend", "--no-edit", "--reset-author", "-q"], 允许失败=True)
            print("✓ 提交作者已设为 " + 账号 + "（尚未推送，改写安全）")
        else:
            print("· 已经推过远端，不动历史（作者若不对，用 git commit --amend 手动改）")

    # 大件体检：备份/ 与构建产物**不该**进仓库
    _, 清单 = 跑([GIT, "ls-files"])
    不许 = [f for f in 清单.splitlines() if f.startswith("备份/") or f.startswith("展示-关卡挑战版/")]
    if 不许:
        raise SystemExit("✗ 这些不该进仓库（先清掉再发布）：\n  " + "\n  ".join(不许[:10]))
    print("✓ 仓库内文件 %d 个，无备份/无构建产物" % len(清单.splitlines()))

    # 网络：本机常有一个本地代理（Clash 之类）监听在 7897/7890 ——
    # 实测过"api.github.com 通、github.com 连接被重置"这种半边通：gh 能建仓、git push 却挂。
    # 所以**发现本机代理就只给这个仓库配上**（不写全局配置，免得代理一关别的仓库全挂）。
    for 端口 in (7897, 7890, 10809, 1080):
        try:
            import socket
            s = socket.socket()
            s.settimeout(0.3)
            if s.connect_ex(("127.0.0.1", 端口)) == 0:
                s.close()
                if not 跑([GIT, "config", "--get", "http.proxy"], 允许失败=True)[1]:
                    跑([GIT, "config", "http.proxy", "http://127.0.0.1:%d" % 端口])
                    跑([GIT, "config", "https.proxy", "http://127.0.0.1:%d" % 端口])
                    print("✓ 检测到本机代理 127.0.0.1:%d，已给本仓库配上（仅本仓库）" % 端口)
                break
            s.close()
        except Exception:
            pass

    if a.dry:
        print("\n（--dry：到此为止，没有建仓也没有推送）")
        return 0

    # 建远程仓库并推
    可见 = "--public" if a.public else "--private"
    # ⚠ 判断"远程有没有这个仓库"必须看**退出码**，不能看输出里有没有某个词 ——
    #   gh 失败时的报错文本是 "…could not resolve to a Repository with the name …"，
    #   里面就带 name（第一版这么写，于是把"不存在"当成"已存在"，推了个 404）。
    码, 已有 = 跑([GH, "repo", "view", a.name, "--json", "name"], 允许失败=True)
    描述 = "自己写架构的单人卡牌闯关网页游戏 + MMD 沙盒同层卡（纯前端 · 无构建 · 无联机）"
    远程 = "https://github.com/" + (账号 or "") + "/" + a.name + ".git"
    if 码 == 0:
        print("· 远程仓库已存在，直接推")
    else:
        # ⚠ 不用 `gh repo create --source <目录>`：它在中文路径下会误判"不是 git 仓库"
        #   （实测报 "…is not a git repository"，而 `git rev-parse` 明明是 true）。
        #   改成"建空仓 + 自己加 remote + push"，三步都走 git，稳。
        跑([GH, "repo", "create", a.name, 可见, "--description", 描述])
        print("✓ 已建仓（空）")
    if "origin" not in 跑([GIT, "remote"], 允许失败=True)[1]:
        跑([GIT, "remote", "add", "origin", 远程])
    else:
        跑([GIT, "remote", "set-url", "origin", 远程])
    跑([GIT, "push", "-u", "origin", "main"])
    print("✓ 已推送")
    print("  https://github.com/" + (账号 or "") + "/" + a.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
