/* 关卡挑战版 · 沙盒适配层（游戏/沙盒.js —— 进 MMD 沙盒专用）
 * =====================================================================
 * 这是"把整个网页游戏装进 MMD 沙盒新页"的那一层薄适配。它做五件事：
 *
 *   ① **注入骨架**：游戏要 `index.html` 里那 258 行 DOM（`#game`/`#cards`/`#opposinghero`…），
 *      而沙盒页面里没有它们 —— 骨架由打包期从 index.html 抽出来、以字符串形式带进卡里，
 *      这一层在**游戏脚本之前**把它塞进 `sdk.stage.el()` 里的自有根节点。
 *      ⚠ 本文件必须是**打包顺序里的第一个模块**：后面每个模块在加载期就会去查这些节点。
 *   ② **页内换关**：独立网页版换关是 `location.href = '?level=N'` 整页重载 —— 在沙盒里
 *      那一下会把平台聊天页导航掉 ✗。所以注册 `W.HS_RESTART_HOOK`：清骨架 → 重新注入 →
 *      重开一局（全部用上游/我们自己已有的全局函数，不重跑本文件）。
 *   ③ **舞台开关**：`stage.open('full')` / `stage.close()`，"返回原生界面"由我们自己的按钮调。
 *   ④ **进度存档**：关卡进度仍走 `localStorage`（沙盒里按卡隔离、刷新不丢），
 *      另外镜像一份到 `sdk.save`（跨设备用；读档失败要 `try/catch`，且**不当作空档覆盖**）。
 *   ⑤ **不猜能力**：模型/会话/删除/回溯这些没有公开契约的按钮一律不做（见 说明/12-MMD实装.md）。
 *
 * 平台事实（照 `references/platforms/mmd-sandbox.md` 逐字抄，别改）：
 *   · `stage.el()` **关闭时也返回 DIV**（手册说返回 null 是错的）→ 判断开关只能用 `stage.visible()`
 *   · `stage.open(mode)` 的 mode 是 `'content' | 'full'`（我们打游戏用 `full`：整屏自绘）
 *   · `sdk.on('message:mount' | 'message:done' | 'stage:close')`；`sdk.on` 只能写在**脚本体顶层**
 *   · `sdk.save.get/set` 用 try/catch；key ≤64 且不含冒号
 */
(function (W) {
  'use strict';
  if (W.HS_SANDBOX) return;

  var 根 = null;                 // 我们自己的根节点（挂在 sdk.stage.el() 里）
  var 已开过 = false;             // 用户第一次打开之后就只更新状态，不再抢回舞台
  var 档键 = 'hsw_campaign_v1';   // 与 外壳.js 的 PROG_KEY 保持一致
  var 已启动 = false;

  function 有SDK() { return !!(W.sdk && W.sdk.stage && typeof W.sdk.stage.open === 'function'); }
  function 喊(fn, 参) { try { if (W.console && W.console[fn]) W.console[fn].apply(W.console, 参); } catch (e) {} }

  /* ---------------------------------------------------------------- 骨架 */
  function 骨架HTML() {
    if (typeof W.HS_SKELETON === 'string') return W.HS_SKELETON;      // 打包期注入的字符串
    return '';                                                        // 独立网页：DOM 本来就在
  }

  /* 把骨架放进我们自己的根节点。
     ⚠ **时序是硬要求**：游戏那些脚本（`index.js` 等）在**加载期**就 `document.querySelector`
       查 `#game` / `#cards` / `.opposinghero` —— 所以骨架必须在它们之前进 **document**，
       否则它们全都查不到节点、静默半死。
     做法：加载期就把根节点挂到 `document.body`（**先隐藏**、不碰舞台），
       用户打开时再把根**搬进** `sdk.stage.el()`（同一份文档内搬移，引用与绑定都不丢）。
       为什么不一开始就挂舞台：作者的脚本可能比舞台早，而且首屏该由用户触发（见指南 §5）。 */
  function 建根() {
    if (根 && 根.parentNode) return 根;
    var d = W.document;
    if (!d || !d.body) return null;
    根 = d.getElementById('hs-sandbox-root');
    if (!根) {
      根 = d.createElement('div');
      根.id = 'hs-sandbox-root';
      /* 舞台外用 fixed 占满视口（full 模式本来就交给 CSS 定位），先藏起来 */
      根.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;display:none;';
      d.body.appendChild(根);
    }
    return 根;
  }

  function 挂骨架() {
    if (!建根()) return false;
    if (!已启动) {
      根.innerHTML = 骨架HTML();          // 骨架字符串由打包期从 index.html 抽出（见 说明/12-MMD实装.md）
      已启动 = true;
    }
    return true;
  }

  /* 搬进舞台（同一文档内的搬移）。没有 SDK（独立网页）时什么都不做。 */
  function 搬进舞台() {
    if (!有SDK() || !根) return false;
    var 舞台 = null;
    try { 舞台 = W.sdk.stage.el(); } catch (e) { 喊('error', ['[沙盒] stage.el() 取不到：', e]); return false; }
    if (!舞台) return false;
    if (根.parentNode !== 舞台) 舞台.appendChild(根);
    根.style.display = 'block';
    return true;
  }

  /* ---------------------------------------------------------------- 重开一局（页内，不重载） */
  /* ★★ 一条硬教训（第一版就是错的）：**不能整块替换骨架**。
     上游 index.js 在加载期把一批 DOM 句柄缓存成了常量
     （`const hand = document.querySelector('#cards')`、`playerCardSlot2`、`manaElement`…），
     一换骨架它们全指向已摘除的旧节点 —— 于是"发牌"发到一个看不见的节点上（手牌永远是 0）。
     所以换关卡时**只清场、不换节点**：清空动态内容，再用同一批节点重新发牌。 */
  function 清场() {
    var d = W.document;
    var 手 = d.getElementById('cards');
    if (手) while (手.firstChild) 手.removeChild(手.firstChild);
    /* ⚠⚠ 只清**棋盘里**的单位（`.board .cardinplay`），不能写 `#game .cardinplay` ——
       **双方英雄框本身就是 `<div class="cardinplay" id="playerhero">`**（上游的标记就是这样）。
       写成宽的那版，换关清场会把两个英雄框**连根删掉**：症状是"没有双方玩家窗体"、
       自检报 SKELETON_INCOMPLETE（缺 playerhero/opposinghero）、英雄框变成 0×0 空壳。
       （2026-10-05 实测：清完 `.cardinplay` 总数为 0。） */
    var 卡 = d.querySelectorAll('#game .board .cardinplay');
    for (var i = 卡.length - 1; i >= 0; i--) if (卡[i].parentNode) 卡[i].parentNode.removeChild(卡[i]);
    var 法力盒 = d.getElementById('manacontainer');
    if (法力盒) while (法力盒.firstChild) 法力盒.removeChild(法力盒.firstChild);
    var 提示 = d.getElementById('hs-pick');
    if (提示) 提示.classList.remove('on');
    var 结束 = d.getElementById('endturn');
    if (结束) { 结束.innerText = 'END TURN'; 结束.style.backgroundColor = ''; }
    /* 回合相位那几样也要复位：`#computerTurn` 是上游的"ENEMY TURN"指示条，
       上一局如果停在敌方回合，它会留着 `display:block` —— 正压着结束回合按钮 ✗
       （用户 2026-10-04 报的"卡死了"就是这个；样式里也已给它加了 pointer-events:none 兜底）。 */
    var 相位 = d.getElementById('computerTurn');
    if (相位) 相位.style.display = 'none';
    /* 我们自己的**临时图层**一并复位：遮罩（渐变蒙版）/ 箭头 / 预览 / 提示条 / 结算条 / 演出图层。
       这几样都是"上一次操作留下的状态"，独立网页那条路靠整页重载清掉，页内重开必须自己清 ——
       用户 2026-10-04 报的"我的回合为什么会有遮罩"就是蒙版没清（跟"指示条盖住按钮""开始面板
       盖住手牌"是同一个家族：**页内重开时上一局的残留**）。 */
    ['hs-mask', 'hs-arrow', 'hs-preview', 'hs-pick', 'hs-report'].forEach(function (id) {
      var e = d.getElementById(id);
      if (e) e.classList.remove('on');
    });
    var 失败条 = d.getElementById('hs-losebar');
    if (失败条 && 失败条.parentNode) 失败条.parentNode.removeChild(失败条);
    var 飘字层 = d.querySelectorAll('#hs-fx, .hs-fx-ghost, .hs-fx-ring, .hs-fx-pop, .hs-fx-card');
    for (var k = 飘字层.length - 1; k >= 0; k--) if (飘字层[k].parentNode) 飘字层[k].parentNode.removeChild(飘字层[k]);
    // 场上格位数组（界面层持有）由下面的 HS_UI_REBOOT 清；这里先把残留的"已下场"标记抹掉
    var 幽灵 = d.querySelectorAll('.hs-fx-ghost');
    for (var j = 幽灵.length - 1; j >= 0; j--) if (幽灵[j].parentNode) 幽灵[j].parentNode.removeChild(幽灵[j]);
  }

  /* ★ 关掉我们自己的模态面板。沙盒里换关是**页内**重开，面板不会像整页重载那样自己消失 ——
     不关的话 `.hsp-panel`（开始游戏面板）会盖住整个战场：**用户报的"实际无手牌"就是这个**
     （牌其实在 DOM 里、数量也对，只是被自己人的面板压在下面，命中测试全落在面板上）。 */
  function 关面板() {
    var d = W.document;
    ['hs-codex', 'hs-start', 'campaign-overlay'].forEach(function (id) {
      var e = d.getElementById(id);
      if (e) e.classList.remove('on');
    });
    var 主面 = d.getElementById('hs-mainmenu');
    if (主面) 主面.style.display = 'none';
  }

  function 重开一局(配置) {
    配置 = 配置 || {};
    清场();
    关面板();

    /* 「回主菜单」（空配置）= 不重开对局，只把界面摆回主页面 */
    if (!配置.关卡 && !配置.自由档) {
      try { if (typeof W.HS_APPLY_LEVEL === 'function') W.HS_APPLY_LEVEL(0, 0); } catch (e) {}
      try { if (typeof W.CAMPAIGN_REBOOT === 'function') W.CAMPAIGN_REBOOT(); } catch (e) {}
      var 主面 = W.document.getElementById('hs-mainmenu');
      if (主面) 主面.style.display = '';
      var 内容 = W.document.getElementById('contents');
      if (内容) 内容.style.visibility = 'hidden';
      喊('log', ['[沙盒] 回到主页面']);
      return true;
    }

    /* ① 定这一局的形状与牌组（关卡 / 自由关档位）—— 就是 URL 那两条参数干的事 */
    if (typeof W.HS_APPLY_LEVEL === 'function') W.HS_APPLY_LEVEL(配置.关卡 || 0, 配置.自由档 || 0);

    /* ② 重开发牌与回合状态。用**上游已有的全局函数**，不重跑脚本：
          startGame() 会用新的 HS_LEVEL_DECK 重新洗牌发牌；法力本局从 1/1 起。 */
    try { if (W.HS_RESOURCE && W.HS_RESOURCE.设上限) { W.HS_RESOURCE.设上限(1); W.HS_RESOURCE.设法力(1); } } catch (e) {}
    try { if (typeof W.manaCapacity === 'number') W.manaCapacity = 1; } catch (e) {}
    try { if (typeof W.mana === 'number') W.mana = 1; } catch (e) {}
    var 成了 = true;
    try { if (typeof W.startGame === 'function') W.startGame(); else 成了 = false; }
    catch (e) { 喊('error', ['[沙盒] startGame 失败（发牌会由兜底接手）：', e]); 成了 = false; }
    /* 上游没发出手牌就自己发（见 兜底发牌 的说明）—— 手上没牌 = 玩家什么都做不了 */
    兜底发牌();

    /* ③ 把"谁绑在什么上"重新接好：上游那几件（出牌/拖拽/攻击处理器）+ 我们的两层重入。
       顺序要紧：先上游（它建 DOM 绑定），再外壳（它设档位/标题），最后界面（它按新格数重建）。 */
    try { if (typeof W.placeCard === 'function') W.placeCard(); } catch (e) {}
    try { if (typeof W.enableDrag === 'function') W.enableDrag(); } catch (e) {}
    try { if (typeof W.CAMPAIGN_REBOOT === 'function') W.CAMPAIGN_REBOOT(); } catch (e) { 喊('warn', ['[沙盒] 外壳重入失败：', e]); }
    try { if (typeof W.HS_UI_REBOOT === 'function') W.HS_UI_REBOOT(); } catch (e) { 喊('warn', ['[沙盒] 界面重入失败：', e]); }
    try { if (typeof W.attack === 'function') W.attack(); } catch (e) {}
    /* ④ 摆好对局画面（收主菜单、亮血条、隐藏对阵文字那一套） */
    try { if (W.CAMPAIGN_UI && typeof W.CAMPAIGN_UI.enterFight === 'function') W.CAMPAIGN_UI.enterFight(); } catch (e) {}
    /* ⑤ **收尾：血量元素 + 数值在这里再保证一次**（2026-10-04 实测：开局那串动作里
       有人把 `.playerHeroHealth` / `.opposingHeroHealth` 从 DOM 里弄掉了 —— 开局前它们还在
       「30」，开完一局 `querySelector` 就取不到，于是英雄框上没有血量数字，⑨ 也一直红。
       不管是谁弄掉的，**显示归我们**：缺了就补、有就写值（textContent，别用 innerText）。 */
    确保血量元素();
    try { if (typeof W.HS_APPLY_LEVEL === 'function') W.HS_APPLY_LEVEL(配置.关卡 || 0, 配置.自由档 || 0); } catch (e) {}
    /* ⑥ **收尾再清一遍临时状态**：上面那些重入动作里有几条会顺手把"待选 / 蒙版 / 预览"点亮
       （例如上一局挂着的待选一走 `进入待选` 就会 `applyMask`）—— 收尾清一次，保证
       "刚开的一局"是干净的：没有蒙版、没有待选、没有预览、没有箭头。 */
    try { if (W.HS_INTERACT && W.HS_INTERACT._放弃待选) W.HS_INTERACT._放弃待选('换了一局'); } catch (e) {}
    ['hs-mask', 'hs-arrow', 'hs-preview', 'hs-pick'].forEach(function (id) {
      var e = W.document.getElementById(id);
      if (e) e.classList.remove('on');
    });
    喊('log', ['[沙盒] 已开一局：', 配置, 成了 ? '' : '（startGame 没成功）']);
    /* ★ 局开起来了就把牌桌摆出来（页内重开这条路上，若上游那套"进入对局"没跑全，
       牌会发好但整张桌子还是藏着 —— 见 摆出牌桌 那段说明）。延迟一拍等发牌落地。 */
    try { W.setTimeout(function () { try { 摆出牌桌('页内重开完成'); } catch (e) {} }, 400); } catch (e) {}
    return 成了;
  }
  W.HS_RESTART_HOOK = function (配置) { return 重开一局(配置); };

  /* ---------------------------------------------------------------- 舞台开关 */
  function 打开(模式) {
    if (!有SDK()) return false;
    if (!根) 建根();
    if (!W.sdk.stage.visible()) W.sdk.stage.open(模式 || W.HS_SANDBOX.模式 || 'full');
    搬进舞台();
    已开过 = true;
    返回条(true);
    return true;
  }
  function 关闭() {
    if (!有SDK()) return false;
    try { if (W.sdk.stage.visible()) W.sdk.stage.close(); } catch (e) {}
    舞台关了();                                   // 与平台关舞台走同一个收尾（见下）
    return true;
  }

  /* 舞台"开着"的唯一判据（指南 §5.4：`stage.el()` 关着时**也返回节点**，不能拿节点判开关）。 */
  function 舞台可见() { try { return 有SDK() && !!W.sdk.stage.visible(); } catch (e) { return false; } }

  /* ★★ 关舞台的**唯一收尾**（2026-10-05 优化"退出舞台"）。
     指南 §5.5 写得很明白：作者主动 `stage.close()` **不会**触发 `stage:close` 事件，
     所以"我们那颗返回按钮"和"平台把舞台关掉（用户点了原生返回）"必须汇到**同一处**——
     原来这里两条路各写各的（都只删返回条），也就没法在这一拍做"停下来"的事：
       · 舞台关着的时候游戏还在跑，回来就是另一拍了（该走的时候走到哪，回来还是哪）；
       · 顺手把在飞的演出跳到终态（`skip`），别让它挂在半路。 */
  function 舞台关了() {
    返回条(false);
    try { if (W.HS_PIPELINE && typeof W.HS_PIPELINE.skip === 'function') W.HS_PIPELINE.skip(); } catch (e) {}
  }

  /* ★ 重开/后续消息时的"确认"（指南 §5.2 的可重入初始化）：
     平台可能**自己**把舞台打开（原生页那个"打开同层页"入口），那一拍我们只做两件该做的事 ——
     确认根还挂在舞台里、把返回条补回来；**不**调 `stage.open()`（§5.3：不许抢用户刚关掉的舞台）。 */
  function 确认舞台() {
    if (!舞台可见()) return false;
    if (根) 搬进舞台();
    /* ★ 顺手把根的 `display` 重新断言一次（2026-10-06）。
       `建根` 会把根设成 `display:none`（"舞台外先藏着"），此后由 `搬进舞台()` 恢复成 block ——
       但**平台/夹具自己那一拍**也可能把它设回 none（假舞台的初始化就是这样，实测出现过：
       `stage.visible()` 为真、根却 `display:none`，于是 `#game` 量出来 0×0、自检 ① 红）。
       这条**不改开关语义**（开关只看 `stage.visible()`），只是"既然认为开着，就把显示补上"。 */
    try { if (根 && 根.style) 根.style.display = 'block'; } catch (e) {}
    返回条(true);
    return true;
  }

  /* 舞台里的"返回原生界面"：平台原生页保留着打开同层页的入口，我们只负责关掉自己这一层。
     ⚠ 作者主动 `stage.close()` **不会**触发 `stage:close` 事件，所以暂停/状态更新两条路共用同一个函数。 */
  function 返回条(显示) {
    /* ★ 2026-10-06 用户要求：「把返回原生界面放在设置里」——
       原来这里在舞台**左上角**挂一条常驻小条（`#hs-backbar`），既占地方又和法力管挤在一起。
       现在这一层**不再自己建条**：入口挪进设置抽屉（index.html 的 `#backnativebutton`，
       由 游戏/菜单.js 接到 `HS_SANDBOX.关闭()`）。函数保留成空操作，免得别处调用点报错，
       也方便将来想回退（把下面这几行恢复即可）。 */
    if (1) return;
    if (!根) return;
    var 条 = 根.querySelector('#hs-backbar');
    if (!显示) { if (条) 条.remove(); return; }
    if (条) return;
    条 = W.document.createElement('div');
    条.id = 'hs-backbar';
    var 钮 = W.document.createElement('button');
    钮.id = 'hs-back-native';
    钮.textContent = '返回原生界面';
    钮.onclick = function () { 关闭(); };            // 顶层 bind（不是 inline onclick），沙盒里也稳
    条.appendChild(钮);
    根.appendChild(条);
  }

  /* ---------------------------------------------------------------- 进度存档（localStorage ↔ sdk.save） */
  function 读档() {
    var 本地 = null;
    try { 本地 = W.localStorage.getItem(档键); } catch (e) {}
    var 云端 = null;
    if (W.sdk && W.sdk.save && typeof W.sdk.save.get === 'function') {
      try { 云端 = W.sdk.save.get(档键); } catch (e) { 喊('warn', ['[沙盒] sdk.save.get 失败（瘦预览会同步抛）：', e]); }
    }
    /* 合并口径：**先到先用**，但只接受能解析的对象；两边都拿不到就什么都不做
       （绝不能把"读不到"当成"空档"去覆盖云端进度）。 */
    var 取到的 = (typeof 云端 === 'string' && 云端) ? 云端 : ((typeof 本地 === 'string' && 本地) ? 本地 : null);
    if (!取到的) return null;
    var 好 = null;
    try { 好 = JSON.parse(取到的); } catch (e) { 好 = null; }
    if (!好 || !好.cleared) return null;
    /* 让 外壳.js 在加载时读到的就是这份（它是从 localStorage 读进度的） */
    if (取到的 !== 本地) { try { W.localStorage.setItem(档键, 取到的); } catch (e) {} }
    return 好;
  }

  function 存档() {
    if (!W.sdk || !W.sdk.save || typeof W.sdk.save.set !== 'function') return;
    var 本地 = null;
    try { 本地 = W.localStorage.getItem(档键); } catch (e) {}
    if (!本地) return;
    try {
      var r = W.sdk.save.set(档键, 本地);
      if (r && typeof r.then === 'function') r.then(null, function (e) { 喊('warn', ['[沙盒] sdk.save.set 失败：', e]); });
    } catch (e) { 喊('warn', ['[沙盒] sdk.save.set 同步失败：', e]); }
  }

  /* ---------------------------------------------------------------- 三道防线（沙盒里上游的"退出"动作不能用） */
  /* 上游有三处会"离开这一页"：失败弹 alert、投降按钮 alert + reload、胜利序列末尾 location.reload。
     在独立网页里那是正常的收尾；**在沙盒里 reload 会把平台聊天页一起重载掉** ✗。
     我们的 外壳.js 早就接管了通关结算（记进度 + 下一关按钮）与失败结算（#hs-losebar），
     所以这三处一律拦下并留日志（免得静默）。 */
  function 设防线() {
    if (W.__hsGuard) return;
    W.__hsGuard = true;
    var 原alert = W.alert;
    W.alert = function (m) { 喊('warn', ['[沙盒] 拦下 alert（平台也会静默拦，这里留个痕）：', m]); };
    W.alert.__hsGuard = true;
    var 原st = W.setTimeout;
    if (typeof 原st === 'function' && !原st.__hsGuard) {
      var 包 = function (fn, 延时) {
        if (typeof fn === 'function') {
          var 体 = String(fn);
          if (体.indexOf('reload') >= 0 || 体.indexOf('location.href') >= 0) {
            喊('warn', ['[沙盒] 拦下会重载页面的定时器：', 体.slice(0, 140)]);
            return 0;
          }
        }
        return 原st.apply(W, arguments);
      };
      包.__hsGuard = true;
      W.setTimeout = 包;
    }
    // 投降按钮：点了就是 alert + reload，沙盒里没有意义（玩家可以直接关舞台）
    try {
      var 投 = W.document.getElementById('concedebutton');
      if (投) { 投.onclick = null; 投.style.display = 'none'; }
    } catch (e) {}
  }

  /* ★★ 保证那两颗"血量数字"元素**一定存在**（2026-10-04，实机"没有手牌"的追查结论）。
     上游 `startGame()` 的第一件事就是读 `.opposingHeroHealth` 嗅探"是不是教程"：
     `document.querySelector('.opposingHeroHealth').innerText` —— 元素**不存在**时它直接抛错，
     而抛错点之后的整段（发牌！）就不再执行 → 表现就是**英雄框里没有血量数字 + 手牌为空**，
     两件事同源。骨架里本来有这两个元素，但实机上没看到数字，所以这里做一次"有就用、没有就补"：
     缺了就按上游的结构补一个进 `.playerhero` / `.opponenthero`，并把数值写上（用 textContent）。 */
  function 确保血量元素() {
    var d = W.document;
    if (!d || !d.querySelector) return;
    [['.playerhero', '.playerHeroHealth', 30], ['.opponenthero', '.opposingHeroHealth', 30]].forEach(function (t) {
      var 宿主 = d.querySelector(t[0]);
      if (!宿主) return;
      if (!d.querySelector(t[1])) {
        var e = d.createElement('div');
        e.className = t[1].slice(1);
        e.textContent = String(t[2]);
        宿主.appendChild(e);
      }
    });
  }

  /* ★★ 兜底发牌：上游那条发牌路要是没把牌发出来（异常/规则不匹配），我们自己发。
     为什么敢自己发：牌库（`playerDeck`）与卡面工厂（`getPlayerCardsInHandHTML`）都在我们手里，
     手上没牌玩家就什么也做不了 —— 宁可"兜底发三张"，也不要"开局是空的"。 */
  function 兜底发牌() {
    var d = W.document;
    var 手 = d.getElementById('cards');
    if (!手 || 手.childElementCount > 0) return 0;
    var 库 = null;
    try { 库 = playerDeck.cards; } catch (e) { return 0; }      // playerDeck 是 index.js 的顶层 let
    if (!库 || !库.length) return 0;
    var 发 = 0;
    for (var i = 0; i < 库.length && 发 < 3; i++) {
      var c = 库[i];
      if (!c || typeof c.getPlayerCardsInHandHTML !== 'function') continue;
      try { 手.appendChild(c.getPlayerCardsInHandHTML()); 库.splice(i, 1); i--; 发++; } catch (e) {}
    }
    if (发 && typeof W.updateDeckCount === 'function') { try { W.updateDeckCount(); } catch (e) {} }
    if (发) 喊('warn', ['[沙盒] 上游没发出手牌，兜底发了 ' + 发 + ' 张']);
    return 发;
  }

  /* ★★ 可点性探针 + 屏幕上的错误条（2026-10-05 实机反馈）
     用户的描述很准："先建界面、后绑监听，中间一出错就可能剩个能看不能点的页面，
     而且报错浮于表面直接不显示出现了什么问题"。所以这里补两件事：

     ① **可点性探针**：拿 `elementFromPoint` 问几个关键按钮的**中心点**，最上面那个必须是它自己
        （或它的子节点）—— 不是就说明被别的图层盖住了。这正是"能看不能点"的机器判据
        （当年 `#fireworkCanvas` 吞点击就是这一族，而那时的自检全绿，因为它从没问过命中测试）。
     ② **可见错误条**：把检错层里的问题**显示在屏幕上**，不再只往 console 丢 ——
        玩家/测试者看一眼就知道"哪里不对、码是什么"，不用去翻控制台。

     两者都**幂等**（重复挂载不叠条），并且在挂载后延迟一拍跑（等界面建完）。 */
  function 可点性体检() {
    var d = W.document, 坏 = [];
    if (!d || !d.elementFromPoint) return 坏;
    /* ⚠ 前置条件：**得先"在局里"**。主页面开着时棋盘是隐藏的，按钮尺寸为 0 ——
       那不是"被盖住"，是"还没开局"。没有这一条，健康页面也会报三条假问题。
       （与页面自检 ㉚ 同一个口径：舞台不可见就不判。） */
    var 在局里 = (function () {
      var c = W.HS_UI_找id ? W.HS_UI_找id('contents') : d.getElementById('contents');
      var g = W.HS_UI_找id ? W.HS_UI_找id('game') : d.getElementById('game');
      if (!c || !g) return false;
      try {
        if (getComputedStyle(c).visibility === 'hidden') return false;
        var b = g.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      } catch (e) { return false; }
    })();
    if (!在局里) return 坏;
    [['#endturn', '结束回合'], ['#hs-settings', '设置'], ['#backnativebutton', '返回原生界面（在设置里）']].forEach(function (t) {
      var el = (W.HS_UI_找 ? W.HS_UI_找(t[0]) : d.querySelector(t[0]));
      if (!el) { 坏.push(t[1] + '：找不到元素'); return; }
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) { 坏.push(t[1] + '：尺寸为 0（没布局）'); return; }
      var top = d.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      if (top && (top === el || el.contains(top))) return;
      坏.push(t[1] + ' ← 被 ' + ((top && (top.id || top.className)) || '未知') + ' 盖住');
    });
    return 坏;
  }

  function 显示错误条() {
    if (!根) return [];
    var 行 = [];
    try {
      if (W.HS_CHECK && W.HS_CHECK.体检) {
        W.HS_CHECK.体检().问.forEach(function (x) { 行.push(x.层 + '/' + x.码); });
      }
    } catch (e) {}
    可点性体检().forEach(function (x) {
      行.push('点不到：' + x);
      try { if (W.HS_CHECK) W.HS_CHECK.报(6, 'UI_INVALID_INPUT', { 点不到: x, 说明: '关键按钮被盖住 / 没布局' }, '严重'); } catch (e) {}
    });
    var 条 = 根.querySelector('#hs-problembar');
    if (!行.length) { if (条) 条.remove(); return 行; }
    if (!条) {
      条 = W.document.createElement('div');
      条.id = 'hs-problembar';
      根.appendChild(条);
    }
    条.textContent = '⚠ 这个页面有问题：' + 行.slice(0, 3).join('  ·  ') + (行.length > 3 ? '  …（共 ' + 行.length + ' 条）' : '');
    return 行;
  }
  W.HS_SANDBOX_体检可点性 = 可点性体检;      // 自检与调试用
  W.HS_SANDBOX_错误条 = 显示错误条;

  /* ★★ 把牌桌**摆出来**（2026-10-05 实机/平台仿真共同暴露）
     症状：手牌已经发到 3 张（局确实开了），但 `#contents` 还是 `visibility:hidden`
     → **整张牌桌在屏幕上是空的**（用户："这上面什么都没有"），而自检却因为
     "舞台不可见就不判"那一层保护而全程报绿 —— 又一个"'检查'看不见'用户看得见'"的盲区。
     谁写的这个值：`外壳.js` 在"还没进局"时把它藏起来（:206），"进入对局"时再显示（:749，在 enterFight 里）。
     问题在于**显示那一句只挂在一条路径上**：只要实际开局走的不是那条路（沙盒里页内重开、
     宿主时序不同、或某一步失败），就会留下"局开了但牌桌藏着"的状态。
     所以这里加一道**幂等的兜底**：只要判断出"确实在局里"（手牌容器有牌 / 权威里有手牌），
     就把人放进去看 —— 并记一条提示，便于知道是谁漏了这一步。 */
  function 摆出牌桌(原因) {
    var d = W.document;
    if (!d) return false;
    var 牌 = null, 内容 = null;
    try {
      牌 = (W.HS_UI_找id ? W.HS_UI_找id('cards') : d.getElementById('cards'));
      内容 = (W.HS_UI_找id ? W.HS_UI_找id('contents') : d.getElementById('contents'));
    } catch (e) { return false; }
    if (!内容) return false;
    /* ★★ 判据从"手牌有牌"改成"**真的在局里**"（2026-10-06 修"导入后自动跳进空对局"）。
       原来拿手牌非空当"局开了"—— 那是"直接进关卡"时代的判据。现在 `游戏/回合.js`
       只在"要在局里"时才发牌，可这条兜底一旦在**别的时机**看到手上有牌（例如将来有人先发牌再进局、
       或页内换关的中途），就会把牌桌亮出来、把主页面藏掉，表现得像"自动跳进一个空对局"，
       同时主页面残留还露着 → 检错报 UI_MODAL_OVER_GAME。
       真正的"在局里"只有一个来源：`外壳.js` 的 `enterFight()` 会置 `W.isInGame = true`。 */
    var 在局里 = false;
    try { 在局里 = (W.isInGame === true); } catch (e) {}
    if (!在局里) return false;                            // 不在局里：不动（这是"在主页面"的正常状态）
    var 有牌 = !!(牌 && 牌.childElementCount > 0);
    var 现在已经看得见 = false;
    try { 现在已经看得见 = getComputedStyle(内容).visibility !== 'hidden'; } catch (e) {}
    if (现在已经看得见) return false;
    try {
      内容.style.visibility = 'visible';
      内容.style.opacity = '1';
      var 主面 = (W.HS_UI_找id ? W.HS_UI_找id('hs-mainmenu') : d.getElementById('hs-mainmenu'));
      if (主面) 主面.style.display = 'none';
      var 黑幕 = d.getElementById('block');
      if (黑幕) { 黑幕.style.visibility = 'hidden'; 黑幕.style.opacity = '0'; }
      if (W.HS_CHECK) W.HS_CHECK.报(6, 'UI_WRONG_SOURCE', { 兜底: '局开了但牌桌藏着，已摆出来', 原因: 原因 || '未知', 手牌: 牌 ? 牌.childElementCount : 0 }, '严重');
      喊('warn', ['[沙盒] 兜底摆出牌桌（' + (原因 || '未知') + '）']);
      return true;
    } catch (e) { return false; }
  }
  W.HS_SANDBOX_摆出牌桌 = 摆出牌桌;

  /* ---------------------------------------------------------------- 启动 */
  /* 加载期：**只建根 + 注入骨架**（骨架字符串是上一个模块给的）——
     这一步必须在游戏脚本之前完成，否则它们查不到节点。不在这里开舞台。 */
  挂骨架();
  /* ⚠ 必须在**下一个模块（index.js）之前**把血量元素补齐：index.js 一解析完就发牌，
     第一句就读 `.opposingHeroHealth` —— 元素不在那儿，后面整段发牌都不执行（实机"没有手牌"）。 */
  确保血量元素();
  if (有SDK()) 设防线();

  function 启动() {
    if (!有SDK()) return;                       // 独立网页：这一层整体是空转
    设防线();
    挂骨架();
    确保血量元素();                              // 上游发牌函数会读它，缺了会抛错（见该函数说明）
    /* ★ 显式叫一次外壳的引导：沙盒里脚本是"页面加载完之后"才跑的，`外壳.js` 自己的
       DOMContentLoaded 分支赶不上，而它执行时 `卡库.js` 还没加载 —— 不叫这一下，
       主页面不会建、上游那个 Play/Tutorial 菜单也不会隐藏（真机上就是"怎么是旧页面"）。 */
    try { if (typeof W.CAMPAIGN_BOOT === 'function') W.CAMPAIGN_BOOT(); } catch (e) { 喊('warn', ['[沙盒] 引导失败：', e]); }
    if (!已开过) 打开(W.HS_SANDBOX.模式);        // 首屏给一次机会，之后不再抢舞台
    else 确认舞台();                            // 已经开过：平台若已把舞台打开，就只确认根与返回条
    存档();
    /* 挂载后延迟一拍：① 局要是开起来了，就把牌桌摆出来（见 摆出牌桌 那段）；
       ② 再跑"可点性 + 可见错误条"。
       为什么要延迟：`启动` 这一拍主页面才刚建、尺寸还没算出来，`elementFromPoint` 会误判。 */
    try { W.setTimeout(function () { try { 摆出牌桌('挂载后'); } catch (e) {} }, 800); } catch (e) {}
    try { W.setTimeout(function () { try { 显示错误条(); } catch (e) {} }, 1400); } catch (e) {}
  }

  /* 没有 message:mount 也要能引导（瘦预览等场景）：加载后几次重试，
     等我们自己的模块都到位再叫一次。有一次性闸，多叫无副作用。 */
  (function 兜底引导() {
    var 次 = 0;
    (function 试() {
      if (typeof W.CAMPAIGN_BOOT === 'function') {
        try { W.CAMPAIGN_BOOT(); } catch (e) {}
        if (W.document && W.document.getElementById('hs-mainmenu')) return;   // 已经建起来了
      }
      if (次++ < 40) W.setTimeout(试, 100);
    })();
  })();

  W.HS_SANDBOX = {
    版本: 1,
    有SDK: 有SDK,
    挂骨架: 挂骨架,
    根: function () { return 根; },
    打开: 打开,
    关闭: 关闭,
    重开一局: 重开一局,
    关面板: 关面板,                              // 检错层的"回到安全节点"要用（界面登记恢复时调它）
    舞台可见: 舞台可见,                          // 判"舞台开着"只看这个（§5.4）
    确认舞台: 确认舞台,                          // 重开/后续消息时确认根与返回条（不抢舞台）
    读档: 读档,
    存档: 存档,
    模式: 'full'                                 // 打游戏要整屏；想"边聊边玩"就改成 'content'
  };

  if (有SDK()) {
    读档();                                     // 在 外壳.js 之前把云端进度落到 localStorage
    try { W.sdk.on('message:mount', 启动); } catch (e) { 喊('warn', ['[沙盒] message:mount 订阅失败：', e]); }
    try { W.sdk.on('message:done', function () { if (根) 存档(); 确认舞台(); }); } catch (e) {}
    /* 平台把舞台关掉 → 走同一套收尾（§5.5） */
    try { W.sdk.on('stage:close', function () { 舞台关了(); }); } catch (e) {}
  }
})(typeof window !== 'undefined' ? window : globalThis);
