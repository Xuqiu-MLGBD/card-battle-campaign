/* 关卡挑战版 · 敌方决策（游戏/决策.js —— 阶段 E）
 * =====================================================================
 * 上游那份 `AI.js` 有 52KB、一千多行，靠一堆 DOM 读数分支决定"打谁、谁去打"。
 * 到 2026-10-03 这一轮它**已经事实上死了**：敌方那一拍早就由我们的规划器
 * （界面.js 的 `planEnemyTurn` + 我们自己的 `应用一次攻击` / `playFromEnemyHand`）接管，
 * 浏览器里装探针跑完两个完整回合，`AI()` 与 `computerCardPlace()` **一次都没被调用**。
 *
 * 但"死"不等于"没事"：**难度档位当时是包在它俩身上的**（外壳.js 的 patchAI / patchCardPlace），
 * 包在死函数上等于**三个档位全部失效** —— 1~5 关的对手其实一直用同一套决策在打。
 * 这个文件就是把档位搬回我们自己手里（"全部转为自定内容"里敌方那一块）。
 *
 * 设计口径：
 *   · **纯函数**：只吃"描述符"（费用 / 攻击力 / 血量 / 嘲讽 / 是不是英雄），不碰 DOM ——
 *     所以能像引擎那样在 node 里直接测（`test_campaign.mjs` 的 C 段就是这么测的）；
 *   · **随机源可注入**（`设随机`）：自测里用固定序列，页面里就是 `Math.random`；
 *   · 档位的三条语义**照上游原本给它们定的意思**写，不额外加戏：
 *       0 新手 —— 一半概率整回合发呆；出牌从"出得起的"里**随机**挑；打谁也在合法集合里随机
 *       1 熟练 —— 上游原样：费用**恰好等于**法力上限的优先，否则第一张
 *                 （⚠ 连它"不检查付不付得起"这个毛病一起保留，免得悄悄改难度）
 *       2 大师 —— 出牌挑**费用最高**的；攻击优先换掉**攻击力最高**的那只
 */
(function (W) {
  'use strict';
  if (W.HS_DECIDE) return;

  var 随机 = (W.Math && W.Math.random) ? function () { return W.Math.random(); } : function () { return 0.5; };
  var 档 = 1;

  function 设档(t) { 档 = (t === 0 || t === 2) ? t : 1; return 档; }
  function 设随机(fn) { 随机 = (typeof fn === 'function') ? fn : 随机; }
  function 掷() { return 随机(); }
  function 取整(n) { return Math.floor(n); }

  /* 新手档：整回合发呆吗（上游 patchAI 的语义：一半概率什么都不做） */
  function 要发呆() { return 档 === 0 && 掷() < 0.5; }

  /* 出牌：候选 = 按**手牌/牌库顺序**给的 [{费}]，返回**下标**；−1 = 这回合不出牌 */
  function 选手牌(候选, 上限) {
    if (!候选 || !候选.length) return -1;
    if (要发呆()) return -1;
    var 可出 = [];
    for (var i = 0; i < 候选.length; i++) {
      if (候选[i] && typeof 候选[i].费 === 'number' && 候选[i].费 <= 上限) 可出.push(i);
    }
    if (档 === 1) {
      /* 上游原样：恰好等于上限的那张优先（照它自己的写法，**不看**付不付得起） */
      for (var j = 0; j < 候选.length; j++) if (候选[j] && 候选[j].费 === 上限) return j;
      return 0;
    }
    if (!可出.length) return -1;
    if (档 === 2) {
      var 最高 = 可行(候选, 可出, function (a, b) { return 候选[b].费 > 候选[a].费; });
      var 并列 = 可出.filter(function (x) { return 候选[x].费 === 候选[最高].费; });
      return 并列[取整(掷() * 并列.length) % 并列.length];
    }
    return 可出[取整(掷() * 可出.length) % 可出.length];            // 档 0：随机
  }

  /* 在候选下标里挑"最"的一个：比(a, b) 为真表示 b 更优 */
  function 可行(候选, 下标, 比) {
    var 最好 = 下标[0];
    for (var i = 1; i < 下标.length; i++) if (比(最好, 下标[i])) 最好 = 下标[i];
    return 最好;
  }

  /* 攻击：攻方 = [{i, 攻}]，目标 = [{i, 血量, 攻, 嘲讽, 英雄}]，返回 {攻方, 目标} 或 null */
  function 选攻击(攻方, 目标) {
    if (!攻方 || !攻方.length || !目标 || !目标.length) return null;
    var 出手 = null, 最大 = -1;
    for (var i = 0; i < 攻方.length; i++) {
      var a = 攻方[i];
      if (!a || !(a.攻 > 0)) continue;
      if (a.攻 > 最大) { 最大 = a.攻; 出手 = a; }
      else if (a.攻 === 最大 && 档 === 0 && 掷() < 0.5) 出手 = a;    // 新手：一样强的随机挑一只
    }
    if (!出手) return null;

    var 嘲讽 = [];
    for (var k = 0; k < 目标.length; k++) if (目标[k] && 目标[k].嘲讽) 嘲讽.push(目标[k]);
    var 池 = 嘲讽.length ? 嘲讽 : 目标;                             // 有嘲讽必须先打嘲讽

    if (档 === 0) {                                                // 新手：合法集合里随机（不算"换掉"）
      return { 攻方: 出手.i, 目标: 池[取整(掷() * 池.length) % 池.length].i };
    }
    var 能杀 = [];
    for (var m = 0; m < 池.length; m++) {
      var t = 池[m];
      if (t && !t.英雄 && t.血量 > 0 && t.血量 <= 最大) 能杀.push(t);
    }
    if (能杀.length) {
      var 挑 = 能杀[0];
      for (var n = 1; n < 能杀.length; n++) {
        var 更优 = (档 === 2) ? ((能杀[n].攻 || 0) > (挑.攻 || 0))       // 大师：先拆掉最狠的那只
                              : (能杀[n].血量 < 挑.血量);                // 熟练：捡血最少的
        if (更优) 挑 = 能杀[n];
      }
      return { 攻方: 出手.i, 目标: 挑.i };
    }
    for (var h = 0; h < 池.length; h++) if (池[h] && 池[h].英雄) return { 攻方: 出手.i, 目标: 池[h].i };
    return { 攻方: 出手.i, 目标: 池[0].i };
  }

  /* 选目标（架构改进 D：决策统一出口）。
     原来这条策略住在 界面.js 的 `机器人选目标()` 里 —— 于是"谁该选"在 界面、
     "怎么选"在 界面、而"选牌/选攻击"在 决策，决策逻辑被拆成两半。
     现在收到这里：**纯函数**（吃描述符，不碰 DOM），所以能在 node 里直接测。

     目标 = [{ i, 席位, 攻, 血量, 嘲讽, 英雄 }]；返回下标，−1 = 一个都不合适。
     口径（沿用原来的、且与"这条效果是帮谁的"一致）：
       伤害 / 消灭 / 冻结 → 砸对方（先挑能打死的，再挑血最少的；英雄排在后面）
       治疗 / 加成      → 给自己人（优先随从，没有随从才给英雄）
     兜底：都不匹配就取第一个 —— **绝不返回"什么都不选"**（那会让战吼凭空落空）。 */
  function 选目标(席位, 效, 目标) {
    if (!目标 || !目标.length) return -1;
    var 打对面 = (效 && (效.动作 === '伤害' || 效.动作 === '消灭' || 效.动作 === '冻结'));
    var 候选 = [];
    for (var i = 0; i < 目标.length; i++) {
      var t = 目标[i];
      if (!t) continue;
      if (打对面 && t.席位 !== 席位) 候选.push(t);
      if (!打对面 && t.席位 === 席位) 候选.push(t);
    }
    if (!候选.length) return 目标[0].i;
    /* 打对面：能一击打死的最优（血量 ≤ 攻击力），其次血最少的随从，最后才轮到英雄 */
    if (打对面) {
      var 能杀 = 候选.filter(function (t) { return !t.英雄 && t.血量 > 0 && 血量可杀(t); });
      if (能杀.length) return 能杀.sort(function (a, b) { return (a.血量 - b.血量); })[0].i;
      var 随从 = 候选.filter(function (t) { return !t.英雄; });
      if (随从.length) return 随从.sort(function (a, b) { return (a.血量 - b.血量); })[0].i;
      return 候选[0].i;                       // 只剩英雄 → 打脸
    }
    /* 加强自己人：优先随从（英雄留到最后） */
    var 自己随从 = 候选.filter(function (t) { return !t.英雄; });
    return (自己随从.length ? 自己随从[0] : 候选[0]).i;
    function 血量可杀(t) { return 效 && typeof 效.值 === 'number' ? t.血量 <= 效.值 : false; }
  }

  W.HS_DECIDE = {
    版本: 1,
    档位: function () { return 档; },
    设档: 设档,
    设随机: 设随机,
    要发呆: 要发呆,
    选手牌: 选手牌,
    选攻击: 选攻击,
    选目标: 选目标
  };
})(typeof window !== 'undefined' ? window : globalThis);
