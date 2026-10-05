# -*- coding: utf-8 -*-
"""量单价：一张卡 / 一个词条各占多少 UTF-16，用来算"再加 60 张卡 + 10 个词条"的增量。"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "关卡挑战版")
PACKER = os.path.join(os.path.dirname(HERE), "scripts", "pack_card.py")
import importlib.util
spec = importlib.util.spec_from_file_location("pack_card", PACKER)
pc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pc)
utf16 = pc.utf16len

src = pc.read(os.path.join(ROOT, "游戏", "卡库.js"))

# ① 卡表块：从 "var 卡表 = {" 到第一处深度归零的 "};"
i = src.index("var 卡表 = {")
深, j = 0, i
while j < len(src):
    if src[j] == '{':
        深 += 1
    elif src[j] == '}':
        深 -= 1
        if 深 == 0:
            break
    j += 1
块 = src[i:j + 1]
张 = len(re.findall(r"'[^']+': \{ 费", 块))
总 = utf16(块)
print("① 效果表（卡库.js 丙段）")
print(f"   整块 {总} UTF-16 / {张} 张卡  →  平均每张 **{总 / 张:.0f} UTF-16**")
说明 = sum(utf16(m) for m in re.findall(r"说明: '[^']*'", 块))
print(f"   其中「说明」文案 {说明} UTF-16（{100 * 说明 / 总:.0f}%，去掉说明每张省 {说明 / 张:.0f}）")

# ② 一个卡牌条目的最小/最大样本
entries = re.findall(r"'[^']+': \{[\s\S]*?\},?\n", 块)
sizes = sorted((utf16(e), e.split(':')[0]) for e in entries)
if sizes:
    print(f"   最省的一张 {sizes[0][0]} UTF-16 {sizes[0][1]} ／ 最贵的一张 {sizes[-1][0]} UTF-16 {sizes[-1][1]}")

# ③ 60 张卡的增量
平均 = 总 / 张
print()
print("② 增量估算（按上表平均价）")
print(f"   +60 张卡 ≈ +{平均 * 60:.0f} UTF-16  →  约 {平均 * 60 / 18000:.2f} 条规则（18000 档）")
print(f"   再 +10 个「反击」这类关键词（每张卡多 20~30 UTF-16）≈ +{25 * 10:.0f} UTF-16，可忽略")
print()
print("   总代码量会从 490,929 → 约 {:,} UTF-16".format(int(490929 + 平均 * 60)),
      f"→ 规则数下限 {int((490929 + 平均 * 60) // 18000) + 1} 条（现 28），仍远低于 130")

# ④ 词条（世界书）单价：进的是 character_book，不进正则规则
print()
print("③ 世界书词条（不进正则规则，只吃「公开发布」的 15000 字预算）")
for 字 in (200, 400, 800, 1500):
    print(f"   若每个词条正文 {字} 字 → 10 个 = {字 * 10} 字；"
          f"加上人设（按 800 字）合计 {字 * 10 + 800} 字"
          f" → {'✗ 超 15000' if 字 * 10 + 800 > 15000 else '✓ 在 15000 内'}"
          f"（留 2000~3000 缓冲则 {'✗ 超' if 字 * 10 + 800 > 12000 else '✓ 稳'}）")
