/* 关卡挑战版 · 外壳（去炉石化 / 开场清理 / 关卡与进度）
 * ===============================================================
 * 一个文件装两件事（少而大，是「能压进 MMD 卡」的硬要求：每条正则 ≤ 18000 UTF-16）
 *   甲段（原 strip.js）    —— 静音 / 去卡图 / 开场清理
 *   乙段（原 campaign.js） —— 关卡列表 UI / 进度存档 / AI 三档 / 通关结算
 * 两段各自一个 IIFE，互不共享作用域，只通过 window 上的全局量打交道。
 *
 * 本文件必须**排在最前**（index.html 里紧跟在 deck.js 之后）：
 *   甲段要赶在 index.js / AI.js / elementsController.js 造 Audio 之前，
 *   也要赶在 卡库.js 抓 freshDeck 之前；乙段把副作用全部推迟到 DOMContentLoaded。
 *
 * —— 甲段：去炉石化（行为）——
 * 上游是 2019 年那个「炉石网页克隆」，满身都是暴雪的东西：开场影片、看板娘问候、
 * 牌桌背景、英雄立绘、卡背、金币字体（Belwe）。这一层负责把**行为**摘掉，
 * **外观**在 游戏/样式.css 里。
 *
 * 为什么行为在这一层做，而不是去改上游那 4 个文件：
 *   上游在 load.js / index.js / AI.js / elementsController.js 里到处 `new Audio(...)`、
 *   到处 `document.querySelector('.playerhero').style.backgroundImage = ...`。
 *   挨个删等于把上游改烂，「这份 fork 与上游差在哪」就说不清了。
 *   所以这里改的是**能力**，不是调用点 —— 想恢复就把 index.html 里这一行 <script> 删掉。
 *
 * 甲段做三件事：
 *   ① 静音        window.Audio 换空壳（并按住 HTMLMediaElement.play/pause/load）
 *   ② 去卡图      包一层 freshDeck，把每张卡的 imageString 清成 1×1 透明图
 *   ③ 开场清理    跳过「点击继续」门槛 / 首访不再卡在空等的教程 / 换掉 <title>
 *
 * 外观（压平背景引用、停入场动效、简洁窗体配色）全在
 * 游戏/样式.css —— 由 index.html 在 <head> 里加载，**必须比 body 早**：
 * background-image 的请求在解析 body 的那一刻就发出去了，等脚本跑起来再压平已经晚了。
 */
(function (W) {
  'use strict';

  if (W.__hsStrip) return;              // 幂等：创卡页预览会重跑脚本
  W.__hsStrip = true;

  /* =============================== 开关 =============================== */

  // 应用名（<title> 用）。我们自己的名字定下来之后改这里一处即可。
  W.HS_APP_NAME = W.HS_APP_NAME || '卡牌对战';

  // 关掉上游那道「Click anywhere to continue」开场门槛。
  // 它本来是绕浏览器自动播放限制用的（要先有点击手势才能出声）；我们已经没有音频了，
  // 门槛就只剩挡路。置 false 可以把它恢复回来。
  var SKIP_STARTUP_GATE = true;

  // 首次访问时不让上游强制进教程。教程的开场影片已经摘掉，强制进去会空等 48 秒
  // 才出现开始按钮。主菜单里的「Tutorial」按钮照常可用。
  var SKIP_FORCED_TUTORIAL = true;

  /* ============================ ① 静音 ============================ */

  function SilentMedia(src) {
    this.src = src || '';
    this.currentSrc = this.src;
    this.volume = 1;
    this.muted = true;
    this.loop = false;
    this.paused = true;      // 上游用 typeof x.loop == 'boolean' 判分支，必须是普通布尔
    this.currentTime = 0;
    this.duration = 0;
    this.readyState = 0;
    this.networkState = 0;
    this.error = null;
  }
  SilentMedia.prototype.play = function () { return Promise.resolve(); };
  SilentMedia.prototype.pause = function () {};
  SilentMedia.prototype.load = function () {};
  SilentMedia.prototype.canPlayType = function () { return ''; };
  SilentMedia.prototype.addEventListener = function () {};
  SilentMedia.prototype.removeEventListener = function () {};
  SilentMedia.prototype.dispatchEvent = function () { return true; };
  SilentMedia.prototype.cloneNode = function () { return new SilentMedia(this.src); };

  W.Audio = SilentMedia;

  /* ⚠ 垫全局量必须排在这一句**之后**（它要用新的 `W.Audio` 造反静音空壳）、
     但仍要在**加载期**执行：上游文件在解析时就可能读那些名字
     （`elementsController.js` 在加载时就把门槛的 onclick 装好，跑起来就会读它们）。
     早先放错位置（在 `W.Audio` 替换之前）→ 桩 DOM 里 `Audio` 不存在，一装就抛。 */
  stubSilentGlobals();

  // <video> 走的是真的 HTMLMediaElement，得从原型上按住
  try {
    var proto = W.HTMLMediaElement && W.HTMLMediaElement.prototype;
    if (proto) {
      proto.play = function () { return Promise.resolve(); };
      proto.pause = function () {};
      proto.load = function () {};
    }
  } catch (e) { /* 极老环境没有 HTMLMediaElement，忽略 */ }

  /* ============================ ② 去卡图 ============================ */
  /* ★ 2026-10-03：**这一段不再需要了** —— 卡数据与卡面渲染都归我们自己的了
     （游戏/卡库.js 的丙段是 37 张卡的数据、丁段是卡面工厂）。
     我们造的卡**本来就没有 `imageString`**，所以"去卡图"这件事从"运行时包一层"变成了
     **由构造保证**：没有图可去。
     以前那版是包一层上游 `freshDeck`、把每张卡的 `imageString` 换成 1×1 透明图，
     还带一条硬约束（本文件必须排在 levels.js 抓 freshDeck 之前）—— 现在两条一起消失。
     想给自己的卡挂图：改 游戏/卡库.js 丁段里的 造场上卡（那里是唯一入口）。 */

  /* ==================== ④ 垫上"被摘文件定义过的全局量" ====================
     **批次 0 摘掉了七个上游脚本**（load.js / fps.js / pack_handler.js / snow.js / time.js /
     testing.js / window_focus.js）。它们自己没用了，但**它们当年往 window 上挂过全局量**，
     而**别的上游文件会裸读这些名字** —— 少一个就是 ReferenceError，而且往往发生在
     **事件处理器里**，把整段流程静默打断（实测踩到：`mainmenuOST.pause()` 一抛，
     门槛 onclick 直接中断，我们排在它后面那句"进对局"再也执行不到，整局进不去）。

     所以照 strip.js 的老办法：**把能力垫上，不改调用点**（这里连名字都照旧）。
     谁读这些名字（已核对）：
       · `elementsController.js` 读 `mainmenuOST` / `crowdSnd`（菜单音乐的淡出与暂停，多处）、
         `createPack()`（商店买包的收尾）
       · `load.js`（已摘）当年那串金币/卡包显示需要 `myGold`/`myPacks` —— 那是**读 localStorage 的局部变量**，
         不是全局量，所以不用垫
       · `testing.js` 的 `numOfTests`/`snapshots` 等**零引用**，不用垫
     用 `new W.Audio('')` 造静音空壳（`W.Audio` 已经被上面换成 SilentMedia），
     于是 `.play()/.pause()/.volume = n` 全都安全且无声。 */
  function stubSilentGlobals() {
    var 名 = ['mainmenuOST', 'crowdSnd', 'voiceover', 'item', 'items'];
    for (var i = 0; i < 名.length; i++) {
      if (W[名[i]] === undefined) W[名[i]] = (名[i] === 'item' || 名[i] === 'items') ? '' : new W.Audio('');
    }
    if (W.items === '') W.items = [];
    /* `hasPlayedTutorial_deserailized`：load.js 当年是**加载时**读 localStorage 得来的
       （`JSON.parse(localStorage.getItem('hasPlayedTutorial'))` → 通常是 null）。
       上游门槛 onclick 就是按它分支（null → 强制教程 / 非 null → 显示主菜单），
       所以这里照原样补上；关卡那条路稍后会把它改成 'campaign'（见 hookEntry）。 */
    if (W.hasPlayedTutorial_deserailized === undefined) {
      try {
        W.hasPlayedTutorial_deserailized = JSON.parse(W.localStorage.getItem('hasPlayedTutorial'));
      } catch (e) { W.hasPlayedTutorial_deserailized = null; }
    }
    /* `createPack()`：上游商店里买包的收尾会调它（我们没做开包，垫一个空函数即可） */
    if (typeof W.createPack !== 'function') W.createPack = function () {};
  }

  /* ========================== ③ 开场清理 ========================== */

  // 上游 index.html 里的 <video id="cinematicVideo"> 指向一段开场影片。影片不随包分发，
  // 组装时已经把那一行摘掉了；这里再兜一次底，防止有人把 <source> 加回来。
  // 只清 src、**不删元素** —— playbtn.onclick 会取它的 style.display，元素没了会抛错。
  function blankVideo() {
    var d = W.document;
    if (!d || !d.getElementById) return;
    var v = d.getElementById('cinematicVideo');
    if (!v) return;
    v.removeAttribute('src');
    v.setAttribute('preload', 'none');
    var sources = v.getElementsByTagName('source');
    for (var i = 0; i < sources.length; i++) sources[i].removeAttribute('src');
  }

  function patchTitle() {
    var d = W.document;
    if (!d) return;
    // 上游 <title> 写着 Hearthstone；关卡页的标题由 campaign.js 接管
    if (!d.title || d.title === 'Hearthstone') d.title = W.HS_APP_NAME;
  }

  function skipForcedTutorial() {
    if (!SKIP_FORCED_TUTORIAL) return;
    try {
      if (W.localStorage.getItem('hasPlayedTutorial') === null) {
        // 只把哨兵置上，让上游走「显示主菜单」那条分支。教程本身没删，
        // 主菜单里的 Tutorial 按钮照样能进（进去后点 Skip ▶ 跳过已摘掉的开场影片）。
        W.localStorage.setItem('hasPlayedTutorial', JSON.stringify('true'));
      }
    } catch (e) { /* 隐私模式等，忽略 */ }
  }

  function skipStartupGate() {
    if (!SKIP_STARTUP_GATE) return;
    var d = W.document;
    var gate = d.getElementById('preventCORS');
    if (!gate) return;
    /* 不是「隐藏它」，而是替玩家点一下：上游那个 onclick 里既切主菜单、也可能进教程，
       事件链条照走，只是不用人点。
       ⚠ **2026-10-03 批次 0 摘掉 load.js 之后，这里有一处必须改**：原来这几行是
         `if (getComputedStyle(gate).visibility === 'hidden') return; gate.click();`
         —— 等 load.js 在 readyState=complete 后把它亮出来再点。load.js 一摘，就**没人亮它了**，
       于是这句永远 return，**整局都进不去**（实测踩到：血量、法力全空，`#contents` 一直 hidden）。
       我们本来就是要「跳过这个门槛」，所以直接点：**元素不需要可见，`click()` 照样触发它的处理器**。 */
    /* ⚠ 2026-10-05（批次 D）：`gate.click()` 原来是为了跑**上游那个 onclick**——
       它既切主菜单、也可能进教程。那个处理器写在 `src/scripts/elementsController.js` 里，
       而那个文件已经**整个删除**了：再点它就是一个没有任何处理器的空元素，点了什么都不发生，
       门槛层（"Click anywhere to continue..."）会一直盖在页面上挡住所有点击。
       所以现在**我们自己负责把它收掉**：先照旧点一下（万一还有处理器就顺带走一遍），
       然后无条件隐藏 —— 这是我们的生命周期该干的事（见 说明/15 第 ② 件）。 */
    try { gate.click(); } catch (e) {}
    gate.style.display = 'none';
    gate.style.visibility = 'hidden';
  }

  function boot() {
    hideContentsAtFirst();      // 原来是 load.js 干的活（见下）
    blankVideo();
    patchTitle();
    skipForcedTutorial();
    W.setTimeout(skipStartupGate, 700);
  }

  /* 开场先把 `#contents`（对局区）藏起来 —— 这本来是上游 load.js 在 `readyState === 'interactive'`
     那一刻做的事。**批次 0 把 load.js 摘掉了**，所以这一条接管过来：不接管的话，页面一加载就能
     看到底下的棋盘从主菜单后面透出来。
     谁负责把它亮回来：关卡路径是 外壳.js 的 enterFight()（选完关直接进对局）；
     自由对战那条路是上游 elementsController.js（它本来就在菜单开合时改 `#contents`）。
     只改可见性、不碰别的（load.js 剩下的部分——隐藏 `#load`——由 游戏/样式.css 的
     `#load{display:none}` 顶着，那更彻底）。 */
  function hideContentsAtFirst() {
    var d = W.document;
    var c = d && d.getElementById('contents');
    if (!c) return false;
    c.style.visibility = 'hidden';
    return true;
  }

  if (W.document && W.document.readyState === 'loading') {
    W.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 调试台用：看看这一层做了哪几件事、哪些开关是开的
  W.HS_STRIP = {
    skipStartupGate: SKIP_STARTUP_GATE,
    skipForcedTutorial: SKIP_FORCED_TUTORIAL,
    appName: W.HS_APP_NAME,
    stylesheet: '游戏/样式.css',            // 外观在那边
    // 「去卡图」现在是**构造保证**：卡由 游戏/卡库.js 丁段造，本来就不带 imageString
    去卡图: '构造保证（见 卡库.js 丁段）'
  };
})(typeof window !== 'undefined' ? window : globalThis);


/* 关卡挑战版 · 关卡层（原 campaign.js，现为 外壳.js 的乙段）
 * ---------------------------------------------------------------
 * 上游（Rymedy/hearthstone-web，MIT）只有「一场无尽对局」：主菜单点 Play 就打巫妖王，赢了发金币。
 * 本段在**不改上游任何源码**的前提下，加上「关卡挑战」这一层：
 *
 *   · 关卡列表 + 进度存档（localStorage）—— 逐关解锁，通关记一笔
 *   · 选关后整页重载到 ?level=N，由 卡库.js 里的前置钩子换牌组与血量
 *   · 对手 AI 分三档（新手 / 熟练 / 大师）—— **设进我们自己的决策层**（游戏/决策.js，阶段 E）：
 *       2026-10-03 之前这里包的是上游的 `computerCardPlace()`（出哪张）与 `AI()`（打谁），
 *       而那两个函数那时已经没人调用了（敌方那一拍由 界面.js 的规划器自己规划、自己施加），
 *       包在死函数上等于**三档全废**；现在直接 `HS_DECIDE.设档(TIER)`。
 *   · 通关后给「下一关 / 重打 / 返回」三个按钮
 *
 * 包装而不改写，是因为上游是几万行的全局脚本（index.js 17KB、elementsController.js 48KB），
 * 任何直接编辑都会让「这份 fork 与上游的差异」变得说不清。包装层可以整份删掉，上游照样能跑。
 *
 * 注意加载位次：本文件排在 卡库.js **之前**，所以顶层**不能**读 CAMPAIGN_DATA / CAMPAIGN
 * （此刻它们还没挂上）—— 那两个值改在 boot()（DOMContentLoaded）里取。
 */
(function (W) {
  'use strict';

  if (W.__hsCampaign) return;         // 幂等：创卡页预览会重跑脚本
  W.__hsCampaign = true;

  var D = null;                       // 卡谱/关卡表，boot() 里从 W.CAMPAIGN_DATA 取
  var PROG_KEY = 'hsw_campaign_v1';

  /* ------------------------------ 进度存档 ------------------------------ */

  function loadProg() {
    try {
      var raw = W.localStorage.getItem(PROG_KEY);
      var o = raw ? JSON.parse(raw) : null;
      if (o && Object.prototype.toString.call(o.cleared) === '[object Array]') return o;
    } catch (e) { /* 读坏了就当新档，不阻断游戏 */ }
    return { cleared: [] };
  }
  function saveProg(p) {
    try { W.localStorage.setItem(PROG_KEY, JSON.stringify(p)); } catch (e) { /* 隐私模式等，忽略 */ }
  }
  var PROG = loadProg();

  function isCleared(id) { return PROG.cleared.indexOf(id) >= 0; }
  function markCleared(id) {
    if (!isCleared(id)) { PROG.cleared.push(id); PROG.cleared.sort(); saveProg(PROG); }
  }
  // 逐关解锁：第一关永远可打，第 N 关要求第 N-1 关已通关
  function isUnlocked(id) {
    if (id <= 1) return true;
    return isCleared(id - 1);
  }

  var TIER_NAME = ['新手', '熟练', '大师'];

  /* ------------------------------ 样式与界面 ------------------------------ */

  var CSS = [
    '#campaignbutton{width:13%;height:3.5%;position:absolute;top:57.2%;left:43%;',
    'background-color:#e6c4a9;color:#4f3a1b;border-radius:30px/200%;font-family:BelweBdBTBold;',
    'user-select:none;z-index:20;outline:none;border:none;cursor:pointer;}',
    '#campaignbutton:hover{background-color:#fffeea;}',
    '#campaign-goldborder{width:13.6%;height:4.75%;position:absolute;top:56.5%;left:42.75%;',
    'border-radius:30px/175%;background:linear-gradient(to top right,#653517,#e6c279);}',
    '#campaign-overlay{position:fixed;inset:0;background:rgba(8,10,16,.86);z-index:9998;',
    'display:none;align-items:center;justify-content:center;font-family:BelweBdBTBold,serif;}',
    '#campaign-overlay.on{display:flex;}',
    '#campaign-panel{width:min(760px,92vw);max-height:88vh;overflow:auto;padding:22px 26px 18px;',
    'background:#161c26;border:2px solid #e6c279;border-radius:14px;color:#e8dcc0;',
    'box-shadow:0 18px 60px rgba(0,0,0,.7);}',
    '#campaign-panel h2{margin:0 0 2px;font-size:24px;color:#f0d79a;letter-spacing:2px;}',
    '.campaign-sub{margin:0 0 16px;font-size:13px;color:#8fa0b5;font-family:sans-serif;}',
    '.campaign-row{display:flex;align-items:center;gap:14px;padding:10px 12px;margin-bottom:8px;',
    'border:1px solid #2c3a4d;border-radius:10px;background:#1c2430;font-family:sans-serif;}',
    '.campaign-row.locked{opacity:.45;}',
    '.campaign-row .lv-name{font-family:BelweBdBTBold,serif;font-size:16px;color:#f0d79a;min-width:150px;}',
    '.campaign-row .lv-meta{flex:1;font-size:12px;color:#a8b6c8;line-height:1.5;}',
    '.campaign-row .lv-tag{display:inline-block;padding:1px 7px;margin-right:6px;border-radius:8px;',
    'font-size:11px;background:#2c3a4d;color:#cbd6e4;}',
    '.campaign-row .lv-tag.t0{background:#2f4130;color:#9fe0a0;}',
    '.campaign-row .lv-tag.t1{background:#3a3a1f;color:#e8d98a;}',
    '.campaign-row .lv-tag.t2{background:#4a2226;color:#ff9f9f;}',
    '.campaign-row .lv-clear{font-size:12px;color:#9fe0a0;min-width:58px;text-align:right;}',
    '.campaign-btn{padding:7px 16px;border-radius:8px;border:1px solid #e6c279;background:#e6c4a9;',
    'color:#4f3a1b;font-family:BelweBdBTBold,serif;cursor:pointer;}',
    '.campaign-btn:hover{background:#fffeea;}',
    '.campaign-btn.ghost{background:transparent;color:#cbb98f;}',
    '.campaign-btn[disabled]{opacity:.4;cursor:not-allowed;}',
    '#campaign-foot{display:flex;justify-content:space-between;align-items:center;margin-top:12px;}',
    '#campaign-foot small{color:#7d8ea3;font-family:sans-serif;}',
    '#campaign-afterwin{position:fixed;left:50%;bottom:6%;transform:translateX(-50%);z-index:9999;',
    'display:none;gap:12px;}',
    '#campaign-afterwin.on{display:flex;}',
    /* ——— 主页面（用户 2026-10-03：卡牌图鉴 / 开始游戏 / 更多内容） ———
       上游那个 #mainmenu（Play · Tutorial · Shop · 开包……）从此不显示：它上面能点的东西
       我们一个都不用。主页面是自己的，所以样式也自己写，只沿用同一套配色（#161c26 面板 + #e6c279 金边）。 */
    '#hs-mainmenu{position:fixed;inset:0;z-index:9990;display:flex;flex-direction:column;',
    'align-items:center;justify-content:center;gap:14px;background:#0b0f16;',
    'font-family:BelweBdBTBold,serif;color:#e8dcc0;}',
    '#hs-mainmenu .hsm-title{font-size:34px;letter-spacing:6px;color:#f0d79a;}',
    '#hs-mainmenu .hsm-sub{font-size:13px;color:#8fa0b5;font-family:sans-serif;}',
    '#hs-mainmenu .hsm-grid{display:flex;gap:16px;flex-wrap:wrap;justify-content:center;margin-top:10px;}',
    '#hs-mainmenu .hsm-card{width:230px;min-height:122px;padding:16px;border-radius:14px;',
    'border:2px solid #e6c279;background:#161c26;color:#e8dcc0;cursor:pointer;text-align:left;',
    'font-family:BelweBdBTBold,serif;display:flex;flex-direction:column;gap:8px;}',
    '#hs-mainmenu .hsm-card:hover{background:#1e2733;}',
    '#hs-mainmenu .hsm-name{font-size:19px;color:#f0d79a;letter-spacing:2px;}',
    '#hs-mainmenu .hsm-desc{font-size:12px;line-height:1.6;color:#9fb0c4;font-family:sans-serif;}',
    '#hs-mainmenu .hsm-foot{font-size:12px;color:#6f8098;font-family:sans-serif;margin-top:6px;}',
    '#hsm-toast{position:fixed;left:50%;bottom:8%;transform:translateX(-50%);z-index:9999;',
    'padding:8px 16px;border-radius:10px;background:#161c26;border:1px solid #e6c279;color:#f0d79a;',
    'font-family:sans-serif;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none;}',
    '#hsm-toast.on{opacity:1;}',
    '#hs-start,#hs-codex{position:fixed;inset:0;background:rgba(8,10,16,.9);z-index:9991;',
    'display:none;align-items:center;justify-content:center;}',
    '#hs-start.on,#hs-codex.on{display:flex;}',
    '.hsp-panel{width:min(880px,94vw);max-height:90vh;overflow:auto;padding:20px 24px 16px;',
    'background:#161c26;border:2px solid #e6c279;border-radius:14px;color:#e8dcc0;}',
    '.hsp-panel h2{margin:0 0 10px;font-size:22px;color:#f0d79a;letter-spacing:2px;}',
    '.hsp-h{margin:14px 0 8px;font-size:14px;color:#f0d79a;font-family:BelweBdBTBold,serif;}',
    '.hsp-h small{color:#8fa0b5;font-family:sans-serif;font-size:12px;margin-left:8px;}',
    '.hsp-seg{display:flex;gap:10px;}',
    '.hsp-foot{display:flex;justify-content:flex-end;margin-top:14px;}',
    '.hsc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(152px,1fr));gap:8px;}',
    '.hsc-item{border:1px solid #2c3a4d;border-radius:9px;padding:8px 9px;background:#1c2430;',
    'font-family:sans-serif;}',
    '.hsc-num{display:flex;gap:8px;font-family:BelweBdBTBold,serif;font-size:14px;margin-bottom:2px;}',
    '.hsc-mana{color:#5fa8ff;}', '.hsc-atk{color:#ffd479;}', '.hsc-hp{color:#ff8a7a;}',
    '.hsc-name{font-family:BelweBdBTBold,serif;font-size:13px;color:#f0d79a;}',
    '.hsc-kw{font-size:11px;color:#9fe0a0;margin-top:2px;}',
    '.hsc-info{font-size:11px;color:#8b9cb0;margin-top:3px;line-height:1.5;}'
  ].join('');

  function el(tag, cls, text) {
    var e = W.document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function injectStyle() {
    var s = W.document.createElement('style');
    s.id = 'campaign-style';
    s.textContent = CSS;
    W.document.head.appendChild(s);
  }

  var overlay = null;

  function buildOverlay() {
    overlay = el('div');
    overlay.id = 'campaign-overlay';

    var panel = el('div');
    panel.id = 'campaign-panel';
    panel.appendChild(el('h2', null, '关卡挑战'));
    panel.appendChild(el('p', 'campaign-sub', '单人闯关 · 全程无联机对战 · 进度存在本机'));

    var list = el('div');
    list.id = 'campaign-list';
    panel.appendChild(list);

    var foot = el('div');
    foot.id = 'campaign-foot';
    var reset = el('button', 'campaign-btn ghost', '清空进度');
    reset.onclick = function () {
      if (W.confirm('清空全部关卡进度？')) { PROG = { cleared: [] }; saveProg(PROG); renderList(); }
    };
    var close = el('button', 'campaign-btn', '返回主菜单');
    close.onclick = function () { overlay.classList.remove('on'); };
    foot.appendChild(reset);
    foot.appendChild(el('small', null, '进度存在浏览器本机（localStorage），换设备/清缓存即丢失'));
    foot.appendChild(close);
    panel.appendChild(foot);

    overlay.appendChild(panel);
    overlay.onclick = function (e) { if (e.target === overlay) overlay.classList.remove('on'); };
    ((W.HS_UI_宿主 && W.HS_UI_宿主()) || W.document.body).appendChild(overlay);
    return list;
  }

  var listEl = null;

  /* 关卡行的渲染：**写进谁给的容器**（用户 2026-10-03 之后有两处要用它 ——
     原来的「关卡列表」浮层，和新主页面的「开始游戏 → 挑战关」）。 */
  function renderLevels(box) {
    if (!box) return;
    box.innerHTML = '';
    var levels = W.CAMPAIGN_LEVELS;
    for (var i = 0; i < levels.length; i++) {
      (function (lv) {
        var unlocked = isUnlocked(lv.id);
        var row = el('div', 'campaign-row' + (unlocked ? '' : ' locked'));

        row.appendChild(el('div', 'lv-name', lv.name));

        var meta = el('div', 'lv-meta');
        var tag = el('span', 'lv-tag t' + lv.tier, 'AI ' + TIER_NAME[lv.tier]);
        meta.appendChild(tag);
        meta.appendChild(W.document.createTextNode(
          '对手：' + lv.opponentLabel + '　血量 ' + lv.playerHp + ' : ' + lv.opponentHp +
          '　格数 ' + (lv.slots || lv.id)));
        var blurb = el('div', null, lv.blurb);
        blurb.style.marginTop = '3px';
        blurb.style.color = '#8b9cb0';
        meta.appendChild(blurb);
        row.appendChild(meta);

        row.appendChild(el('div', 'lv-clear', isCleared(lv.id) ? '✔ 已通关' : ''));

        var btn = el('button', 'campaign-btn', unlocked ? '挑战' : '未解锁');
        btn.disabled = !unlocked;
        btn.onclick = function () { enterLevel(lv.id); };
        row.appendChild(btn);

        box.appendChild(row);
      })(levels[i]);
    }
  }

  function renderList() { renderLevels(listEl); }

  function openSelect() {
    renderList();
    overlay.classList.add('on');
  }

  // 换关 = 整页重载到 ?level=N（牌组与血量只有在 index.js 跑之前才改得动，见 campaign-pre.js）
  //
  // ★ 2026-10-03（进沙盒）：**沙盒里不能整页重载** —— `location.href` 那一下会把平台的
  //   聊天页导航掉 ✗。所以这里留一个**页内重开钩子**：沙盒适配层（游戏/沙盒.js）加载时
  //   把 `W.HS_RESTART_HOOK` 注册进来，独立网页那条路（没有钩子）照旧整页重载最稳。
  function 换局(配置) {
    /* ★ 沙盒里**一律**走适配层的页内重开（`HS_SANDBOX.重开一局`），绝不碰 `location`。
       2026-10-05 实机反馈："重打本关你是直接改的 location，也没走沙盒重开入口" ——
       在沙盒里 `location.href` 那一下会把**平台的聊天页**导航掉（iframe 换掉了），
       玩家看到的是"整页变了"，而不是"牌桌重开"。所以：有 SDK 就问适配层，问不到就**留在原地**，
       任何情况下都不在沙盒里改 location。 */
    var 沙盒里 = !!(W.HS_SANDBOX && typeof W.HS_SANDBOX.有SDK === 'function' && W.HS_SANDBOX.有SDK());
    if (沙盒里) {
      var 成 = false;
      try { 成 = W.HS_SANDBOX.重开一局(配置); } catch (e) {
        try { if (W.HS_CHECK) W.HS_CHECK.报(8, 'META_INCOMPLETE', { 环节: '页内重开抛错', 错误: String(e && e.message) }, '严重'); } catch (e2) {}
      }
      return !!成;
    }
    if (typeof W.HS_RESTART_HOOK === 'function') {
      try { if (W.HS_RESTART_HOOK(配置)) return true; } catch (e) {}
    }
    W.location.href = W.location.pathname +
      (配置 && 配置.关卡 ? '?level=' + 配置.关卡 : '?free=' + ((配置 && 配置.自由档) || 3));
  }

  function enterLevel(id) { 换局({ 关卡: id }); }
  function enterFree(n) { 换局({ 自由档: n }); }

  /* ------------------------------ 上游函数包装 ------------------------------ */

  var LEVEL = null, TIER = 1, FREE = null;   // 同样在 boot() 里定（要等 卡库.js 的前置钩子写完 CAMPAIGN）

  // ① 难度档位：**设进我们自己的决策层**（阶段 E，2026-10-03）
  //
  // 以前这里包的是 `W.computerCardPlace`（tier 0 随机出牌 / tier 2 挑最贵）和 `W.AI`
  // （tier 0 一半概率发呆）。但这两个函数**早就没人调了** —— 敌方那一拍由 界面.js 的规划器
  // 自己规划、自己施加（浏览器装探针跑完两个完整回合：`AI()` 与 `computerCardPlace()`
  // 调用次数都是 0）。包在死函数上，等于**三个档位全部失效**：1~5 关的对手其实一直
  // 用同一套决策在打。现在档位直接设进 `游戏/决策.js`，它挑牌、挑目标时读的就是这个档。
  function 接决策层() {
    if (!W.HS_DECIDE || typeof W.HS_DECIDE.设档 !== 'function') return false;
    W.HS_DECIDE.设档(TIER);
    return true;
  }

  // ③ 通关：包装 gameWon，记进度并给出「下一关」
  function patchGameWon() {
    if (W.gameWon && W.gameWon.__hsWon) return true;        // 已经包过（重入时不叠第二层）
    var up = W.gameWon;
    if (typeof up !== 'function') return false;

    var 包 = function () {
      var r = up.apply(this, arguments);
      /* ★ 通关即**同步存档**（2026-10-05 用户要求）。
         原来只在"聊天事件（message:done / stage:close）"那一拍才写云端 —— 于是有一段时间差：
         这一局刚赢、进度还在内存里，旧云档有机会覆盖它。通关是**确定的进度事件**，
         就在这一刻写下去，别等平台来问。 */
      try { if (W.HS_SANDBOX && typeof W.HS_SANDBOX.存档 === 'function') W.HS_SANDBOX.存档(); } catch (e) {}
      if (!LEVEL) return r;                          // 没在打关卡（自由对战）就不记
      markCleared(LEVEL.id);
      showAfterWin();
      return r;
    };
    包.__hsWon = true;
    W.gameWon = 包;
    return true;
  }

  function showAfterWin() {
    if (W.document.getElementById('campaign-afterwin')) return;
    var bar = el('div');
    bar.id = 'campaign-afterwin';

    var nextLv = D.byId(LEVEL.id + 1);
    if (nextLv) {
      var nb = el('button', 'campaign-btn', '下一关：' + nextLv.name);
      nb.onclick = function () { enterLevel(nextLv.id); };
      bar.appendChild(nb);
    } else {
      var done = el('button', 'campaign-btn', '全部通关 ✔');
      done.disabled = true;
      bar.appendChild(done);
    }
    var again = el('button', 'campaign-btn ghost', '重打本关');
    again.onclick = function () { enterLevel(LEVEL.id); };
    bar.appendChild(again);
    var back = el('button', 'campaign-btn ghost', '关卡列表');
    back.onclick = function () {
      换局({});                                      // 回主菜单（沙盒里就是页内回到主页面，不重载）
    };
    bar.appendChild(back);

    // 等上游的胜利特效演完再浮出来
    W.setTimeout(function () { bar.classList.add('on'); }, 3500);
    ((W.HS_UI_宿主 && W.HS_UI_宿主()) || W.document.body).appendChild(bar);
  }

  /* ------------------------------ 入口接线 ------------------------------ */

  /* ------------------------------ 主页面（用户 2026-10-03） ------------------------------
   * 三块：**卡牌图鉴 · 开始游戏 · 更多内容**（更多内容只做一个按键）。
   * 上游那个 #mainmenu（Play · Tutorial · Shop · 开包 · 杂物间……）从此不显示 ——
   * 它上面能点的东西我们一个都不用，留着只会让人误点进上游那套流程。
   *
   * 开始游戏分两条路：
   *   · 挑战关：五关，**格数逐关 +1**（第一关双方各 1 格 …… 第五关 5 格），走 ?level=N
   *   · 自由关：双方各 **1 / 3 / 5 格**三档，走 ?free=N —— 卡库.js 乙段据此定 HS_SLOTS，
   *     界面（SLOT_COUNT）与引擎（状态.场上上限）都读它。
   * 两条路都是整页重载：原地重开要清一堆脚本作用域的旧状态（见本文件头那段说明）。
   */
  var mainEl = null, startEl = null, codexEl = null, creditsEl = null, settingsEl = null, importEl = null, deckEditEl = null;

  /* ==================== 美术方向（2026-10-06）：主界面（图一）· 选关（图二）====================
     参考是《空洞骑士》那两屏的**骨架**，不是它的图：
       主界面：朴素背景 + **左侧一列细字**（开始游戏 / 卡牌图鉴 / 卡组导入 / 设置 / 开源与致谢），
               右上角一块标题（Chapter / 副题那种），左下角一行提示，右下角一行操作图例；
       选关：  顶部标题 + 一行说明，**五张竖卡横排**（关名 / 难度副题 / 占位图 / 说明），
               当前那张底下挂一个 ▾「当前」，底部一行当前关的说明，右下角◀▶换选、回车开始。
     **图全部用占位框**（虚线 + 「占位图」字样）：美术图到位后只替换 `.mn-art` / `.sl-art` 的背景即可。
     所有新类名走 `mn-` / `sl-` 前缀，与旧样式不打架；旧的三块入口（图鉴 / 开始 / 更多）由这一版取代。 */
  var 美术CSS = [
    /* —— 主界面 —— */
    '#hs-mainmenu{position:fixed;inset:0;z-index:9990;display:none;color:#d9d2c4;',
    'background:#1a1614;}',                       /* 朴素底色：背景图待提供时先用纯色 */
    '#hs-mainmenu.on{display:block;}',
    '#hs-mainmenu .mn-bg{position:absolute;inset:0;background:radial-gradient(120% 90% at 50% 40%,#241f1c 0%,#141110 70%,#0d0b0a 100%);}',
    '#hs-mainmenu .mn-art{position:absolute;inset:0;border:0;background-image:none;}',
    /* 占位提示：整屏背景图没来时，角落留一行小字说明这里将来放什么 */
    '#hs-mainmenu .mn-artnote{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);',
    'font-size:12px;letter-spacing:3px;color:#4a423c;border:1px dashed #3a332e;padding:10px 18px;border-radius:4px;}',
    '#hs-mainmenu .mn-title{position:absolute;right:6%;top:12%;text-align:right;}',
    '#hs-mainmenu .mn-app{font:400 44px/1 "Times New Roman",Georgia,"Songti SC",serif;letter-spacing:10px;color:#e8dcc6;}',
    '#hs-mainmenu .mn-sub{margin-top:10px;font:400 20px/1 Georgia,"Songti SC",serif;letter-spacing:6px;color:#b9ac93;}',
    '#hs-mainmenu .mn-list{position:absolute;left:7%;top:34%;display:flex;flex-direction:column;gap:2px;}',
    '#hs-mainmenu .mn-item{appearance:none;background:none;border:0;padding:4px 0;text-align:left;cursor:pointer;',
    'font:400 21px/1.85 Georgia,"Songti SC","Microsoft YaHei",serif;letter-spacing:2px;color:#a89a86;}',
    '#hs-mainmenu .mn-item:hover,#hs-mainmenu .mn-item:focus{color:#f2e7cf;outline:none;}',
    /* 当前项左边那个小箭头（图一聚焦项的写法） */
    '#hs-mainmenu .mn-item:hover::before,#hs-mainmenu .mn-item:focus::before{content:"‣ ";color:#c8b184;}',
    '#hs-mainmenu .mn-foot{position:absolute;left:7%;bottom:6%;font:400 13px/1 Georgia,serif;letter-spacing:2px;color:#6d6357;}',
    '#hs-mainmenu .mn-keys{position:absolute;right:6%;bottom:6%;font:400 13px/1 Georgia,serif;letter-spacing:2px;color:#6d6357;}',
    /* —— 选关（图二）—— */
    '#hs-start{position:fixed;inset:0;z-index:9991;display:none;color:#d9d2c4;background:rgba(12,10,9,.94);}',
    '#hs-start.on{display:block;}',
    '#hs-start .sl-wrap{position:absolute;inset:0;padding:4vh 4vw;box-sizing:border-box;display:flex;flex-direction:column;}',
    '#hs-start .sl-title{font:400 40px/1 Georgia,"Songti SC",serif;letter-spacing:12px;color:#e8dcc6;}',
    '#hs-start .sl-note{margin:10px 0 0;font:400 15px/1.6 Georgia,"Songti SC",serif;letter-spacing:1px;color:#9a8f7e;}',
    '#hs-start .sl-row{display:flex;gap:14px;justify-content:center;align-items:stretch;flex:1;padding:3vh 0 0;}',
    '#hs-start .sl-card{position:relative;width:15%;min-width:150px;min-height:430px;display:flex;flex-direction:column;cursor:pointer;border:1px solid #4a423a;',
    'background:rgba(20,17,15,.6);padding:10px 10px 12px;transition:border-color .15s,background .15s,transform .15s;}',
    '#hs-start .sl-card:hover{border-color:#8d7c5c;background:rgba(32,27,23,.75);}',
    '#hs-start .sl-card.sel{border-color:#cbb489;background:rgba(38,32,26,.85);box-shadow:inset 0 3px 0 #cbb489;}',
    '#hs-start .sl-card.lock{opacity:.42;cursor:not-allowed;}',
    '#hs-start .sl-name{font:400 17px/1.35 Georgia,"Songti SC",serif;letter-spacing:2px;color:#e8dcc6;text-align:center;}',
    '#hs-start .sl-tier{margin-top:4px;font:400 13px/1.4 Georgia,serif;letter-spacing:1px;color:#9a8f7e;text-align:center;}',
    /* 占位图：虚框 + 字样（美术图到位后把这里换成 background-image） */
    '#hs-start .sl-art{margin:10px 0;aspect-ratio:3/4;border:1px dashed #5c5246;border-radius:2px;',
    'display:flex;align-items:center;justify-content:center;color:#5c5246;font:400 12px/1 Georgia,serif;letter-spacing:2px;',
    'background:linear-gradient(160deg,#221d19,#171412);}',
    '#hs-start .sl-desc{margin-top:2px;font:400 12px/1.6 Georgia,"Microsoft YaHei",sans-serif;color:#8d8272;text-align:center;flex:1;}',
    '#hs-start .sl-mark{margin-top:6px;text-align:center;font:400 12px/1 Georgia,serif;letter-spacing:2px;color:#cbb489;visibility:hidden;}',
    '#hs-start .sl-card.sel .sl-mark{visibility:visible;}',
    '#hs-start .sl-clear{margin-top:6px;text-align:center;font:400 12px/1 Georgia,serif;letter-spacing:1px;color:#7f9a72;}',
    '#hs-start .sl-bar{margin-top:2vh;display:flex;align-items:center;gap:14px;border-top:1px solid #3a332c;padding-top:12px;}',
    '#hs-start .sl-line{flex:1;font:400 15px/1.5 Georgia,"Songti SC",serif;letter-spacing:1px;color:#c3b69f;}',
    '#hs-start .sl-nav{appearance:none;background:none;border:1px solid #4a423a;color:#c3b69f;cursor:pointer;',
    'font:400 18px/1 Georgia,serif;padding:6px 14px;}',
    '#hs-start .sl-nav:hover{border-color:#cbb489;color:#f2e7cf;}',
    '#hs-start .sl-go{appearance:none;background:#2b241d;border:1px solid #8d7c5c;color:#f2e7cf;cursor:pointer;',
    'font:400 15px/1 Georgia,"Songti SC",serif;letter-spacing:2px;padding:9px 22px;}',
    '#hs-start .sl-go:hover{background:#3a3126;}',
    '#hs-start .sl-free{margin-top:2vh;}',
    '#hs-start .sl-freeh{font:400 15px/1 Georgia,"Songti SC",serif;letter-spacing:3px;color:#9a8f7e;margin-bottom:8px;}',
    '#hs-start .sl-mini{display:flex;gap:10px;}',
    '#hs-start .sl-mini > *{width:auto;min-width:118px;flex:0 0 auto;padding:8px 14px;text-align:center;font:400 14px/1.5 Georgia,"Songti SC",serif;}',
    '#hs-start .sl-back{position:absolute;right:4vw;top:3.2vh;}',
    /* —— 主界面背景图（用户 2026-10-06 提供）—— 铺满整屏，上面压一层暗纱保证字读得清 —— */
    '#hs-mainmenu .mn-art{background-image:url("素材/主页面背景.png");background-size:cover;background-position:center;}',
    '#hs-mainmenu .mn-veil{position:absolute;inset:0;background:linear-gradient(90deg,rgba(6,5,5,.88) 0%,rgba(6,5,5,.58) 45%,rgba(6,5,5,.34) 100%);}',
    '#hs-mainmenu .mn-list{top:42%;}',
    '#hs-mainmenu .mn-version{position:absolute;right:6%;bottom:6%;font:400 13px/1 Georgia,serif;letter-spacing:2px;color:#6d6357;}',
    /* —— 选关：正右侧切页（挑战模式 ⇄ 自由模式）—— */
    '#hs-start .sl-switch{position:absolute;right:2.4vw;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:10px;}',
    '#hs-start .sl-switch button{appearance:none;background:rgba(20,17,15,.72);border:1px solid #4a423a;color:#c3b69f;cursor:pointer;',
    'font:400 14px/1.6 Georgia,"Songti SC",serif;letter-spacing:3px;padding:10px 9px;writing-mode:vertical-rl;}',
    '#hs-start .sl-switch button:hover{border-color:#cbb489;color:#f2e7cf;}',
    '#hs-start .sl-switch button.on{border-color:#cbb489;color:#f2e7cf;background:rgba(58,49,38,.85);}',
    /* —— 小浮层的按键：与页面同一套笔触（细边 · 衬线 · 字距）—— */
    '.hsx-btn{appearance:none;background:rgba(20,17,15,.72);border:1px solid #4a423a;color:#c3b69f;cursor:pointer;',
    'font:400 15px/1.5 Georgia,"Songti SC",serif;letter-spacing:2px;padding:9px 18px;margin:4px 8px 4px 0;}',
    '.hsx-btn:hover{border-color:#cbb489;color:#f2e7cf;}',
    '.hsx-btn.on{border-color:#cbb489;color:#f2e7cf;background:rgba(58,49,38,.85);}',
    '.hsx-row{display:flex;flex-wrap:wrap;align-items:center;}',
    '.hsx-note{font:400 12px/1.8 Georgia,"Microsoft YaHei",sans-serif;color:#8d8272;}',
    /* —— 小浮层：开源与致谢 / 设置 / 卡组导入 —— */
    '.hsx-panel{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9993;width:min(680px,92vw);',
    'background:rgba(24,20,18,.97);border:1px solid #4a423a;padding:22px 26px;color:#d9d2c4;display:none;}',
    '.hsx-panel.on{display:block;}',
    '.hsx-panel h3{margin:0 0 12px;font:400 22px/1 Georgia,"Songti SC",serif;letter-spacing:4px;color:#e8dcc6;}',
    '.hsx-panel p{margin:8px 0;font:400 14px/1.9 Georgia,"Songti SC","Microsoft YaHei",serif;color:#b8ab95;}',
    '.hsx-panel a{color:#cbb489;}',
    '.hsx-panel .hsx-close{position:absolute;right:14px;top:12px;appearance:none;background:none;border:0;color:#9a8f7e;',
    'font:400 20px/1 Georgia,serif;cursor:pointer;}',
    '.hsx-panel .hsx-close:hover{color:#f2e7cf;}',
  ].join('');

  function injectArt() {
    var d = W.document;
    if (d.getElementById('hs-art-style')) return;
    var s = d.createElement('style');
    s.id = 'hs-art-style';
    s.textContent = 美术CSS;
    (d.head || d.documentElement).appendChild(s);
  }

  /* 一句话提示（原先跟着主页面一起定义，这一版主页面重排了，挪到这儿） */
  function 说一句(文字) {
    var t = W.document.getElementById('hsm-toast');
    if (!t) { t = el('div'); t.id = 'hsm-toast'; ((W.HS_UI_宿主 && W.HS_UI_宿主()) || W.document.body).appendChild(t); }
    t.textContent = 文字;
    t.classList.add('on');
    W.setTimeout(function () { t.classList.remove('on'); }, 1600);
  }

  function 小浮层(id, 标题, 段落) {
    var wrap = el('div', 'hsx-panel');
    wrap.id = id;
    var c = el('button', 'hsx-close', '✕');
    c.onclick = function () { wrap.classList.remove('on'); };
    wrap.appendChild(c);
    wrap.appendChild(el('h3', null, 标题));
    (段落 || []).forEach(function (x) {
      if (typeof x === 'string') { wrap.appendChild(el('p', null, x)); return; }
      var p = el('p');
      if (x.链) { var a = W.document.createElement('a'); a.href = x.链; a.target = '_blank'; a.rel = 'noopener'; a.textContent = x.文字; p.appendChild(a); }
      else p.textContent = x.文字;
      wrap.appendChild(p);
    });
    ((W.HS_UI_宿主 && W.HS_UI_宿主()) || W.document.body).appendChild(wrap);
    return wrap;
  }

  /* 开源与致谢（用户 2026-10-06 给的原文，别改写） */
  function openCredits() {
    if (!creditsEl) {
      creditsEl = 小浮层('hs-credits', '开源与致谢', [
        { 文字: '开源：', 链: 'https://github.com/Xuqiu-MLGBD/card-battle-campaign' },
        '致谢：感谢行樂、洛璃的代码支持，月月鸟、tosaki、糯米等 discord 社群作者们的设计支持。',
      ]);
    }
    creditsEl.classList.add('on');
  }

  /* 设置（主页面这一层）：按键与页面同一套样式 + **导出报错**（用户 2026-10-06 要求）+
     我方布局样式（见下：对局里我方那一半的配色，可切换、也可由文件导入新增） */
  function openSettings() {
    if (!settingsEl) {
      settingsEl = 小浮层('hs-mainsettings', '设置', []);
      var 行1 = el('div', 'hsx-row');
      var 导出 = el('button', 'hsx-btn', '导出报错（本局信息）');
      导出.onclick = function () {
        /* 报错面板由 界面.js 提供（它有这一局的权威状态、场面、最近动作）。
           面板右上角有关闭键、也能点面板外关掉 —— 用户要求"报错页面要可以关闭"。 */
        try {
          if (W.HS_INTERACT && typeof W.HS_INTERACT.导出报告 === 'function') W.HS_INTERACT.导出报告();
          else 说一句('导出报错：要先进一局（界面层还没就绪）');
        } catch (e) { 说一句('导出报错失败：' + (e && e.message)); }
      };
      行1.appendChild(导出);
      var 清 = el('button', 'hsx-btn', '清空关卡进度');
      清.onclick = function () {
        try { if (typeof clearProgress === 'function') clearProgress(); } catch (e) {}
        说一句('进度已清空（刷新后生效）');
      };
      行1.appendChild(清);
      settingsEl.appendChild(行1);

      settingsEl.appendChild(el('p', null, '我方布局样式（只改对局里我方那一半的配色）'));
      var 行2 = el('div', 'hsx-row');
      行2.id = 'hsx-mystyles';
      settingsEl.appendChild(行2);

      settingsEl.appendChild(el('p', 'hsx-note',
        '敌方布局区是预设样式（将来固定成美术给的那一套）；我方可以换，也可以导入别人做的样式文件来新增。'));

      settingsEl.appendChild(el('p', null, '构建版本：' + (W.HS_BUILD || '（开发中）')));
      settingsEl.appendChild(el('p', 'hsx-note', '进度存在浏览器本机（localStorage），清缓存即丢失。'));
    }
    渲染布局样式();
    settingsEl.classList.add('on');
  }

  /* ==================== 我方布局样式（用户 2026-10-06）====================
     对局里**敌方那一半是预设**（将来固定成美术给的那套），**我方那一半可以换**，
     甚至可以导入别人做的样式文件来新增原本没有的样式。做法很轻：
       · 样式就两个量（底色、描边色）→ 写成 `#game` 上的两个 CSS 变量（`--hs-my-bg/--hs-my-line`）；
       · 预设放在下面的表里，自定义样式存在 localStorage（导入的文件只读进它）；
       · 切换只是改这两个变量 —— 不动 DOM 结构、不碰演出。
     为什么不做成"整套 CSS 文件导入"：那等于让外部样式表改我们的布局，
     出问题时既难查也没法保证不越界。两个颜色既能满足"换风格"，又始终在我们掌控里。 */
  var 样式预设 = {
    '默认': null,
    '赤铜': { 底: 'rgba(128,56,30,.55)', 边: '#b9743f' },
    '青玉': { 底: 'rgba(26,86,76,.55)', 边: '#4fb3a0' },
    '墨黑': { 底: 'rgba(28,28,32,.62)', 边: '#6f6f78' },
  };
  var 样式键 = 'hs_my_style_v1';

  function 取样式存档() {
    try {
      var s = W.localStorage.getItem(样式键);
      var o = s ? JSON.parse(s) : null;
      return (o && typeof o === 'object') ? o : { 当前: '默认', 自定义: {} };
    } catch (e) { return { 当前: '默认', 自定义: {} }; }
  }
  function 存样式存档(o) {
    try { W.localStorage.setItem(样式键, JSON.stringify(o)); } catch (e) {}
  }
  function 应用布局样式(名) {
    var 存 = 取样式存档();
    var 定 = 样式预设[名] || (存.自定义 && 存.自定义[名]) || null;
    var g = W.document.getElementById('game');
    if (g) {
      if (定) {
        g.style.setProperty('--hs-my-bg', 定.底 || 定['底'] || '');
        g.style.setProperty('--hs-my-line', 定.边 || 定['边'] || '');
      } else {
        g.style.removeProperty('--hs-my-bg');
        g.style.removeProperty('--hs-my-line');
      }
    }
    存.当前 = 名;
    存样式存档(存);
    return true;
  }
  function 渲染布局样式() {
    var d = W.document, 行 = d.getElementById('hsx-mystyles');
    if (!行) return;
    行.innerHTML = '';
    var 存 = 取样式存档();
    var 名表 = Object.keys(样式预设).concat(Object.keys(存.自定义 || {}));
    名表.forEach(function (名) {
      var b = el('button', 'hsx-btn' + (存.当前 === 名 ? ' on' : ''), 名);
      b.onclick = function () { 应用布局样式(名); 渲染布局样式(); 说一句('我方布局样式：' + 名); };
      行.appendChild(b);
    });
    var 导 = el('button', 'hsx-btn', '导入样式文件…');
    导.onclick = function () {
      var inp = d.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        if (!f) return;
        var r = new W.FileReader();
        r.onload = function () {
          try {
            var o = JSON.parse(String(r.result));
            if (!o || !o.名称) throw new Error('缺少字段"名称"');
            var 存2 = 取样式存档();
            存2.自定义 = 存2.自定义 || {};
            存2.自定义[o.名称] = { 底: o.底 || '', 边: o.边 || '' };
            存样式存档(存2);
            应用布局样式(o.名称);
            渲染布局样式();
            说一句('已导入样式：' + o.名称);
          } catch (e) { 说一句('样式文件读不了：' + (e && e.message)); }
        };
        r.readAsText(f);
      };
      inp.click();
    };
    行.appendChild(导);
  }
  /* 卡组编辑：**占位**（用户 2026-10-06 要求加在主菜单"卡牌图鉴"下方；具体规则待定） */
  function openDeckEdit() {
    if (!deckEditEl) {
      deckEditEl = 小浮层('hs-deckedit', '卡组编辑', [
        '这里将来放"组自己的卡组"：从已解锁的卡里挑若干张、存成套，开局时选用。',
        '它和「卡组导入」是一对：这里编，那里把别人编好的套组导进来。',
        '当前版本还没有这套规则，先用占位提示 —— 免得点了没反应（那类 bug 我们踩过太多次）。',
      ]);
    }
    deckEditEl.classList.add('on');
  }

  function openDeckImport() {
    if (!importEl) {
      importEl = 小浮层('hs-deckimport', '卡组导入', [
        '这里将来放"导入自己的卡组"：粘贴卡组码或选一份文件，校验后进入对局。',
        '当前版本还没有这套规则，先用占位提示 —— 免得点了没反应（那类"点了没反应"我们踩过太多次）。',
      ]);
    }
    importEl.classList.add('on');
  }

  /* 主页面：图一的排布 —— 朴素背景 + 左下起一列细字 + 右上标题块 */
  function buildMain() {
    var wrap = el('div');
    wrap.id = 'hs-mainmenu';
    wrap.appendChild(el('div', 'mn-bg'));
    wrap.appendChild(el('div', 'mn-art'));            // 背景图（用户提供）
    wrap.appendChild(el('div', 'mn-veil'));           // 暗纱：保证左侧文字读得清

    var t = el('div', 'mn-title');
    t.appendChild(el('div', 'mn-app', '联合派对'));    // 右上大字（用户 2026-10-06 指定）
    t.appendChild(el('div', 'mn-sub', '童年毁坏'));    // 右上小字
    wrap.appendChild(t);

    var list = el('div', 'mn-list');
    [
      ['开始游戏', openStart],
      ['联机对战', function () { 说一句('联机对战：敬请期待'); }],
      ['卡牌图鉴', openCodex],
      ['卡组编辑', openDeckEdit],
      ['卡组导入', openDeckImport],
      ['设置', openSettings],
      ['开源与致谢', openCredits],
    ].forEach(function (项) {
      var b = el('button', 'mn-item', 项[0]);
      b.onclick = 项[1];
      list.appendChild(b);
    });
    wrap.appendChild(list);

    /* 左下角那行提示按用户要求去掉；右下角改成**版本号** */
    var 版 = el('div', 'mn-version', '版本 ' + (W.HS_BUILD || '开发中'));
    wrap.appendChild(版);
    wrap.classList.add('on');

    ((W.HS_UI_宿主 && W.HS_UI_宿主()) || W.document.body).appendChild(wrap);
    mainEl = wrap;
    return wrap;
  }

  /* 选关：两套模式共用**同一种卡**（用户 2026-10-06：自由选关也做成挑战关的样式）。
     正右侧是切页（挑战模式 ⇄ 自由模式），左上角标题与说明随模式换。 */
  var 选中关 = 1;                 // 挑战模式里"当前"那张
  var 选中自由 = 3;               // 自由模式里"当前"那张
  var 选关模式 = 'challenge';     // 'challenge' | 'free'

  /* 造一张卡：两种模式共用（自由关只是换了数据来源） */
  function 造选关卡(项) {
    var 卡 = el('div', 'sl-card');
    卡.dataset.关 = String(项.键);
    if (项.锁) 卡.classList.add('lock');
    卡.appendChild(el('div', 'sl-name', 项.名));
    卡.appendChild(el('div', 'sl-tier', 项.副题));
    卡.appendChild(el('div', 'sl-art', '占位图'));      // 美术图到位后替换这里的背景
    卡.appendChild(el('div', 'sl-desc', 项.说明 || ''));
    /* ⚠ 「▾ 当前」与「已通关」两行**无论有没有都占位**（靠 visibility 控制显隐）：
       否则"多一行"的那张卡会被撑高、把整排顶得参差不齐（用户 2026-10-06：
       "挑战关的第一关比其他关卡位置都高了一截" —— 就因为只有它带「已通关」）。 */
    卡.appendChild(el('div', 'sl-mark', '▾ 当前'));
    var 通 = el('div', 'sl-clear', '已通关');
    if (!项.已通关) 通.style.visibility = 'hidden';
    卡.appendChild(通);
    卡.onclick = function () { 项.选中(); };
    卡.ondblclick = function () { 项.开始(); };
    return 卡;
  }

  function 挑战项(lv) {
    return {
      键: 'lv' + lv.id, 名: lv.name,
      副题: ((TIER_NAME && TIER_NAME[lv.tier]) || ('难度 ' + lv.tier)) + ' · ' + lv.slots + ' 格',
      说明: lv.blurb || '',
      锁: !((typeof isUnlocked === 'function') ? isUnlocked(lv.id) : true),
      已通关: (typeof isCleared === 'function') ? isCleared(lv.id) : false,
      选中: function () {
        if (this.锁) { 说一句('这一关还没解锁：先通过第 ' + (lv.id - 1) + ' 关'); return; }
        选中关 = lv.id; renderStart();
      },
      开始: function () { if (!this.锁) enterLevel(lv.id); },
    };
  }

  function 自由项(n) {
    return {
      键: 'free' + n, 名: '自由关 · ' + n + ' 格', 副题: '双方各 ' + n + ' 格 · 不计进度',
      说明: '随手练一局：牌组是完整的，双方格数一样，赢了不记进度。',
      锁: false, 已通关: false,
      选中: function () { 选中自由 = n; renderStart(); },
      开始: function () { enterFree(n); },
    };
  }

  function renderStart() {
    var d = W.document, 行 = d.getElementById('hsp-levels');
    if (!行) return;
    var 挑战 = (选关模式 === 'challenge');
    行.innerHTML = '';
    if (挑战) {
      (W.CAMPAIGN_LEVELS || []).forEach(function (lv) { 行.appendChild(造选关卡(挑战项(lv))); });
    } else {
      [1, 3, 5].forEach(function (n) { 行.appendChild(造选关卡(自由项(n))); });
    }
    var 当前键 = 挑战 ? ('lv' + 选中关) : ('free' + 选中自由);
    Array.prototype.forEach.call(行.children, function (卡) {
      卡.classList.toggle('sel', 卡.dataset.关 === 当前键);
    });
    /* 左上角标题与说明随模式换（用户给的原文照抄） */
    var 题 = d.getElementById('sl-title');
    if (题) 题.textContent = 挑战 ? '挑战模式' : '自由模式';
    var 说 = d.getElementById('sl-note');
    if (说) 说.textContent = 挑战
      ? '每完成一关，解锁部分卡牌，全部挑战成功解锁全套卡牌。'
      : '双方格数自选，不计进度 —— 随手练一局。';
    /* 底部那一行：当前那张的完整说明 */
    var 线 = d.getElementById('sl-line');
    if (线) {
      if (挑战) {
        var 当 = (W.CAMPAIGN_LEVELS || []).filter(function (lv) { return lv.id === 选中关; })[0];
        线.textContent = 当 ? (当.name + '：' + (当.blurb || '')) : '';
      } else {
        线.textContent = '自由关 · 双方各 ' + 选中自由 + ' 格：不计进度，随时可玩。';
      }
    }
    var 开 = d.getElementById('sl-go');
    if (开) 开.textContent = 挑战 ? '开始这一关' : '开始自由对局';
    /* 右侧切页按钮的选中态 */
    Array.prototype.forEach.call(d.querySelectorAll('#sl-switch button'), function (b) {
      b.classList.toggle('on', b.dataset.模式 === 选关模式);
    });
  }

  function openStart() {
    if (!startEl) {
      startEl = el('div');
      startEl.id = 'hs-start';
      var w = el('div', 'sl-wrap');
      var 题 = el('div', 'sl-title', '挑战模式');
      题.id = 'sl-title';
      w.appendChild(题);
      var 说 = el('div', 'sl-note', '');
      说.id = 'sl-note';
      w.appendChild(说);

      var 行 = el('div', 'sl-row');
      行.id = 'hsp-levels';
      w.appendChild(行);

      var 条 = el('div', 'sl-bar');
      条.id = 'sl-bar';
      var 前 = el('button', 'sl-nav', '◀');
      前.onclick = function () {
        if (选关模式 === 'challenge') 选中关 = Math.max(1, 选中关 - 1);
        else { var 序 = [1, 3, 5], i = 序.indexOf(选中自由); 选中自由 = 序[Math.max(0, i - 1)]; }
        renderStart();
      };
      var 线 = el('div', 'sl-line');
      线.id = 'sl-line';
      var 后 = el('button', 'sl-nav', '▶');
      后.onclick = function () {
        if (选关模式 === 'challenge') 选中关 = Math.min((W.CAMPAIGN_LEVELS || []).length, 选中关 + 1);
        else { var 序 = [1, 3, 5], i = 序.indexOf(选中自由); 选中自由 = 序[Math.min(序.length - 1, i + 1)]; }
        renderStart();
      };
      var 开 = el('button', 'sl-go', '开始这一关');
      开.id = 'sl-go';
      开.onclick = function () { if (选关模式 === 'challenge') enterLevel(选中关); else enterFree(选中自由); };
      条.appendChild(前); 条.appendChild(后); 条.appendChild(线); 条.appendChild(开);
      w.appendChild(条);

      /* 正右侧：切页（挑战模式 ⇄ 自由模式） */
      var 切 = el('div', 'sl-switch');
      切.id = 'sl-switch';
      [['challenge', '挑战模式'], ['free', '自由模式']].forEach(function (t) {
        var b = el('button', null, t[1]);
        b.dataset.模式 = t[0];
        b.onclick = function () { 选关模式 = t[0]; renderStart(); };
        切.appendChild(b);
      });
      w.appendChild(切);

      var 退 = el('button', 'sl-nav sl-back', '返回主页面');
      退.onclick = function () { startEl.classList.remove('on'); };
      w.appendChild(退);

      startEl.appendChild(w);
      ((W.HS_UI_宿主 && W.HS_UI_宿主()) || W.document.body).appendChild(startEl);
    }
    renderStart();
    startEl.classList.add('on');
  }

  /* ⚠ 这里原来还有一条 `function enterFree(n) { W.location.href = … }` —— 与上面那条重名。
     JS 的同名函数声明**后者胜**，于是"自由关 3 格"那个按钮一直走的是整页重载那条老路，
     把页内换关整条路都绕过去了（症状：沙盒里点一下就白屏 —— 平台页被导航掉了）。
     2026-10-03 删掉：换关卡**只留 换局() 一个入口**（独立网页重载 / 沙盒页内重开都在它里面分流）。 */


  /* 卡牌图鉴：**读引擎同一张表**（卡库.js 丙段的 HS_CARDS）——
     图鉴里写的数值与规则里用的数值同源，不会各说各话。 */
  function openCodex() {
    if (!codexEl) {
      codexEl = el('div');
      codexEl.id = 'hs-codex';
      var p = el('div', 'hsp-panel');
      p.appendChild(el('h2', null, '卡牌图鉴'));

      var 表 = W.HS_CARDS || {};
      var 名 = Object.keys(表);
      var sub = el('div', 'hsp-h', '共 ' + 名.length + ' 张');
      sub.appendChild(el('small', null, '数值与规则同源（引擎读的同一张表）'));
      p.appendChild(sub);

      var grid = el('div', 'hsc-grid');
      名.forEach(function (n) {
        var d = 表[n] || {};
        var it = el('div', 'hsc-item');
        var num = el('div', 'hsc-num');
        num.appendChild(el('span', 'hsc-mana', d.费));
        num.appendChild(el('span', 'hsc-atk', d.攻));
        num.appendChild(el('span', 'hsc-hp', d.血));
        it.appendChild(num);
        it.appendChild(el('div', 'hsc-name', n));
        var kw = 词条文字(d.关键词);
        if (kw) it.appendChild(el('div', 'hsc-kw', kw));
        if (d.说明) it.appendChild(el('div', 'hsc-info', d.说明));
        grid.appendChild(it);
      });
      p.appendChild(grid);

      var foot = el('div', 'hsp-foot');
      var back = el('button', 'campaign-btn ghost', '返回主页面');
      back.onclick = function () { codexEl.classList.remove('on'); };
      foot.appendChild(back);
      p.appendChild(foot);

      codexEl.appendChild(p);
      codexEl.onclick = function (e) { if (e.target === codexEl) codexEl.classList.remove('on'); };
      ((W.HS_UI_宿主 && W.HS_UI_宿主()) || W.document.body).appendChild(codexEl);
    }
    codexEl.classList.add('on');
  }

  function 词条文字(k) {
    if (!k) return '';
    var out = [];
    for (var x in k) if (k.hasOwnProperty(x) && k[x]) out.push(x);
    return out.join(' · ');
  }

  function addMenuButton() {
    var d = W.document;
    if (!d.body) return false;
    /* ⚠ 2026-10-05（用户：这些无用的显示删去）：上游那个 `#mainmenu`
       （Play · Tutorial · How To Play · Shop · 开包 · 金币……）**已从 index.html 整块删除**。
       原来这里写着"找不到 `#mainmenu` 就当失败" —— 宿主一没，主页面就不建了，
       于是**不带关卡参数打开时是一屏空白**（`#contents` 是 hidden、菜单又没有）。
       主页面本来就是我们自己的（`buildMain` → `#hs-mainmenu`），
       上游那份只是"顺手收掉"，不该是建它的前提。 */
    var menu = d.getElementById('mainmenu');
    if (menu) menu.style.display = 'none';
    buildMain();
    return true;
  }

  /* 直接进对局 —— 不走上游那段「双方头像 → 点此开始对战 → 点确认」的开场。
   *
   * 上游 playbtn.onclick 里是一串嵌套 setTimeout，前后约 10 秒才把 #confirm 显示出来；
   * 这里把 CSS 又把入场动效停了，于是那 10 秒是一屏静止画面。点 #confirm 之后才轮到
   * confirmbtn.onclick 去撤 #block、亮血条。
   *
   * 所以这里把**最终状态一次性摆好**，整个环节都不要了：
   *   - 主菜单收起、#contents 亮出
   *   - 「对阵」那排文字与头像位不显示
   *   - #block / #confirm 直接收掉
   *   - 两侧血条亮出（它们才是对局里真正要读的东西）
   *
   * 需要说明的是：血量、手牌、法力这些**都由上游在页面加载时就算好了**（startGame() 发牌、
   * 造第一颗法力水晶），所以这里只是把遮罩摆正，不碰任何规则状态。
   */
  function enterFight() {
    var d = W.document;
    if (!d) return;

    function set(sel, props) {
      var e = d.querySelector(sel);
      if (!e) return;
      for (var k in props) if (props.hasOwnProperty(k)) e.style[k] = props[k];
    }
    function hide(sel) { set(sel, { visibility: 'hidden', opacity: '0' }); }

    var menu = d.getElementById('mainmenu');
    if (menu) menu.style.display = 'none';
    /* 自己的主页面跟着收掉（不然它会盖在战场上 —— 它是 fixed + z-index 9990） */
    var mine = d.getElementById('hs-mainmenu');
    if (mine) mine.style.display = 'none';

    set('#contents', { visibility: 'visible', opacity: '1' });
    set('#block', { visibility: 'hidden', opacity: '0', pointerEvents: 'none' });
    set('#confirm', { display: 'none', visibility: 'hidden', opacity: '0' });
    set('#transitionblock', { visibility: 'hidden' });
    set('#skipcinematicbtn', { display: 'none' });

    // 开场里那排「职业 / VS」不要；但**双方名字留着** ——
    // 它们现在是右栏两个头像框里的标题（ours.css 把它们定位进框内了）。
    hide('#playerclasslabel'); hide('#vs');

    set('.playerhero', { zIndex: '5' });
    set('.opponenthero', { zIndex: '5' });
    set('.playerHeroHealth', { visibility: 'visible', opacity: '1' });
    set('.opposingHeroHealth', { visibility: 'visible', opacity: '1' });

    try { W.isInGame = true; } catch (e) { /* 现在是我们自己的全局量（见 游戏/回合.js） */ }
    /* ★ 手上没牌就补发一次（批次 D 之后发牌归 游戏/回合.js；它已在载入期发过，
       这里是"进对局"这条路的兜底 —— 页内换关、或发牌被谁清掉了都能救回来）。 */
    try {
      var 手 = d.getElementById('cards');
      if (手 && 手.querySelectorAll(':scope > .card').length === 0 &&
          W.HS_TURN && typeof W.HS_TURN.开局发牌 === 'function') W.HS_TURN.开局发牌();
    } catch (e) { /* 补发失败不该挡住进对局 */ }

    /* ★ 补一次 attack()：上游只在 playerTurn() 里调它，而 playerTurn() 要等"结束回合 → 敌方
       走完"才会被调用 —— 我们是直接进对局的，不补这一下，**第一回合场上单位既没有绿光、
       也绑不上攻击用的 mousedown**（表现：新上场的单位拖不出箭头、点不动）。 */
    try { if (typeof W.attack === 'function') W.attack(); } catch (e) { /* 不影响进对局 */ }
  }

  /* ------------------------------ 回主页面 ------------------------------
     用户 2026-10-05："在关卡中应该设置退出到主菜单的选项"。
     它必须是**页内**完成的（沙盒里改 location 会把平台聊天页导航掉），并且要能应付
     "这一局是直接进关卡的、主页面根本没建过"这种情况（缺了就现场建）。 */
  function 回主菜单() {
    try {
      if (typeof W.HS_APPLY_LEVEL === 'function') W.HS_APPLY_LEVEL(0, 0);   // 关卡复位（格数/牌组都回默认）
    } catch (e) {}
    try { if (typeof W.CAMPAIGN_REBOOT === 'function') W.CAMPAIGN_REBOOT(); } catch (e) {}
    var d = W.document;
    var 主 = d && d.getElementById('hs-mainmenu');
    if (!主) { try { buildMain(); 主 = d.getElementById('hs-mainmenu'); } catch (e) {} }
    if (主) 主.style.display = '';
    var 内容 = d && d.getElementById('contents');
    if (内容) 内容.style.visibility = 'hidden';
    /* 关卡状态也复位 —— 这样从主页面再点「开始游戏」是一局干净的 */
    LEVEL = null; FREE = null;
    return !!主;
  }

  // 在关卡里时：跳过「首次强制教程」，选完关直接进对局
  /* ⚠⚠ 2026-10-05（批次 D）**这一条曾经整段失效**，而且症状很隐蔽：
     它原来是"**包住 `#preventCORS` 的 onclick**，再借玩家点一下那个门槛来接管入口"——
     而那个 onclick 是 `src/scripts/elementsController.js` 挂的，那个文件**已被删除**。
     于是 `btn.onclick` 是 null → 本函数第一句就 `return false` → **`enterFight` 永远不会被安排**
     → `#contents` 一直是 `visibility:hidden`。
     用户拍到的画面正是它：整块对局区没亮出来，屏幕上只剩"被搬进 #game"的双方名字与血量数字
     （它们不在 #contents 里，所以藏不住）。
     教训与之前几次一样：**"依赖别人挂上来的东西"在删掉那个人之后会静默失效**，
     所以入口必须归我们自己 —— 不再看任何 onclick。 */
  function hookEntry() {
    if (!(LEVEL || FREE)) return false;                 // 不在关卡/自由关：走主页面那条路
    /* 上游：hasPlayedTutorial 为空 → 强制教程；否则 → 显示主菜单。
       我们打关卡时把哨兵置成非空，等于告诉上游"教程过了"，然后直接接管进对局。 */
    if (!W.hasPlayedTutorial_deserailized) W.hasPlayedTutorial_deserailized = 'campaign';
    W.setTimeout(enterFight, 300);
    return true;
  }

  /* ★★ 进沙盒之后补的一条：**boot 要能等到"我们的模块都到位"再跑**。
     为什么需要：沙盒是"装卡时整卡抽取、在页面加载完之后才执行脚本" —— 于是本文件执行时
     `document.readyState` 已经是 `complete`，下面的 else 分支会**立刻**调 boot()，
     而此刻排在**本文件后面**的 `卡库.js` 还没加载 ✗ → boot 第一句 `D = W.CAMPAIGN_DATA`
     拿到 undefined 就 return 了（症状：主页面不建、上游那个 Play/Tutorial 菜单也不隐藏 ——
     真机上看到的就是"怎么是旧页面"。本地仿真因为把卡的内容在 DOMContentLoaded 之前就装好，
     时序不一样，所以看不出这个问题 ✗）。
     修法两层：① 这里 boot 自己会重试（等 `W.CAMPAIGN_DATA` 出现，最多约 4 秒）；
              ② 沙盒适配层挂载后也会显式调一次 `W.CAMPAIGN_BOOT()`。boot 有一次性闸，重复调无副作用。 */
  var 已引导 = false, 等待次数 = 0;
  function boot() {
    if (已引导) return;
    // 这两个全局量到这一刻才一定在（卡库.js 已加载完，DOMContentLoaded 在它之后）
    D = W.CAMPAIGN_DATA;
    if (!D) {                                  // 还没到 —— 重试（沙盒里脚本在页面加载完才跑）
      if (等待次数 < 80) { 等待次数++; W.setTimeout(boot, 50); }
      else if (W.console && W.console.error) W.console.error('[外壳] 等不到 CAMPAIGN_DATA，放弃引导');
      return;
    }
    已引导 = true;
    LEVEL = (W.CAMPAIGN && W.CAMPAIGN.level) || null;
    TIER = LEVEL ? LEVEL.tier : 1;
    /* 自由关（?free=1|3|5）：档位由 卡库.js 乙段记在 HS_FREE 上。它不是关卡（不记进度），
       但和关卡一样"点了就开打"，所以后面 hookEntry 与标题都按同一个"在局里"处理。 */
    FREE = (W.HS_FREE && W.HS_FREE.slots) ? W.HS_FREE : null;
    var 在局里 = !!(LEVEL || FREE);

    injectStyle();
    injectArt();      // 美术方向那一套（主界面/选关/小浮层）单独一张样式表，见 美术CSS
    listEl = buildOverlay();
    /* ★★ 骨架自愈（2026-10-04）：真机上出现过"骨架在、id 不在"（报告：`关键id缺 playerhero`），
       而上游 index.js / attack.js 全是按 id 找元素 —— id 一丢，结束回合/设置/血量一起失灵。
       这里在引导时按**结构**把缺的 id 补回去（`Element.prototype.querySelector` 平台没改写）。
       放在这里是因为：① 此刻骨架一定已注入（沙盒里是上一个模块干的）；
       ② 它必须在任何"按 id 取元素"的动作之前跑。 */
    try { if (typeof W.HS_UI_补齐 === 'function') W.HS_UI_补齐(); } catch (e) {}

    /* ★ 在局里就**不建主页面**：它是 fixed 全屏，先建再等 enterFight 收掉会闪一下。
       自测（test_campaign.mjs）只看"包装成功"这个布尔值，所以这里给 true 不影响契约。 */
    var okMenu = 在局里 ? true : addMenuButton();
    var okEntry = hookEntry();
    var okTier = false;
    try {
      okTier = [patchGameWon(), 接决策层()].every(Boolean);
    } catch (e) {
      if (W.console && W.console.warn) W.console.warn('[campaign] 包装上游函数失败：', e);
    }

    // 暴露给自测（test_campaign.mjs）与调试台用：进度规则是纯函数，单独可测
    W.CAMPAIGN_UI = {
      menu: okMenu, entry: okEntry, tier: okTier,
      free: FREE,                       // 自由关档位（?free=N），没打自由关就是 null
      slots: W.HS_SLOTS,                // 本局每侧几个部署位（关卡表的 slots / 自由关档位）
      menuEl: function () { return W.document.getElementById('hs-mainmenu'); },
      progress: function () { return PROG; },
      isCleared: isCleared,
      isUnlocked: isUnlocked,
      markCleared: markCleared,
      tierName: function () { return TIER_NAME[TIER]; },
      enterFight: enterFight,       // 自测用：直接进对局那段是纯 DOM 状态摆放，可单独验
      /* 回到主页面（用户 2026-10-05："在关卡中应该设置退出到主菜单的选项"）。
         ⚠ 一开始这里写的是 `换局({})` —— 那**不对**：`换局` 在没有 `HS_RESTART_HOOK` 时会
         `location.href = '?free=3'`，也就是**整页重载**成自由关，不是回主页面；
         而且"直接进关卡"这条路（`?level=N`）**从来没建过主页面** —— 于是回来是一片空白。
         所以这一步自己写清楚：复位关卡状态 → 亮出主页面（缺了就现场建）→ 收掉对局区；
         **沙盒里一样是页内完成，绝不改 location**（沙盒改 location 会把平台聊天页导航掉）。 */
      回主菜单: 回主菜单
    };

    /* 主菜单被上游隐藏/显示时，我的按钮跟着走（按钮就在 #mainmenu 里，天然跟随，不需要额外处理） */
    if (在局里) {
      // 应用名由 strip.js 统一给（那里有一处 HS_APP_NAME，改名只动那一处）
      W.document.title = (W.HS_APP_NAME || '卡牌对战') +
        (LEVEL ? ' · 关卡挑战 · ' + LEVEL.name : ' · 自由对练 · ' + FREE.slots + ' 格');
    }
  }

  /* ★ 重入引导（2026-10-03，进沙盒用）：页内换关之后，`W.CAMPAIGN` / `W.HS_SLOTS` 已经换了，
     但本模块内部那两份副本（LEVEL / TIER）还是旧的 —— 把与"这一局是哪一关"有关的几件事重做一遍。
     不重跑整个 boot()：浮层/样式/事件入口都是**页面级**的，换一局不该重建（重建反而会叠监听）。 */
  function reboot() {
    LEVEL = (W.CAMPAIGN && W.CAMPAIGN.level) || null;
    FREE = (W.HS_FREE && W.HS_FREE.slots) ? W.HS_FREE : null;
    TIER = LEVEL ? LEVEL.tier : 1;
    var 在局里 = !!(LEVEL || FREE);
    try { 接决策层(); } catch (e) { /* 决策层没装上也不该拦住换局 */ }
    if (W.CAMPAIGN_UI) { W.CAMPAIGN_UI.free = FREE; W.CAMPAIGN_UI.slots = W.HS_SLOTS; }
    var mm = W.document.getElementById('hs-mainmenu');
    if (mm) mm.style.display = 在局里 ? 'none' : '';
    if (在局里) {
      W.document.title = (W.HS_APP_NAME || '卡牌对战') +
        (LEVEL ? ' · 关卡挑战 · ' + LEVEL.name : ' · 自由对练 · ' + FREE.slots + ' 格');
    }
    return { 关卡: LEVEL ? LEVEL.id : null, 自由档: FREE ? FREE.slots : 0, slots: W.HS_SLOTS };
  }
  W.CAMPAIGN_REBOOT = reboot;
  W.CAMPAIGN_BOOT = boot;        // 沙盒适配层挂载后会显式叫一次（幂等：上面有一次性闸）

  if (W.document.readyState === 'loading') {
    W.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
