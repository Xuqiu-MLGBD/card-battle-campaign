# -*- coding: utf-8 -*-
"""临时：量一量 关卡挑战版 的体积，判断「能不能塞进 MMD 卡」。"""
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "关卡挑战版")

CODE_EXT = {".js", ".html", ".css"}
ASSET_EXT = {".jpg", ".jpeg", ".png", ".gif", ".ico", ".mp3", ".ogg", ".wav", ".mp4", ".ttf", ".svg"}


def utf16(s):
    return len(s.encode("utf-16-le")) // 2


code = assets = other = 0
code_files = []
big = []
for dirpath, dirs, files in os.walk(ROOT):
    dirs[:] = [d for d in dirs if d not in {"node_modules"}]
    for fn in files:
        p = os.path.join(dirpath, fn)
        sz = os.path.getsize(p)
        ext = os.path.splitext(fn)[1].lower()
        if ext in CODE_EXT:
            code += sz
            rel = os.path.relpath(p, ROOT)
            with open(p, encoding="utf-8", errors="replace") as f:
                code_files.append((utf16(f.read()), sz, rel))
        elif ext in ASSET_EXT:
            assets += sz
            big.append((sz, os.path.relpath(p, ROOT)))
        else:
            other += sz

total = code + assets + other
print(f"合计        {total / 1048576:8.1f} MB")
print(f"  代码      {code / 1048576:8.2f} MB   (js/html/css)")
print(f"  资源      {assets / 1048576:8.1f} MB   (图/音/字体/影片)")
print(f"  其它      {other / 1048576:8.2f} MB")
print()
print("代码文件按 UTF-16 长度排（MMD 沙盒门禁 = 单条规则 18000 UTF-16）")
for u, sz, rel in sorted(code_files, reverse=True)[:12]:
    flag = "  ← 超门禁" if u > 18000 else ""
    print(f"  {u:>7} UTF-16  {sz/1024:7.1f} KB  {rel}{flag}")

over = [c for c in code_files if c[0] > 18000]
print()
print(f"超过 18000 门禁的代码文件：{len(over)} / {len(code_files)}")
print(f"代码文件合计 UTF-16：{sum(c[0] for c in code_files)}")

print()
print("最大的 10 个资源：")
for sz, rel in sorted(big, reverse=True)[:10]:
    print(f"  {sz/1048576:7.2f} MB  {rel}")
