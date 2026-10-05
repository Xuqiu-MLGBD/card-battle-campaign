/* 卡牌对战 · 事件层（纯逻辑）
 * ===============================================================
 * 这一层管三件事，全部**不碰宿主环境**（不许出现 document/window/Date.now/Math.random ——
 * 由 工具/组装.py 的「纯逻辑检查」在构建期挡住，见 说明/5-架构-重构探索.md §八.C）：
 *
 *   ① **事件**：确实发生了什么（不可变、带顺序号与因果链）。四类：
 *        rules     规则事件（伤害/死亡/抽牌…）—— 影响状态
 *        triggered 由规则事件派生的触发        —— 影响状态
 *        system    回合/阶段/优先权/堆叠        —— 影响状态
 *        fx        纯表现（飘字/镜头）          —— **绝不进规则**，只为让演出层有东西可播
 *   ② **变更 Mutation**：怎么落到状态上（可重放的最小操作集）。事件是"叙事"，变更是"施工图"。
 *   ③ **席位投影**：对手的手牌/牌库是隐藏信息，同一条事件流按视角投影后才给界面或 bot。
 *
 * 为什么要这么分：一旦"状态由动画播完才提交"，跳过/加速/重连就会改变规则推进的时机。
 * 正确的关系是「状态立刻提交（权威）+ 动画只是游标」—— 事件里带 fx 类就是为了
 * 让表现有东西可播，而不必让表现污染规则。
 */
(function (G) {
  'use strict';

  var 版本 = 1;

  /* 事件的四个类别。只有前三类会改变状态。 */
  var 类别 = { 规则: 'rules', 触发: 'triggered', 系统: 'system', 表现: 'fx' };

  /* ============================ 稳定串 / 哈希 ============================ */

  /* 规范 JSON：对象键**排序**后输出。哈希必须与键的书写顺序无关，
     否则"同一状态、只是属性顺序变了"会算出两个哈希，回归基线就废了。 */
  function 稳定串(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Object.prototype.toString.call(v) === '[object Array]') {
      var parts = [];
      for (var i = 0; i < v.length; i++) parts.push(稳定串(v[i]));
      return '[' + parts.join(',') + ']';
    }
    var keys = Object.keys(v).sort();
    var out = [];
    for (var k = 0; k < keys.length; k++) {
      out.push(JSON.stringify(keys[k]) + ':' + 稳定串(v[keys[k]]));
    }
    return '{' + out.join(',') + '}';
  }

  /* FNV-1a 32 位，跑两轮（不同偏移基）拼成 16 位十六进制。
     不用 Math.random、不用时间戳 —— 同一状态永远同一个哈希。 */
  function 哈希(v) {
    var s = typeof v === 'string' ? v : 稳定串(v);
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = (h1 ^ c) >>> 0;
      h1 = (h1 * 16777619) >>> 0;
      h2 = (h2 + c) >>> 0;
      h2 = (h2 ^ (h2 << 5)) >>> 0;
    }
    function hex8(n) { var t = (n >>> 0).toString(16); while (t.length < 8) t = '0' + t; return t; }
    return hex8(h1) + hex8(h2);
  }

  function 深拷贝(v) { return JSON.parse(JSON.stringify(v)); }

  /* ============================== 变更 ============================== */

  /* 变更的操作集刻意**很小** —— 少到每一条都能一眼看懂、也都能精确重放。
     路径是一串键：['players','p0','hp']。数组下标就是数字键。
       置    路径 ← 值                （覆盖/新建）
       删    删掉路径上的键
       压入  数组末位追加一项
       抽出  数组第「序号」项移除（返回被抽掉的那项）
     为什么「置」而不是「加/减」：加法在重放时依赖"读到的当前值"，
     一旦顺序有偏差就会越滚越远；「置」是幂等的 —— 重放两次和一次结果相同。 */
  function 应用(状态, 变更表) {
    var s = 深拷贝(状态);
    for (var i = 0; i < 变更表.length; i++) {
      var m = 变更表[i];
      var 路径 = m.路径;
      var 父 = s;
      for (var k = 0; k < 路径.length - 1; k++) 父 = 父[路径[k]];
      var 末 = 路径[路径.length - 1];
      if (m.op === '置') 父[末] = 深拷贝(m.值);
      else if (m.op === '删') { if (Object.prototype.toString.call(父) === '[object Array]') 父.splice(末, 1); else delete 父[末]; }
      else if (m.op === '压入') 父[末].push(深拷贝(m.值));
      else if (m.op === '抽出') 父[末].splice(m.序号, 1);
      else throw new Error('[事件] 不认识的变更操作：' + m.op);
    }
    return s;
  }

  function 校验变更(变更表) {
    var 问题 = [];
    for (var i = 0; i < 变更表.length; i++) {
      var m = 变更表[i];
      if (['置', '删', '压入', '抽出'].indexOf(m.op) < 0) 问题.push('第 ' + i + ' 条操作不认识：' + m.op);
      if (Object.prototype.toString.call(m.路径) !== '[object Array]' || !m.路径.length) {
        问题.push('第 ' + i + ' 条缺少路径');
      }
    }
    return 问题;
  }

  /* ============================== 事件日志 ============================== */

  /* 顺序号是**逻辑时间**（只用它排序），时间戳只给人看 —— 所以这里根本不记时间戳。
     id 由顺序号派生（不是随机数），于是"同一串命令 → 同一串事件 id"，回归基线才可比。 */
  function 建日志(起始序号) {
    var 序号 = 起始序号 || 0;
    var 表 = [];
    var 当前链 = null;

    return {
      序号: function () { return 序号; },
      开链: function (名) { 当前链 = 名; },
      闭链: function () { 当前链 = null; },
      /* 推一条事件。因果：cause=父事件 id，chain=同一次命令的后果链。 */
      推: function (e) {
        var 条 = 深拷贝(e);
        条.序号 = 序号;
        条.id = 'e' + 序号;
        条.链 = (e.链 !== undefined ? e.链 : 当前链);
        if (条.类别 === undefined) 条.类别 = 类别.规则;
        序号 += 1;
        表.push(条);
        return 条;
      },
      全部: function () { return 表; },
      条数: function () { return 表.length; }
    };
  }

  /* ============================== 席位投影 ============================== */

  /* 隐藏信息（对手抽到什么牌 / 牌库内容）**从数据层就分开** ——
     否则将来做联机或录像要重写。事件里用「隐藏字段」列出对别家不可见的键，
     投影时把它们换成占位串，并打上 .遮蔽 = true（界面据此画"背面"）。 */
  var 遮蔽占位 = '？（隐藏）';

  function 投影(事件表, 席位) {
    var out = [];
    for (var i = 0; i < 事件表.length; i++) {
      var e = 事件表[i];
      var 隐藏字段 = e.隐藏字段;
      if (!隐藏字段 || !隐藏字段.length || e.席位 === undefined || e.席位 === 席位) {
        out.push(e);
        continue;
      }
      var 副本 = {};
      for (var k in e) if (Object.prototype.hasOwnProperty.call(e, k)) 副本[k] = e[k];
      副本.遮蔽 = true;
      for (var j = 0; j < 隐藏字段.length; j++) {
        var f = 隐藏字段[j];
        if (副本[f] !== undefined) 副本[f] = 遮蔽占位;
      }
      out.push(副本);
    }
    return out;
  }

  /* ============================== 契约自查 ============================== */

  /* 给测试与构建期用：事件表本身要满足的几条不变量。 */
  function 校验事件(事件表) {
    var 问题 = [];
    var 已见 = {};
    var 上一条序号 = -1;
    for (var i = 0; i < 事件表.length; i++) {
      var e = 事件表[i];
      if (typeof e.序号 !== 'number') 问题.push('第 ' + i + ' 条没有顺序号');
      if (e.序号 <= 上一条序号) 问题.push('第 ' + i + ' 条顺序号没有递增：' + e.序号);
      上一条序号 = e.序号;
      if (!e.id) 问题.push('第 ' + i + ' 条没有 id');
      if (已见[e.id]) 问题.push('id 重复：' + e.id);
      已见[e.id] = true;
      if (类别.规则 !== e.类别 && 类别.触发 !== e.类别 && 类别.系统 !== e.类别 && 类别.表现 !== e.类别) {
        问题.push('第 ' + i + ' 条类别不合法：' + e.类别);
      }
      if (类别.表现 === e.类别 && e.改状态) 问题.push('表现类事件不许改状态：' + e.id);
    }
    return 问题;
  }

  G.HS_EVENT = {
    版本: 版本,
    类别: 类别,
    遮蔽占位: 遮蔽占位,
    稳定串: 稳定串,
    哈希: 哈希,
    深拷贝: 深拷贝,
    应用: 应用,
    校验变更: 校验变更,
    建日志: 建日志,
    投影: 投影,
    校验事件: 校验事件
  };
})(globalThis);
