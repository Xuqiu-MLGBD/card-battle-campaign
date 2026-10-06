/* 关卡挑战版 · 资源与回合（游戏/资源.js —— 阶段 C）
 * =====================================================================
 * 加载位次（硬要求）：**index.js 之后、游戏/演出.js 之前**（因此也在 界面.js 之前）。
 *   · 必须在 index.js 之后：本文件要换掉 `window.playerTurn` / `placeCardFunc`，
 *     而上游是用 `function playerTurn(){}` 在顶层声明的 —— 谁最后声明谁生效；
 *   · 必须在 界面.js 之前：界面.js 会包一层回合叙述（wrapTurnNarration），
 *     它必须包到**我们的** playerTurn，否则叙述读的是别人的回合。
 *
 * 这一层收的是「资源与回合的真相」：**法力水晶上限**、法力、回合号、抽牌、上限变化账本。
 *
 * 为什么"接管"长成这个样子（口径先说清，免得看代码时误会）：
 *   · 上游那两个全局量 `mana` / `manaCapacity` 是 **`var` 顶层的 = window 属性**，
 *     可读可写、但**不可重定义**（`var` 声明出来的属性 configurable:false）——
 *     所以不能把它们变成"我们状态的访问器"，只能反过来：**真值在我们这儿，全局量当缓存**。
 *   · 本文件是这两个全局量的**唯一写入点**（一条硬规矩，和 freshDeck 那次一样）。
 *     做法是"**先摆好，再让上游自增**"：上游 playerTurn 里写的是
 *     `if (manaCapacity != 10) { manaCapacity++; createManaCrystal(); } mana = manaCapacity;`
 *     —— 我们先把全局量预置成 `我们的上限 − 1`，它自增一步就正好落在我们的值上，
 *     顺手把水晶也画了。**一个字都不改上游**（账是"改能力，不改调用点"；这里连调用点都不动）。
 *   · 水晶"只会加不会减"是上游的写法（`!= 10` 才 ++、从不删）—— 上限**下降**（负面任务）时，
 *     由我们的 `渲染法力()` 把多出来的水晶裁掉，并**按真实法力上色**
 *     （上游那份 `updateManaGUI` 靠一个被遮蔽的 `manaCost` 全局上色，实际上是坏的：
 *      全局恒为 null，所以它按循环下标涂黑，和法力值没关系）。
 *
 * 用户 2026-10-03 定的方向（这一层就是它的落点）：
 *   「完成正面任务时，法力水晶上限加一；完成了负面任务条件则会减少法力上限。任务就放在任务区。」
 *   → `完成正面任务(名)` / `触发负面任务(名)` 就是那两个入口，内部都是 `加上限(±1, 原因)`；
 *     每次变化都记进账本（`历史()`），任务区把它显示出来。
 *   ⚠ 具体任务表（`W.HS_TASKS`）留空 —— 那是玩法设计，等用户给条目；
 *     现在只有机制，没有替他编的规则。
 */
(function (W) {
  'use strict';
  if (W.HS_RESOURCE) return;                 // 幂等

  var 顶尖 = 10;                             // 与引擎的 `法力顶尖` 同口径
  var 态 = { 上限: 1, 法力: 1, 回合: 1, 账: [] };

  function 夹(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function 是数(x) { return typeof x === 'number' && isFinite(x); }
  function 喊(fn, 参) { try { if (W.console && W.console[fn]) W.console[fn].apply(W.console, 参); } catch (e) {} }

  /* 账本：上限每一次变化都留一条（任务区显示的就是它） */
  function 记(文字) {
    态.账.push({ 回合: 态.回合, 文字: 文字 });
    if (态.账.length > 60) 态.账.shift();
    try { if (W.HS_UI && typeof W.HS_UI.刷新任务区 === 'function') W.HS_UI.刷新任务区(); } catch (e) {}
  }

  /* ---------------------------------------------------------------- 渲染
     我们只碰"跟法力有关的那几样 DOM"：`#mana` 文字、`#manacontainer` 里的水晶颗数与颜色。
     其余（按钮变绿、英雄技能绿光、光标、音效）仍然由上游那段代码负责 —— 那是阶段 F 的事。 */
  function 渲染法力() {
    var d = W.document;
    if (!d) return;
    /* ★ 先对账再画：**法力**以上游写下的值为准（它才是花钱的那一方），**上限**以我们为准。
       这条顺序很重要 —— 曾经反过来（渲染时把 `W.mana` 硬写回我们的值），
       结果上游异步扣完费，文字已经是 0/1、水晶却还是亮的。 */
    核对('渲染');
    if (W.manaCapacity !== 态.上限) W.manaCapacity = 态.上限;      // 兜底：全局量必须等于真相
    var 文字 = d.getElementById && d.getElementById('mana');
    if (文字) 文字.innerHTML = 态.法力 + '/' + 态.上限;

    var 盒 = d.getElementById && d.getElementById('manacontainer');
    if (盒 && 盒.children) {
      /* 少了就补（借上游那支只做 DOM 的小工具），多了就裁 —— 上限能降，上游只会上加。 */
      var 卫 = 0;
      while (盒.children.length < 态.上限 && 卫++ < 40 && typeof W.createManaCrystal === 'function') {
        W.createManaCrystal();
      }
      while (盒.children.length > 态.上限 && 盒.children.length > 0) {
        盒.removeChild(盒.children[盒.children.length - 1]);
      }
    }
    var 水晶 = d.getElementsByClassName ? d.getElementsByClassName('manabox') : null;
    if (水晶) {
      for (var i = 0; i < 水晶.length; i++) {
        if (水晶[i].style) 水晶[i].style.backgroundColor = (i < 态.法力) ? '#3669c9' : 'black';
      }
    }
  }

  /* ---------------------------------------------------------------- 对账
     上游是"花钱"的那一方（placeCardFunc / 英雄技能的 `mana -= n` 都在它手里），
     所以：**法力**以上游写下的值为准（它扣的），**上限**以我们为准（它自增一步是我们摆出来的）。 */
  function 核对(何时) {
    if (是数(W.mana) && W.mana !== 态.法力) {
      /* 上游扣过费（或写过一次法力），采纳它 —— 但夹在 [0, 上限] 里 */
      var 新 = 夹(W.mana, 0, 态.上限);
      if (新 !== W.mana) W.mana = 新;
      态.法力 = 新;
    }
    if (是数(W.manaCapacity) && W.manaCapacity !== 态.上限) {
      喊('warn', ['[资源] 法力上限不一致：上游 ' + W.manaCapacity + ' / 我们 ' + 态.上限 + ' → 以我们为准']);
      记('纠正上限（上游写成了 ' + W.manaCapacity + '）');
      W.manaCapacity = 态.上限;
    }
    return { 法力: 态.法力, 上限: 态.上限 };
  }

  /* ---------------------------------------------------------------- 对外的动作 */
  function 设法力(v) {
    态.法力 = 夹(是数(v) ? v : 态.法力, 0, 态.上限);
    W.mana = 态.法力;
    渲染法力();
    return 态.法力;
  }

  function 设上限(n, 原因) {
    var 前 = 态.上限;
    态.上限 = 夹(是数(n) ? n : 前, 0, 顶尖);
    if (态.法力 > 态.上限) 态.法力 = 态.上限;      // 上限掉了，手上的法力不能超过它
    W.manaCapacity = 态.上限;
    W.mana = 态.法力;
    渲染法力();
    if (态.上限 !== 前) 记('法力上限 ' + (态.上限 > 前 ? '+' : '') + (态.上限 - 前) +
                           '（' + (原因 || '未说明') + '）：' + 前 + ' → ' + 态.上限);
    return 态.上限;
  }

  /* 上限加减 —— 用户的法力系统就走这两个（下面两个任务入口是它的语法糖） */
  function 加上限(差, 原因) { return 设上限(态.上限 + (是数(差) ? 差 : 0), 原因); }
  function 完成正面任务(名) { return 加上限(+1, '正面任务：' + (名 || '未命名')); }
  function 触发负面任务(名) { return 加上限(-1, '负面任务：' + (名 || '未命名')); }

  function 回满() { return 设法力(态.上限); }

  function 花(费, 什么) {
    var n = 是数(费) ? 费 : 0;
    if (态.法力 < n) return false;
    态.法力 -= n;
    W.mana = 态.法力;
    渲染法力();
    if (什么) 记('花 ' + n + ' 法力：' + 什么);
    return true;
  }

  /* ---------------------------------------------------------------- 抽牌补偿
     上游 playerTurn 里那两步是**不对等**的：
       `if (hand.childElementCount != 10) { hand.appendChild(...) }`   ← 只看手牌满没满
       `playerDeck.cards.shift()`                                       ← **无条件**执行
     于是手牌满 10 张时，那张牌被抽出来又没进去，**静默消失**。
     我们不删它那两行（不许动上游），而是**发现少了就放回原位置**（按对象身份找回索引）。 */
  function 牌库数组() {
    /* `playerDeck` 是 index.js 顶层的 **`let`** —— 它是全局词法绑定，只能按裸标识符取
       （`W.playerDeck` 是 undefined）；在 node 桩里它不存在 → ReferenceError → 兜住。 */
    try { return playerDeck.cards; } catch (e) { return null; }
  }
  function 手牌数() {
    try { return hand.childElementCount; } catch (e) { return -1; }
  }
  function 补回被吞的抽牌(库前, 手前) {
    if (!库前 || 手前 < 0 || 手前 !== 10) return null;               // 只有"手牌满"这一种情形会吞
    var 库后 = 牌库数组();
    if (!库后 || 库后.length !== 库前.length - 1) return null;
    for (var i = 0; i < 库前.length; i++) {
      if (库后.indexOf(库前[i]) < 0) {
        库后.splice(i, 0, 库前[i]);                                  // 放回原位
        if (typeof W.updateDeckCount === 'function') { try { W.updateDeckCount(); } catch (e) {} }
        记('手牌已满：补回被上游吞掉的那张抽牌');
        return 库前[i];
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------- 回合：**已交出去**
     2026-10-05（去上游）：这里原来包着上游的 `playerTurn`（"先把全局量摆成上限−1、让它自增一步"）
     与 `placeCardFunc`。现在回合与落场都由 `游戏/回合.js` 自己实现，那两个包装**必须卸掉** ——
     留着会双重计算（它的"预设上限"会被我们的 +1 覆盖，一回合涨两点法力）。
     本层从此只做一件事：**持有法力/上限/回合号这个真相**，由 `游戏/回合.js` 通过下面的出口驱动。
     牌库与手牌的补偿（"手牌满时上游无条件 shift 会静默丢牌"）也随上游一起作废 ——
     我们的 `抽一张` 在满手时就是直接不抽。 */

  /* ---------------------------------------------------------------- 对外出口 */
  W.HS_RESOURCE = {
    版本: 1,
    读: function () {
      return { 法力: 态.法力, 上限: 态.上限, 回合: 态.回合, 顶尖: 顶尖,
               全局法力: W.mana, 全局上限: W.manaCapacity };
    },
    法力: function () { return 态.法力; },
    上限: function () { return 态.上限; },
    回合: function () { return 态.回合; },
    顶尖: function () { return 顶尖; },
    设法力: 设法力,
    设上限: 设上限,
    加上限: 加上限,
    回满: 回满,
    花: 花,
    完成正面任务: 完成正面任务,          // → 上限 +1（用户 2026-10-03 的法力系统）
    触发负面任务: 触发负面任务,          // → 上限 −1
    渲染: 渲染法力,
    核对: 核对,
    历史: function () { return 态.账.slice(); },
    最近: function (n) { return 态.账.slice(-(n || 5)); },
    是不是我们的: function () { return !!(W.HS_TURN && typeof W.HS_TURN.我方回合开始 === 'function'); }
  };

  /* 开局先画一遍：上游那份 `updateManaGUI` 是坏的（靠一个被遮蔽的 `manaCost` 全局上色），
     所以第一回合的水晶颜色本来没人管（实测是第一颗颜色为空串）。 */
  if (W.setTimeout) W.setTimeout(function () { try { 渲染法力(); } catch (e) {} }, 0);
})(typeof window !== 'undefined' ? window : globalThis);
