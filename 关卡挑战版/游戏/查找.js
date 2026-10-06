/* 关卡挑战版 · 元素查找层（游戏/查找.js —— MMD 沙盒适配，2026-10-04）
 * ==========================================================================
 * 为什么单独一个模块（而不是留在 界面.js 里）：
 *   ① 沙盒的**单条规则**有硬上限（宿主 100000 UTF-16）；`界面.js` 本来就贴着门限，
 *      多这一层就被打包器当场拒了（实测：101571 > 99800）；
 *   ② 这一层的职责与"界面"无关 —— 它解决的是**宿主环境**问题，独立成模块才说得清。
 *
 * 它解决什么（来自 MMD 沙盒文档 §2.1 / §2.3，实测踩过）：
 *   · 脚本**装卡那一刻抽出、按规则顺序跑一次**；执行时页面 DOM 可能还没建好（§2.6 真红线）；
 *   · 平台**全局改写** `Document.prototype.querySelector / getElementById`……：在 `message:mount`
 *     回调里这些查找被**收窄到"气泡范围"**，而那个游标跨 `await`/`setTimeout` 就失效。
 *     我们的牌桌在**舞台根**（#hs-sandbox-root）里、不在气泡里 —— 用 id 找就会拿到 null，
 *     于是所有按 id 接的点击全断（用户 2026-10-04 报的"点设置、结束回合均无反应"就是这个长相：
 *     报告写着 `关键id缺 playerhero/opposinghero`，而按 class 找的 `.playerHeroHealth` 却在）。
 *
 * 三条对策：
 *   ① **根部作用域**：`根.querySelector(...)` 命中的是 `Element.prototype`，平台没改它；
 *   ② **自愈**：按结构找到后**把缺的 id 补回去** —— 上游 index.js / attack.js 大量按 id 找元素，
 *      补上之后它们一起恢复（不改上游一个字）；
 *   ③ **留痕**：在根上挂捕获阶段的点击日志，让"点了没反应"能分辨
 *      "点击没落到按钮上"还是"落上了但后面那条链没走"。
 */
(function (W) {
  'use strict';
  if (W.HS_UI && W.HS_UI.找) return;
  var d = W.document;

  /* 根：沙盒是舞台根，独立网页就是 body。**永远不要**退回 document 做第一选择 ——
     document 的那几个方法正是被平台改写的那些。 */
  function 根元素() {
    try {
      if (W.HS_SANDBOX && typeof W.HS_SANDBOX.根 === 'function') {
        var r = W.HS_SANDBOX.根();
        if (r && r.querySelector) return r;
      }
    } catch (e) {}
    return (d && (d.body || d.documentElement)) || null;
  }

  var 自愈过 = {};
  function 报自愈(内容) {
    try { if (W.HS_CHECK) W.HS_CHECK.报(8, 'UI_INVALID_INPUT', 内容, '提示'); } catch (e) {}
  }

  /* 找一个元素：先根部作用域，再退回 document；给了 `要的id` 就在缺 id 时补回去。 */
  function 找(选择器, 要的id) {
    var 根 = 根元素(), el = null;
    try { el = 根 ? 根.querySelector(选择器) : null; } catch (e) {}
    if (!el) { try { el = d.querySelector(选择器); } catch (e) {} }
    if (el && 要的id && el.id !== 要的id) {
      var 占 = null;
      try { 占 = d.getElementById(要的id); } catch (e) {}
      if (!占 || 占 === el) {
        try {
          el.id = 要的id;
          if (!自愈过[要的id]) { 自愈过[要的id] = 1; 报自愈({ 自愈: '补回 id', id: 要的id, 说明: '宿主改写过查找，按结构找到后补 id' }); }
        } catch (e) {}
      }
    }
    return el;
  }
  function 找id(id) { return 找('#' + id, id); }
  function 全部(选择器) {
    var 出 = [];
    try { 出 = Array.prototype.slice.call(根元素().querySelectorAll(选择器)); } catch (e) { 出 = []; }
    if (!出.length) { try { 出 = Array.prototype.slice.call(d.querySelectorAll(选择器)); } catch (e) {} }
    return 出;
  }

  /* ★★ 补齐骨架 id：按**结构**找到关键元素，把缺掉的 id 补回去。
     结构锚点都来自骨架本身（index.html），与 class 名称无关的那些用文字/父子关系兜底：
       #cards          ← `.cards`
       #game           ← `#contents > #game`
       #playerhero     ← `.playerHeroHealth` 的最近 `.cardinplay` 祖先
       #opposinghero   ← `.opposingHeroHealth` 的最近 `.cardinplay` 祖先
       #manacontainer  ← 任一 `.manabox` 的父节点
       #endturn        ← 文字是 END TURN / ENEMY TURN 的按钮
     返回补了几个（0 = 什么都没缺）。 */
  function 补齐骨架id() {
    var 根 = 根元素(), 补 = 0;
    if (!根 || !根.querySelector) return 0;
    function 查(sel) { try { return 根.querySelector(sel); } catch (e) { return null; } }
    function 有(id) { return 查('#' + id); }
    function 定(id, el) { if (el && !el.id) { try { el.id = id; 补++; } catch (e) {} } }
    if (!有('cards')) 定('cards', 查('.cards'));
    if (!有('game')) 定('game', 查('#contents > #game') || 查('#game'));
    var 我血 = 查('.playerHeroHealth');
    if (!有('playerhero')) 定('playerhero', 我血 && 我血.closest ? 我血.closest('.cardinplay') : null);
    var 敌血 = 查('.opposingHeroHealth');
    if (!有('opposinghero')) 定('opposinghero', 敌血 && 敌血.closest ? 敌血.closest('.cardinplay') : null);
    if (!有('manacontainer')) {
      var 盒 = 查('.manabox');
      定('manacontainer', 盒 && 盒.parentElement);
    }
    if (!有('endturn')) {
      var 钮 = Array.prototype.filter.call(根.querySelectorAll('button'), function (b) {
        return /END TURN|ENEMY TURN/i.test(b.textContent || '');
      });
      定('endturn', 钮[0]);
    }
    /* ★ 桌面分成两块：在 `#hs-table` 里放两条"布带"（上方敌方 / 下方我方）。
       为什么用布带而不是给棋盘盒子加背景：盒子一动，格子与卡片的落点就会跟着偏；
       布带只上色、不参与布局（pointer-events:none），几何一点不碰。 */
    (function () {
      var t2 = 查('#hs-table');
      if (!t2) return;
      /* 布带挂在 **#game（整个舞台）** 上：铺满整屏、且不随桌面倾斜 ——
         这样平铺与立体两种视角的配色完全一致（立体模式不再有自己那层红桌布）。 */
      /* ★ 两块布：**建在牌桌里**（与那两排格子同一个坐标系），位置**按两排格子的实际布局位置算**。
         用户 2026-10-06："不是要铺满屏幕，就不应该铺满屏幕" —— 两块色块 = 两片战场：
           敌方那半 = 敌方那排顶 − 一点余量 → **两排之间的中线**
           我方那半 = 中线 → 我方那排底 + 一点余量
         既不是"铺满画布"，也不是写死的百分比（写死的那种一换视角/换版面就错位）。
         为什么用 offsetTop/offsetHeight 而不是 getBoundingClientRect：立体视角有 3D 投影，
         rect 是**投影后**的值；offset* 是布局值 —— 与那两排同坐标系，投影后自然贴着它们。 */
      function 摆布带() {
        var 布上 = 查('#hs-table .hs-band--enemy'), 布下 = 查('#hs-table .hs-band--player');
        var 敌行 = 查('#hs-slots-enemy'), 我排 = 查('#hs-slots-player'), 桌 = 查('#hs-table');
        if (!布上 || !布下 || !敌行 || !我排 || !桌) return;
        var H = 桌.offsetHeight, Wd = 桌.offsetWidth; if (!H) return;
        var 敌顶 = 敌行.offsetTop, 敌高 = 敌行.offsetHeight;
        var 我顶 = 我排.offsetTop, 我高 = 我排.offsetHeight;
        var 线 = Math.round((敌顶 + 敌高 + 我顶) / 2);      // 两排之间的中线：两块的分界
        /* ★ 方案 B（用户 2026-10-06 选定）：色块 = **整张桌面**上下各一半，不是"两排格子那一条带"。
              · 立体视角：桌面 = 旧桌布那一圈（-2% / -14% / 104% / 108%）→ 看起来才是"整张桌子分成两半"；
              · 平铺视角：桌面就是牌桌本身（0…100%）→ 不外扩，免得溢出到屏幕外（那是上一版的毛病）。
           分界线两种情况都用**两排之间的中线** —— 它按布局现算，换视角/换部署位都会跟上。 */
        var 立体 = /view-tilt/.test(((查('#game') || {}).className) || '');
        var 左 = 立体 ? Math.round(-0.02 * Wd) : 0;
        var 宽 = 立体 ? Math.round(1.04 * Wd) : Wd;
        var 顶 = 立体 ? Math.round(-0.14 * H) : 0;
        var 底 = 立体 ? Math.round(1.08 * H) : H;
        var 键 = [左, 宽, 顶, 线, 底].join(',');
        if (布上.__hsKey === 键) return;                   // 没变就不写（省得每 0.8s 触发一次重排）
        布上.__hsKey = 键;
        布上.style.left = 左 + 'px'; 布上.style.width = 宽 + 'px';
        布上.style.top = 顶 + 'px'; 布上.style.height = Math.max(1, 线 - 顶) + 'px';
        布下.style.left = 左 + 'px'; 布下.style.width = 宽 + 'px';
        布下.style.top = 线 + 'px'; 布下.style.height = Math.max(1, 底 - 线) + 'px';
      }
      var 桌0 = 查('#hs-table');
      if (桌0) {
        if (!查('#hs-table .hs-band--enemy')) {
          var b上 = d.createElement('div');
          b上.className = 'hs-band--enemy';
          桌0.appendChild(b上);
        }
        if (!查('#hs-table .hs-band--player')) {
          var b下 = d.createElement('div');
          b下.className = 'hs-band--player';
          桌0.appendChild(b下);
        }
        摆布带();
        if (!W.__hsBandTimer) { try { W.__hsBandTimer = W.setInterval(摆布带, 800); } catch (e) {} }
      }
      /* 两层摆件层（见 游戏/样式.css 顶部的说明）：
         #hs-props 随桌面倾斜、#hs-props-flat 不倾斜；摆件一律用设计稿百分比定位。 */
      if (!查('#hs-table #hs-props')) {
        var 摆 = d.createElement('div');
        摆.id = 'hs-props';
        t2.appendChild(摆);
      }
      var g2 = 查('#game');
      if (g2 && !查('#game > #hs-props-flat')) {
        var 摆平 = d.createElement('div');
        摆平.id = 'hs-props-flat';
        g2.appendChild(摆平);
      }
    })();

    /* ★ 摆件 API（给将来的美术素材用）：坐标**一律是设计稿 1208×720 的百分比**。
       例：HS_PROPS.放({ 层:'平', 名:'台灯', at:[6,4], 尺寸:[14,10], 图:'素材/台灯.png' })
       `层`：'桌' = 随桌面倾斜（贴桌面）、'平' = 不倾斜（悬浮）。
       为什么只收百分比：窗口大小与视角都不该让摆件跑偏 —— 摆件只给一次设计稿坐标。 */
    W.HS_PROPS = {
      放: function (项) {
        项 = 项 || {};
        var 层 = (项.层 === '桌') ? 查('#hs-table #hs-props') : 查('#game > #hs-props-flat');
        if (!层) return null;
        var e = d.createElement('div');
        e.className = 'hs-prop';
        if (项.名) e.setAttribute('data-prop', 项.名);
        var at = 项.at || [0, 0], 尺 = 项.尺寸 || null;
        e.style.left = at[0] + '%';
        e.style.top = at[1] + '%';
        if (尺) { e.style.width = 尺[0] + '%'; e.style.height = 尺[1] + '%'; }
        if (项.图) e.style.backgroundImage = 'url("' + 项.图 + '")';
        if (项.文字) e.textContent = 项.文字;
        if (项.还) for (var k in 项.还) if (项.还.hasOwnProperty(k)) e.style[k] = 项.还[k];
        层.appendChild(e);
        return e;
      },
      清: function () {
        ['#hs-table #hs-props', '#game > #hs-props-flat'].forEach(function (sel) {
          var 层 = 查(sel);
          if (层) while (层.firstChild) 层.removeChild(层.firstChild);
        });
      }
    };

    /* ★ 清掉 `#game` 里的**裸文字**（用户 2026-10-06："对局页面左上角有 `V>` 的字符残留"）。
       来源：上游骨架里 `#game` 标签**内部**写了两个字（`v>`）—— 它不属于任何子元素、也没人管它，
       于是永远画在牌局左上角（按元素查是查不到的：命中测试命中的是我们自己的牌桌图层）。
       清掉它的直接子文本节点即可，元素一个不动。 */
    (function () {
      var g = 查('#game');
      if (!g) return;
      for (var i = g.childNodes.length - 1; i >= 0; i--) {
        var n = g.childNodes[i];
        if (n.nodeType === 3 && String(n.nodeValue || '').trim()) g.removeChild(n);
      }
    })();
    /* ★ 两座英雄容器：**缺了就自己造一座**（不只是补 id）。
       实测（真机 + 技能自带的平台全景预览里都复现）：
         骨架字符串里明明有 `<div class="cardinplay" id="playerhero">`，
         但注入到舞台之后，`#playerhero` / `#opposinghero` **既查不到 id、也查不到元素** ——
         宿主会把这两个节点弄丢（`cards`/`contents`/`endturn` 却都在）。
       而它们承载两件事：① 血量数字（上游 `startGame()` 第一句就读 `.opposingHeroHealth`，
       读不到就抛错、后面整段发牌都不执行 → "没有手牌"）；② 英雄的点击/攻击落点。
       结构与骨架里那份一致（界面.js 的注释里记着），所以直接照原样造。
       宁可我们造一座，也不要一个缺了英雄的战场。 */
    [['playerhero', 'playerHeroHealth', 'playerhero'],
     ['opposinghero', 'opposingHeroHealth', 'opponenthero']].forEach(function (t) {
      if (有(t[0])) return;
      var 宿主 = 查('#game') || 查('#contents') || 根;
      if (!宿主) return;
      try {
        var 盒 = d.createElement('div');
        盒.className = 'cardinplay ' + t[2];        // 两个选择器家族都覆盖（id 与 class 都有规则）
        盒.id = t[0];
        var 甲 = d.createElement('div');
        var 乙 = d.createElement('div');
        var 血 = d.createElement('div');
        血.className = t[1];
        血.textContent = '30';
        乙.appendChild(血);
        盒.appendChild(甲);
        盒.appendChild(乙);
        宿主.appendChild(盒);
        补++;
      } catch (err) {}
    });
    /* ⚠ 2026-10-05：这一段原来给 `#gifhint` / `#texthint` 造隐藏空壳 —— 为了让**上游那条
       "结束回合"直线链**（`gifhint` → `texthint` → `opponentTurn()`）不中途抛错。
       现在那条链已经不存在了（`index.js` 删除、回合归 游戏/回合.js、结束回合按钮也是我们绑的），
       那两个空壳也随 index.html 一起删了 —— 所以这段一并移除，免得它又"凭空造出两个元素"。
       自愈的职责只剩一件：**把上游遗留的 id 按结构补回去**（比如 `.playerHeroHealth` → `#playerhero`）。 */
    if (补) 报自愈({ 自愈: '补齐骨架 id', 补了: 补, 说明: '宿主环境里 id 不可靠，按结构补回' });
    return 补;
  }

  /* ---------------------------------------------------------------- 点击留痕
     真机上"点了没反应"最难分辨的是**点击到底有没有落到那个元素上**。捕获阶段必然先于任何处理器，
     所以这个监听永远能记到：日志里有 `#endturn` 而"最近播过的动作"为空 → 接上了、后面的链没走；
     日志里压根没有那个元素 → 点击**根本没落到它身上**（多半被别的图层盖住）。 */
  var 载入时刻 = (W.Date && W.Date.now) ? W.Date.now() : 0;
  var 点击日志 = [];
  function 记点击(el) {
    var 名 = el ? (el.id ? '#' + el.id
      : (el.className ? '.' + String(el.className).trim().split(/\s+/)[0] : el.tagName)) : '（无目标）';
    var 秒 = ((W.Date && W.Date.now ? W.Date.now() : 0) - 载入时刻) / 1000;
    点击日志.push(名 + ' @' + 秒.toFixed(1) + 's');
    if (点击日志.length > 8) 点击日志.shift();
  }
  try {
    var 监听根 = 根元素();
    if (监听根 && 监听根.addEventListener) 监听根.addEventListener('click', function (e) { 记点击(e.target); 盯结束回合(e); }, true);
  } catch (e) {}

  /* ---------------------------------------------------------------- 结束回合的"安全网"
     上游那个回调是**直线链**：查 `#endturn` → 查 `#gifhint` → 查 `#texhint` → 才调 `opponentTurn()`。
     任意一句拿到 null 就抛错中断，`opponentTurn()` 永远不执行（而且浏览器不会重试）。
     我们**不改上游**（它逐字保留），改用"点了以后回头看一眼"的办法：
       点下 #endturn 400ms 后检查 ——
         · `回合留痕.opponentTurn` 涨了 → 上游那条路走通了，什么都不做；
         · `playersTurn` 已经变成 false → 上游至少进了 `opponentTurn`，也不插手；
         · 两者都没发生 → 判定"那条链断了"，**我们自己把回合推进过去**，并记一条提示。
     这样无论是"加载期绑定没接上"还是"回调中途抛错"，按钮都不会是死的。 */
  var 盯过 = 0;
  function 盯结束回合(e) {
    var el = e && e.target;
    if (!el || !el.closest) return;
    if (!el.closest('#endturn')) return;
    盯过++;
    var 序号 = 盯过, 前次 = (W.HS_TURN_LOG && W.HS_TURN_LOG.opponentTurn) || 0;
    W.setTimeout(function () {
      var 现在 = (W.HS_TURN_LOG && W.HS_TURN_LOG.opponentTurn) || 0;
      if (现在 > 前次) return;                       // 上游走通了
      if (W.playersTurn === false) return;           // 上游至少进了 opponentTurn
      try {
        if (W.HS_CHECK) {
          W.HS_CHECK.报(6, 'UI_INVALID_INPUT', {
            安全网: '结束回合的链断了，由我们推进', 第几次: 序号,
            上游: typeof W.opponentTurn, playersTurn: W.playersTurn
          }, '严重');
        }
      } catch (err) {}
      try {
        if (typeof W.opponentTurn === 'function') W.opponentTurn();
        else if (W.HS_兜底回合 && W.HS_兜底回合.开始我方回合) W.HS_兜底回合.开始我方回合();
      } catch (err) {}
    }, 400);
  }

  /* ⚠ 名字里**不要**用 `HS_UI`：`界面.js` 早就把 `W.HS_UI` 用作"刷新任务区"那个小导出，
     两边都叫 HS_UI 就会互相覆盖（第一版就撞了：`HS_UI.找` 变 undefined）。
     对外用 `HS_查找`，另留 `HS_UI_*` 一组旧名字给检错层与自检用。 */
  W.HS_查找 = {
    版本: 1,
    根: 根元素,
    找: 找,
    找id: 找id,
    全部: 全部,
    补齐: 补齐骨架id,
    点击日志: function () { return 点击日志.slice(); }
  };
  W.HS_UI_找 = 找;
  W.HS_UI_找id = 找id;
  W.HS_UI_全部 = 全部;
  W.HS_UI_根 = 根元素;

  /* ★ **覆盖宿主**：所有"浮在牌桌上的覆盖层"（演出层 / 提示条 / 各种条与面板）都该挂这里。
     优先"本作品的根节点"，独立网页才落 `document.body`。
     为什么（沙盒同层卡指南 §5.4「所有内容挂在本作品根节点」）：沙盒的舞台根 `z-index` 是 2147483000，
     挂在 `document.body` 的覆盖层是它的**兄弟且层级更低**，而舞台里 `#game` 有一层不透明底色铺满整屏 ——
     于是覆盖层**画在底色下面**：元素在、样式对、`getBoundingClientRect` 也有，玩家却一个都看不见
     （用户 2026-10-05："各阶段提示词、抽牌、执行、出牌提示都没展示"就是这个）。
     注意：它必须在**运行时**取（加载期 查找.js 可能还没跑）。 */
  W.HS_UI_宿主 = function () {
    try { var r = 根元素(); if (r) return r; } catch (e) {}
    return (d && d.body) || null;
  };
  W.HS_UI_补齐 = 补齐骨架id;
  W.HS_UI_点击日志 = function () { return 点击日志.slice(); };
  /* 供"本局信息"直接打印的那两行（放这里是为了给 界面.js 省长度：沙盒单条规则卡得很死）。
     回合留痕从 window 上读，**不依赖 界面.js 的内部变量**。 */
  W.HS_UI_点击摘要 = function () {
    var t = (W.HS_TURN_LOG && typeof W.HS_TURN_LOG === 'object') ? W.HS_TURN_LOG : { opponentTurn: 0, playerTurn: 0 };
    return ['--- 最近 8 次点击（目标 @ 时刻）---',
            点击日志.length ? 点击日志.join('  |  ') : '(还没有点击)',
            '回合留痕  : opponentTurn=' + (t.opponentTurn || 0) + '  playerTurn=' + (t.playerTurn || 0)];
  };

  /* ---------------------------------------------------------------- 自愈的**触发**
     ⚠ 一条实测教训：光把 `补齐()` 导出还不够，得有人**在对的时候**叫它。
       第一版只让 `外壳.js` 的引导叫一次 —— 而那个文件排在**本文件之前**（它在 index.html 的第一段、
       本文件在第二段），轮到它执行时 `HS_UI_补齐` 还不存在 → 静默跳过 ✗。
       真机上于是仍然"关键 id 缺 playerhero/opposinghero"。
     这里让本文件**自己负责把这件事做完**：立刻试一次、load 之后试一次、再最多补 12 次（每 400ms），
     直到骨架里该有的 id 都在（或时间用完）。幂等、便宜、不依赖任何人的加载顺序。 */
  var 补次 = 0;
  function 试补齐() {
    补次++;
    var 还缺 = 补齐骨架id();
    if (还缺 === 0) return;                      // 齐了，收工
    if (补次 >= 14) {                            // 约 5.6 秒还没齐：记一条"严重"，别再刷
      报自愈({ 自愈: '骨架 id 补不齐', 试了: 补次, 说明: '骨架可能没注入，或元素结构与预期不同' });
      return;
    }
    try { if (W.setTimeout) W.setTimeout(试补齐, 400); } catch (e) {}
  }
  if (d && d.addEventListener) {
    if (d.readyState === 'complete') 试补齐();
    else d.addEventListener('DOMContentLoaded', 试补齐, { once: true });
    W.addEventListener && W.addEventListener('load', 试补齐, { once: true });
  }
  试补齐();
})(typeof window !== 'undefined' ? window : globalThis);
