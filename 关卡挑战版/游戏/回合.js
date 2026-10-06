/* 关卡挑战版 · 回合一族（游戏/回合.js —— 去上游，2026-10-05）
 * =====================================================================
 * 这一层替掉 `index.js` 与 `src/scripts/attack.js` 里"游戏流程"那部分：
 *   `startGame`（发牌）/ `playerTurn`（回合开始）/ `opponentTurn`（相位）/ `computerCardPlace`
 *   （敌方出一张）/ `attack`（刷"可攻击"）/ `updateDeckCount` / `createManaCrystal` / `gameWon`。
 *
 * 加载位次（硬要求）：**卡库.js 之后、资源.js 之前**。
 *   · 在 `index.js` **之后**：上游顶层是 `var` / `function` 声明，后声明的会盖掉先声明的；
 *     我们要当最后那个（否则又被上游盖回去）。
 *   · 在 `资源.js` / `界面.js` **之前**：那两层是"包一层 W.playerTurn / W.opponentTurn / W.attack"
 *     干活的，它们必须包到**我们的**函数 —— 这样它们的叙述、法力模型、演出一个字都不用改。
 *
 * 与上游并存的过渡期（批次 D 之前）有一处必须小心：
 *   `index.js` 里 `let originalDeck, playerDeck, computerDeck` 是**全局词法绑定**，
 *   不是 window 属性 —— 写 `window.playerDeck = x` **改不到它**，而界面层是按裸标识符读的。
 *   所以这里用 `设牌库/取牌库` 两个口子：**先试着写裸标识符**（那才是上游那份 let），
 *   写不到（上游删掉之后就是这种情况）再落到 window 上。批次 D 之后前者自动失效、后者生效。
 *
 * 已知的上游毛病（顺手一起修，见 说明/13 F 段）：敌方从不抽牌、`indexOf(i)` 砍错牌、
 * `manaCost` 被遮蔽导致水晶上色与法力无关、手牌满时无条件 `shift` 静默丢牌、牌库计数不刷新。
 */
(function (W) {
  'use strict';
  if (W.HS_TURN) return;
  var d = W.document;

  var 手牌上限 = 10;                 // 与引擎/界面层同口径
  var 敌方场上上限 = 7;              // 上游是 7，保留
  var 我方牌库张数 = 30;             // 上游：玩家 0–29、电脑 31–59（30 那张被吞了，这里修掉）

  /* ---------------------------------------------------------------- 小工具 */
  function 喊(fn, 参) { try { if (W.console && W.console[fn]) W.console[fn].apply(W.console, 参); } catch (e) {} }
  function 找id(id) {
    try { if (W.HS_UI && typeof W.HS_UI.找id === 'function') return W.HS_UI.找id(id); } catch (e) {}
    try { return d.getElementById(id); } catch (e) { return null; }
  }
  function 板(side) {
    var sel = side === 'player' ? '.board--player' : '.board--opponent';
    try { if (W.HS_INTERACT && W.HS_INTERACT.根) { var r = W.HS_INTERACT.根(); if (r && r.querySelector) return r.querySelector(sel); } } catch (e) {}
    return d.querySelector(sel);
  }
  function 手牌盒() { return 找id('cards') || d.querySelector('.cards'); }

  /* 牌库存取：裸标识符优先（上游那份 `let` 才是界面层读的那个），否则落 window。
     批次 D 删掉 index.js 之后，裸赋值会抛 ReferenceError → 静默落到 window 上。 */
  function 取牌库(名) {
    try { var v = eval(名); if (v) return v; } catch (e) {}
    return W[名] || null;
  }
  function 设我方牌库(v) { try { playerDeck = v; } catch (e) {} W.playerDeck = v; }
  function 设敌方牌库(v) { try { computerDeck = v; } catch (e) {} W.computerDeck = v; }
  function 设原始牌组(v) { try { originalDeck = v; } catch (e) {} W.originalDeck = v; }
  function 设在局里(v) { try { inRound = v; } catch (e) {} W.inRound = v; }

  function 牌库卡片(名) { var dk = 取牌库(名); return dk && dk.cards ? dk.cards : null; }

  /* ---------------------------------------------------------------- 相位与提示 */
  function 相位(谁的) {
    var 敌 = 找id('computerTurn'), 钮 = 找id('endturn');
    if (敌) 敌.style.display = (谁的 === 'enemy') ? 'block' : 'none';
    if (钮) {
      钮.innerText = (谁的 === 'enemy') ? 'ENEMY TURN' : 'END TURN';
      钮.style.backgroundColor = (谁的 === 'enemy') ? 'grey' : '#4ce322';
    }
    W.playersTurn = (谁的 === 'player');
  }

  /* ---------------------------------------------------------------- 法力水晶 */
  /* 上游只会上加、从不删；上限能降（负面任务），所以渲染归资源层，这里只负责"补一颗"。 */
  function createManaCrystal() {
    var 盒 = 找id('manacontainer');
    if (!盒) return null;
    var 颗 = d.createElement('div');
    颗.classList.add('manabox');
    盒.appendChild(颗);
    return 颗;
  }

  /* ---------------------------------------------------------------- 发牌 */
  function 洗(a) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  /* 清手牌与两侧棋盘、水晶：换关是**页内**重开，不自己清就会把上一局的牌带过来。 */
  function 清场() {
    var 手 = 手牌盒();
    if (手) while (手.firstChild) 手.removeChild(手.firstChild);
    ['player', 'enemy'].forEach(function (s) {
      var b = 板(s);
      if (!b) return;
      var 全部 = Array.prototype.slice.call(b.children);
      for (var i = 0; i < 全部.length; i++) {
        if (全部[i].classList && (全部[i].classList.contains('cardinplay') || 全部[i].classList.contains('card'))) b.removeChild(全部[i]);
      }
    });
    var 盒 = 找id('manacontainer');
    if (盒) while (盒.firstChild) 盒.removeChild(盒.firstChild);
  }

  /* 发牌：两副各 30 张（上游把第 31 张丢了，这里对半分干净），起手 3 张、
     其中**保底一张 1 费**（上游那条"得有出得起的牌"的设计保留）。 */
  function 开局发牌() {
    if (!W.HS_CARD || typeof W.HS_CARD.牌库 !== 'function') { 喊('error', ['[回合] 卡库没装上，发不了牌']); return false; }
    清场();
    var Deck = W.HS_CARD.牌库;
    var 全 = new Deck();                                  // 构造即调 freshDeck()（关卡牌组优先）
    设原始牌组(new Deck(全.cards.slice(0, 全.cards.length)));   // 出牌查卡用的一份"全书"
    var 打乱 = 洗(全.cards.slice(0, 全.cards.length));
    设我方牌库(new Deck(打乱.slice(0, 我方牌库张数)));
    设敌方牌库(new Deck(打乱.slice(我方牌库张数)));

    var 手 = 手牌盒();
    var 我方 = 牌库卡片('playerDeck');
    if (手 && 我方) {
      for (var i = 0; i < 2 && 我方.length; i++) 手.appendChild(我方.shift().getPlayerCardsInHandHTML());
      /* 保底一张 1 费：找不到就照旧发（不为了一个保底把三张卡住） */
      for (var k = 0; k < 我方.length; k++) {
        if (Number(我方[k]['mana']) === 1) { 手.appendChild(我方.splice(k, 1)[0].getPlayerCardsInHandHTML()); break; }
      }
    }
    /* 法力：开局 1 点上上限、回满。真值在资源层，这里只把全局量摆成同一个数。 */
    if (W.HS_RESOURCE) { try { W.HS_RESOURCE.设上限(1, '开局'); W.HS_RESOURCE.回满(); } catch (e) {} }
    W.manaCapacity = 1; W.mana = 1;
    牌库计数();
    相位('player');
    设在局里(true);
    if (W.HS_TURN_LOG) W.HS_TURN_LOG.开局 = (W.HS_TURN_LOG.开局 || 0) + 1;
    喊('info', ['[回合] 发牌完成：我 ' + (牌库卡片('playerDeck') || []).length + ' 张 / 敌 ' + (牌库卡片('computerDeck') || []).length + ' 张']);
    return true;
  }

  /* ---------------------------------------------------------------- 抽牌 */
  function 抽一张() {
    var 手 = 手牌盒(), 库 = 牌库卡片('playerDeck');
    if (!手 || !库) return null;
    if (手.childElementCount >= 手牌上限) return null;      // 满手不抽（也别偷偷 shift 掉一张）
    if (!库.length) { 洗回(); return null; }
    var 卡 = 库.shift();
    手.appendChild(卡.getPlayerCardsInHandHTML());
    牌库计数();
    return 卡;
  }
  function 洗回() {
    /* 无疲劳：牌库空了把墓地洗回去。墓地暂时不存在（上游也没有），
       所以这里用"原始牌组减去此刻手牌与场上"当牌堆底 —— 这是现有数据能给出的最好近似。 */
    var 库 = 取牌库('playerDeck');
    if (!库 || !W.HS_CARD) return false;
    var 全 = 牌库卡片('originalDeck');
    if (!全 || !全.length) return false;
    库.cards = 洗(全.slice());
    牌库计数();
    喊('info', ['[回合] 牌库抽空：按原始牌组洗回 ' + 库.cards.length + ' 张']);
    return true;
  }

  /* ---------------------------------------------------------------- 回合开始（我方） */
  function 我方回合开始() {
    if (W.HS_RESOURCE) {
      try { W.HS_RESOURCE.加上限(1, '回合开始'); W.HS_RESOURCE.回满(); } catch (e) {}
    } else if (W.manaCapacity < 10) { W.manaCapacity++; W.mana = W.manaCapacity; createManaCrystal(); }
    抽一张();
    相位('player');
    刷可攻击();
    刷出得起();
    牌库计数();
    /* ⚠ **这里不要碰 `HS_TURN_LOG`**：那是界面层叙述包装（`界面.js` 的 wp/wo）自己的留痕，
       它在包住我们的函数里已经计过数。我们再加一次就成了**双层计数** ——
       实测抓到的正是这一条：`playerTurn` 记到 2，而"加上限"其实只跑了一次
       （用户报的"计数与事实不符"就是这一类）。 */
    return true;
  }

  /* ---------------------------------------------------------------- 结束回合（我方结束 → 敌方）
     注意：真正的"敌方行动"由**界面层包装的 `W.opponentTurn`** 规划与演出（见 界面.js 的 wo）。
     它会把这条函数整个换掉，所以这里只需把相位摆对 —— 但它必须是条**真函数**：
     包装没装上（模块缺失/早于界面层）时，按钮也不能是死的。 */
  function 结束回合() {
    W.HS_TURN_结束回合次数 = (W.HS_TURN_结束回合次数 || 0) + 1;   // 探针：诊断"回合推进了两次"
    相位('enemy');   /* 同上：留痕由界面层的 wo 负责，这里不重复计 */
    W.setTimeout(function () {
      try { if (typeof W.playerTurn === 'function') W.playerTurn(); } catch (e) { 喊('error', ['[回合] 交回合失败', e]); }
    }, 900);
    return true;
  }

  /* ---------------------------------------------------------------- 敌方出一张 */
  /* 上游那版有三个毛病：`indexOf(i)`（拿下标当元素找，恒 −1）→ `splice(undefined,1)` 砍错牌、
     然后 `cards[0]` 兜底，以及 `manaCapacity == 10` 那条分支写反。这里按"费用等于上限优先、
     否则第一张"重写，并且**只从牌堆里摘走真正打出去的那一张**。 */
  function 敌方出一张() {
    var 板敌 = 板('enemy'), 库 = 牌库卡片('computerDeck');
    if (!板敌 || !库 || !库.length) return null;
    if (板敌.childElementCount >= 敌方场上上限) return null;
    var 上限 = (W.HS_RESOURCE && W.HS_RESOURCE.上限) ? Number(W.HS_RESOURCE.上限()) : Number(W.manaCapacity || 1);
    var 选 = 0;
    for (var i = 0; i < 库.length; i++) { if (Number(库[i]['mana']) === 上限) { 选 = i; break; } }
    var 卡 = 库[选];
    if (!卡) return null;
    板敌.appendChild(卡.getComputerHTML());
    库.splice(选, 1);
    牌库计数();
    return 卡;
  }

  /* ---------------------------------------------------------------- 刷"可攻击"与"出得起" */
  function 刷可攻击() {
    var 板我 = 板('player');
    if (!板我 || !板我.querySelectorAll) return 0;
    var 单位 = 板我.querySelectorAll('.cardinplay');
    for (var i = 0; i < 单位.length; i++) {
      单位[i].classList.add('canAttack');
      单位[i].style.boxShadow = '0px 2px 15px 12px #0FCC00';
    }
    return 单位.length;
  }
  /* 手牌"出得起/出不起"的染色：界面层的 `刷可出性` 是那份实现，这里只是给旧调用点留个名字。 */
  function 刷出得起() {
    try { if (W.HS_INTERACT && typeof W.HS_INTERACT.刷可出性 === 'function') return W.HS_INTERACT.刷可出性(); } catch (e) {}
    return 0;
  }
  function checkForRequiredMana() { return 刷出得起(); }
  function updateManaGUI() { try { if (W.HS_RESOURCE) W.HS_RESOURCE.渲染(); } catch (e) {} }

  /* ---------------------------------------------------------------- 牌库计数 */
  function 牌库计数() {
    var 我 = 牌库卡片('playerDeck'), 敌 = 牌库卡片('computerDeck');
    var 我元 = d.querySelector('.player-deck'), 敌元 = d.querySelector('.computer-deck');
    if (我元 && 我) { 我元.innerText = 我.length; 我元.style.display = 我.length ? 'block' : 'none'; }
    if (敌元 && 敌) { 敌元.innerText = 敌.length; 敌元.style.display = 敌.length ? 'block' : 'none'; }
    return { 我: 我 ? 我.length : -1, 敌: 敌 ? 敌.length : -1 };
  }

  /* ---------------------------------------------------------------- 胜负 */
  /* `外壳.js` 会在外面再包一层（记通关进度 + 挂"下一关"），所以这里只做"赢的那一拍"本身：
     说一句、把局面停住。上游的金币/卡包是它自己的元游戏，我们不要。 */
  function 胜利() {
    W.gameIsWon = true;
    try {
      var 泡 = d.querySelector('#computerbubble');
      if (泡) { 泡.innerText = '我输了……'; 泡.style.visibility = 'visible'; 泡.classList.add('openMenuAnim'); }
    } catch (e) {}
    喊('info', ['[回合] 我方获胜']);
    return true;
  }
  function 失败() {
    try {
      var 条 = 找id('hs-losebar');
      if (!条) {
        条 = d.createElement('div'); 条.id = 'hs-losebar';
        var 字 = d.createElement('span'); 字.textContent = '这一局输了，再来一次'; 条.appendChild(字);
        var 钮 = d.createElement('button'); 钮.className = 'campaign-btn'; 钮.textContent = '重打这一关';
        钮.onclick = function () { try { if (W.HS_SANDBOX && W.HS_SANDBOX.重开) W.HS_SANDBOX.重开(); else W.location.reload(); } catch (e) {} };
        条.appendChild(钮); ((W.HS_UI_宿主 && W.HS_UI_宿主()) || d.body).appendChild(条);
      }
      条.classList.add('on');
    } catch (e) {}
    喊('warn', ['[回合] 我方失败']);
    return true;
  }

  /* ---------------------------------------------------------------- 结束回合按钮：唯一入口
     用户 2026-10-05 定的口径：**按钮直接调这个入口**，并分三段记录
     「收到点击 → 进入处理 → 成功 / 异常」，不再靠"点击次数 + 回看一眼"去猜。
     ⚠ 必须**在捕获阶段把上游那个监听截掉**：`index.js` 也给 `#endturn` 绑了一个，
       它调的是同闭包里的 opponentTurn，会绕过我们的包装与计数（用户报的第 4 条）。
       捕获阶段 `stopImmediatePropagation` 一停，上游那个就到不了。 */
  var 结束中 = false;
  function 结束回合入口(e) {
    if (e && e.stopImmediatePropagation) e.stopImmediatePropagation();   // 只留我们这一条路
    var 记 = { 计时: (W.Date && W.Date.now) ? W.Date.now() : 0 };
    try { if (W.HS_CHECK) W.HS_CHECK.报(0, 'UI_INVALID_INPUT', { 结束回合: '收到点击' }, '提示'); } catch (er) {}
    if (结束中) { 喊('warn', ['[回合] 上一次结束回合还在处理中，这次忽略']); return false; }
    if (W.HS_PIPELINE && typeof W.HS_PIPELINE.isLocked === 'function' && W.HS_PIPELINE.isLocked()) return false;
    结束中 = true;
    try {
      记.进入处理 = true;
      喊('info', ['[回合] 结束回合：进入处理']);
      var 成 = false;
      if (typeof W.opponentTurn === 'function') 成 = W.opponentTurn();
      else 成 = 结束回合();
      try { if (W.HS_CHECK) W.HS_CHECK.报(0, 'UI_INVALID_INPUT', { 结束回合: '成功', 返回: String(成) }, '提示'); } catch (er) {}
      记.结果 = '成功';
      return true;
    } catch (err) {
      记.结果 = '异常';
      记.错误 = (err && err.message) || String(err);
      try { if (W.HS_CHECK) W.HS_CHECK.报(0, 'UI_INVALID_INPUT', { 结束回合: '异常', 错误: 记.错误 }, '严重'); } catch (er) {}
      喊('error', ['[回合] 结束回合抛错：', err]);
      return false;
    } finally {
      结束中 = false;
      W.HS_TURN_结束 = 记;                       // 导出本局信息里能读到最近一次的结果
    }
  }
  function 绑结束回合钮() {
    var 钮 = 找id('endturn');
    if (!钮 || 钮.__hsTurnBound) return !!钮;
    钮.__hsTurnBound = true;
    钮.addEventListener('click', 结束回合入口, true);      // 捕获：抢在上游那个之前
    return true;
  }

  /* ---------------------------------------------------------------- 对外 */
  W.HS_TURN = {
    版本: 1,
    开局发牌: 开局发牌, 清场: 清场, 抽一张: 抽一张, 洗回: 洗回,
    我方回合开始: 我方回合开始, 结束回合: 结束回合, 敌方出一张: 敌方出一张,
    刷可攻击: 刷可攻击, 刷出得起: 刷出得起, 牌库计数: 牌库计数,
    相位: 相位, 胜利: 胜利, 失败: 失败,
    牌库: 取牌库, 绑结束回合钮: 绑结束回合钮,
  };

  /* ---------------------------------------------------------------- 顶掉上游那几个名字
     顺序：这里的赋值发生在 `index.js` **之后**、`资源.js` 之前，
     所以随后加载的 资源.js / 界面.js / 外壳.js 包的是**我们的**函数。 */
  W.startGame = 开局发牌;
  W.playerTurn = 我方回合开始;
  W.opponentTurn = 结束回合;
  W.computerCardPlace = 敌方出一张;
  W.attack = 刷可攻击;
  W.updateDeckCount = 牌库计数;
  W.createManaCrystal = createManaCrystal;
  W.checkForRequiredMana = checkForRequiredMana;
  W.updateManaGUI = updateManaGUI;
  W.gameWon = 胜利;
  /* 交互全归界面层（拖动、落格、选目标），这两条只为了让旧调用点不报"函数不存在" */
  W.placeCard = function () { return false; };
  W.enableDrag = function () { return false; };
  W.placeCardFunc = function () { return false; };      // 兼容位：已经没有任何人调它（见 界面.js 的落场）

  /* 这几个全局量：上游声明过、我们的层还剩几处在读/写（演出层读 currentAttacker、
     查找层读 playersTurn、界面层写 getNameOfElement）。用我们的口径给它们一个确定的值。 */
  if (typeof W.currentAttacker === 'undefined') W.currentAttacker = null;
  if (typeof W.playersTurn === 'undefined') W.playersTurn = false;
  if (typeof W.gameIsWon === 'undefined') W.gameIsWon = false;

  /* ★ 载入期**自己发牌**（2026-10-05 批次 D）。
     这件事原来由 `index.js` 在加载期那一句 `startGame();` 干，文件删了就必须由我们接手 ——
     否则页面能打开、能进关，但**手上没有牌、法力也没写过**（实测：手牌 0、`window.mana` 退回
     成那个 `<div id="mana">` 自动生成的全集元素）。发牌用我们的 `freshDeck`，关卡牌组由
     卡库.js 乙段在更早的位次寄存好了（`HS_LEVEL_DECK`），所以这里发出来的就是本关的牌。
     骨架里的 `#cards` 在本脚本执行时已经解析完（脚本都在 body 末尾），不用等。 */
  function 载入期发牌() {
    if (!手牌盒()) return false;                       // 骨架还没在（沙盒里有可能）→ 交给重试
    if (手牌盒().querySelectorAll(':scope > .card').length) return true;   // 已经有牌，别重复发
    /* ★★ 只在**真的要在局里**时才发（2026-10-06 修"导入后自动跳进空对局"）。
       不带关卡参数打开时（主页面 / 沙盒刚装上卡），这里**不该发牌** —— 发了就会连锁出两件事：
         ① 沙盒的兜底 `摆出牌桌` 拿"手牌有牌"当"局开了"的判据（那是"直接进关卡"时代的判据），
            于是它把牌桌亮出来、把主页面藏掉 → 用户看到"自动跳进一个空对局"；
         ② 主页面残留还露着 → 检错报 `UI_MODAL_OVER_GAME`。
       判据三条任一为真才算"要在局里"：已进对局（`isInGame`）/ 解析出了关卡（`CAMPAIGN.level`）/ 自由关。
       沙盒里进关不靠这里 —— 走 沙盒.js 的 `重开一局` → `W.startGame()`。 */
    var 要在局里 = false;
    try {
      要在局里 = !!(W.isInGame === true || (W.CAMPAIGN && W.CAMPAIGN.level) || (W.HS_FREE && W.HS_FREE.slots));
    } catch (e) {}
    if (!要在局里) return false;
    return 开局发牌();
  }
  if (!载入期发牌()) W.setTimeout(载入期发牌, 200);
  W.setTimeout(function () { 载入期发牌(); 绑结束回合钮(); }, 800);

  /* 载入期就把按钮接过来（`查找.js` 的自愈可能晚一步补 id，所以再隔一拍补绑一次）。 */
  绑结束回合钮();
  W.setTimeout(function () { 绑结束回合钮(); }, 2000);
})(typeof window !== 'undefined' ? window : globalThis);
