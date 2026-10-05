# -*- coding: utf-8 -*-
"""做时序仿真.py —— 生成一个"像真实平台那样装卡"的测试页。

为什么要它：本地 `build-preview.py` 是把卡的内容在 **DOMContentLoaded 之前**装好的，
而真实 MMD 沙盒是**装卡时整卡抽取、页面加载完之后才执行脚本**（技能指南里写的）。
两种时序的差别会掩盖真 bug —— 2026-10-03 实测踩到：真实平台上 `外壳.js` 跑在 `卡库.js`
之前，`CAMPAIGN_DATA` 还没挂上，boot 直接 return → 主页面不建、上游 Play/Tutorial 菜单照旧显示
（用户截图原话"怎么是旧页面啊"）；而这个 bug 在本地仿真里**完全看不见**。

所以这个页做一件事：`load` 事件之后再按顺序把每条规则里的 <style>/<script> 注进去。
产物：工作-沙盒卡/仿真-装卡后注入.html
"""
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
JSON = os.path.join(os.path.dirname(os.path.dirname(HERE)), "输出", "关卡挑战版-沙盒卡.json")
OUT = os.path.join(HERE, "仿真-装卡后注入.html")   # 夹具就地产在 工具/ 下（可重建）

j = json.load(io.open(JSON, encoding="utf-8"))
规则 = []
for r in j["regex_scripts"]:
    s = r["replaceString"]
    片 = []
    for m in re.finditer(r"<style>([\s\S]*?)</style>", s):
        片.append({"kind": "style", "code": m.group(1)})
    for m in re.finditer(r"<script>([\s\S]*?)</script>", s):
        片.append({"kind": "script", "code": m.group(1)})
    if not 片:
        片.append({"kind": "raw", "code": s})
    规则.append({"名": r["scriptName"], "片": 片})

HTML = """<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>时序仿真：页面加载完之后才装卡（模拟真实 MMD 沙盒）</title>
<style>
 html,body{height:100%%;margin:0;background:#0b0f16;color:#8fa0b5;font:14px system-ui}
 #主机{padding:12px}
 #日志{margin-top:8px;white-space:pre-wrap;font:12px ui-monospace,Consolas,monospace;color:#6f8098}
</style></head>
<body>
<div id="主机">模拟平台：本页**加载完之后**才把卡的规则注进来（真实沙盒就是这么干的）。</div>
<div id="日志"></div>
<script>
/* 平台没有 sdk（下面这个假 sdk 只为让适配层不空转） */
window.sdk = {
  stage: {
    _el: (function () {
      var e = document.createElement('div'); e.id = 'fake-stage';
      e.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:1;';
      document.body.appendChild(e); return e;
    })(),
    _open: false,
    el: function () { return this._el; },
    open: function (m) { this._open = true; this._mode = m; this._el.style.display = 'block'; },
    close: function () { this._open = false; this._el.style.display = 'none'; },
    visible: function () { return this._open; }
  },
  save: { get: function () { return null; }, set: function () {}, remove: function () {} },
  cache: { get: function () {}, set: function () {} },
  on: function () {}, message: {}, input: {}, role: {}, user: {}
};
var 规则 = __RULES__;
function 记(t) { var e = document.getElementById('日志'); e.textContent += t + '\\n'; }
window.addEventListener('load', function () {
  记('页面 load 了（此刻才开始装卡）');
  规则.forEach(function (r) {
    r['片'].forEach(function (p) {
      if (p.kind === 'style') {
        var st = document.createElement('style'); st.textContent = p.code; document.head.appendChild(st);
      } else if (p.kind === 'script') {
        var sc = document.createElement('script'); sc.textContent = p.code; document.body.appendChild(sc);
      }
    });
    记('注入规则：' + r['名']);
  });
  记('装完。下面这几条就是"真机能不能玩"的判据：');
  记('  我们的主页面 #hs-mainmenu：' + (document.getElementById('hs-mainmenu') ? '有' : '没有 ✗'));
  记('  上游主菜单 #mainmenu 隐藏了吗：' + (function () { var m = document.getElementById('mainmenu'); return m ? getComputedStyle(m).display : '（没有）'; })());
  记('  CAMPAIGN_DATA / HS_CARDS：' + (typeof window.CAMPAIGN_DATA) + ' / ' + (typeof window.HS_CARDS));
  记('  HS_SANDBOX / CAMPAIGN_BOOT：' + (typeof window.HS_SANDBOX) + ' / ' + (typeof window.CAMPAIGN_BOOT));
});
</script>
</body></html>
"""

with io.open(OUT, "w", encoding="utf-8") as f:
    f.write(HTML.replace("__RULES__", json.dumps(规则, ensure_ascii=False)))
print("[OK] " + OUT + "（%d 条规则，%d 片）" % (len(规则), sum(len(r["片"]) for r in 规则)))
