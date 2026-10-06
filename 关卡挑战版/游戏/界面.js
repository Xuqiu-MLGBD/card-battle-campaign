/* 关卡挑战版 · 交互层与舞台（必须在 attack.js / index.js / AI.js **之后**加载）
 * ===============================================================
 * 这一层管七件事：
 *  ① **舞台缩放**：`#game` 钉成 1280×720 的设计画布，整体 `scale(min(w/1280, h/720))`。
 *     里面所有坐标都是设计坐标，元素的大小与位置关系被整体锁死。
 *  ② **部署位格子表**：每侧 5 格，拖到第几格就落在第几格（行内 left，不再用 nth-child）。
 *  ③ **拖手牌时的箭头**：手牌一离开手牌区就画箭头（手牌原位置 → 指针），坐标走设计坐标。
 *  ④ **卡面预览侧栏**：左右两侧各一个固定位置，按箭头在哪一侧挑对面那个。
 *  ⑤ **手牌拖动由我们全包**：拦掉上游那套「把卡片挪到指针下」的拖拽 ——
 *     它用视口坐标，舞台一缩放就会错位；而且卡片太大挡死场地。现在卡片留在手牌里不动，
 *     落格判定与结算由我们自己触发（仍然调用上游的 placeCardFunc，结算路径没变）。
 *  ⑥ **拖拽释放即结算**：拖场上单位 → 悬停目标高亮 → 松手直接打（补一次上游期望的 mousedown）。
 *  ⑦ **取消**：点空白 / 再点一次同一个 / Esc / 右键；无副作用。
 *
 * 另外补一条规则上的兜底：**牌堆抽空时把牌洗回去**（用户 2026-10-02：这套规则没有疲劳，
 * 牌打完就把墓地重新洗入牌组）。上游牌空时直接 `cards[0]` 会炸，见 refillIfEmpty()。
 */
(function (W) {
  'use strict';

  if (W.__hsInteract) return;         // 幂等：创卡页预览会重跑脚本
  W.__hsInteract = true;

  var d = W.document;
  /* 画布宽 1208（= 右栏左缘 1000 + 右栏 200 + 8 右边距），用户 2026-10-03 收窄右栏时同步缩的。
     高度不是常数：由 fitStage 按窗口宽高比算。DESIGN_H 只作默认值。 */
  var DESIGN_W = 1208, DESIGN_H = 720;

  /* ============================ ① 舞台缩放 ============================ */

  function stage() { return d.getElementById('game'); }

  /* 设计高度几乎不设限了 —— 因为**布局会自己压缩**（见 fitStage 里按高度算格子尺寸）。
     这个夹紧只剩"防呆"作用：挡住极端到没有意义的窗口比例。
     区间 [520, 1600] 对应窗口比例 [0.8, 2.46]，几乎覆盖所有真实窗口，
     所以**两侧黑边在实际使用中不会再出现**。 */
  var H_MIN = 520, H_MAX = 1600;

  /* 舞台这一刻的设计高度（布局用它做上下定位）。
     ⚠ 读的是 **CSS 变量**而不是 `style.height` —— ours.css 里那行
     `height: var(--hs-stage-h, 720px) !important` 会压过内联的 style.height，
     所以只有一个地方能改高度：把变量写进去。 */
  function stageH() {
    var g = stage();
    if (!g) return DESIGN_H;
    var v = parseFloat(g.style.getPropertyValue('--hs-stage-h'));
    return v > 0 ? v : DESIGN_H;
  }

  /* 等比缩放。
     老做法是 `min(w/1280, h/720)`（保持 16:9，比例不符就在两边留黑边）——
     用户 2026-10-03 反馈「两边的留边太多，头像和法力值放不下」。
     所以改成：**宽度定缩放，高度自适应**。先把窗口按宽度折成设计坐标，
     得到这一刻「舞台该有多高」，再回填给 `#game`。这样窗口多出来的高度变成
     上下两排之间**可以伸缩的对峙区**，而不是两条黑边。
     高度仍夹在 [H_MIN, H_MAX]：太扁两排会挤在一起，太高中间会空成一片。
     超出这个范围（比如超宽屏）才会回到留边，这是刻意的兜底。 */
  /* 当前窗口下「应该」用的设计高度 —— fitStage 与 ensureFit 共用这一份算式 */
  /* 要不要**把整个舞台转 90° 当横屏用**（用户 2026-10-06：
     「如果监测到显示屏幕的宽度是手机设备，那直接将整个舞台旋转 90 度进入横屏模式」）。
     判据两条同时成立才算：① 竖着（高 > 宽）；② 宽度是手机那一档（≤ 900）——
     这样平板上"竖着拿"不会突然转过去，而手机上竖着拿就自动变成一屏横屏擂台。 */
  function 要转屏() {
    try { return (W.innerHeight > W.innerWidth) && (W.innerWidth <= 900); } catch (e) { return false; }
  }
  /* 转屏之后"可用的宽/高"要互换：设计画布的宽（1208）去对屏幕的**高**。 */
  /* ---- 桌面缩放上限（用户 2026-10-06："窗口又有更大的宽、又有更大的高时，等比放大也可以"）----
     语义：`k = min(可用宽/设计宽, 可用高/设计高, 上限)` ——
       · 上限 = 0 → 不设上限（**适应窗口**，默认）：窗口够大就把整桌等比放大到刚好填满一边；
       · 上限 = 1 → 等同"钉死 1×"（窗口更大就留边，控件 1:1）；
       · 上限 = 1.5 / 2 → 最多放大到那个倍数。
     上限**永远不会超过窗口**（min 里带着两个 fit 项），所以放大也只会等比、不会溢出、不会变形。 */
  var 缩放键 = 'hs_stage_cap_v1';
  function 读缩放上限() {
    try { var v = parseFloat(W.localStorage.getItem(缩放键)); return isFinite(v) ? v : 0; } catch (e) { return 0; }
  }
  function 设缩放上限(v) {
    try { W.localStorage.setItem(缩放键, String(v)); } catch (e) {}
    fitStage();
    return 读缩放上限();
  }
  function 缩放上限() { return 读缩放上限(); }

  function 可用宽() { return 要转屏() ? W.innerHeight : W.innerWidth; }
  function 可用高() { return 要转屏() ? W.innerWidth : W.innerHeight; }

  function targetH() {
    /* ★ 画布高**固定为设计稿的 720**（用户 2026-10-06："把整个桌面的比例和位置固定死"）。
       原来这里按窗口宽高比算：h = 可用高 / (可用宽/1208) —— 于是**舞台高度随窗口漂**，
       而所有布局都是按设计稿百分比写的（分块、布局位、将来的摆件），高度一漂就全对不上
       （实测 2048 宽的窗口里，40% 那条分界线跑到了 55% 的位置、盖住我方布局位）。
       钉死之后：舞台永远是 1208×720 的设计画布，窗口只负责"缩放与留边"。 */
    return DESIGN_H;
  }

  /* 格子尺寸：**宽定死、高按 251:207 的宽高比推**（用户 2026-10-02：
     *「布局区上的角色槽大概要改成是 251：207 的宽高比」*）。
     上一版高度是拿舞台高度算的（`min(每排可用高, 宽/0.75)`），窗口一矮格子就被压成
     将近正方形（实测 150×153），形状随窗口漂。现在高度由宽度推，格子形状与窗口无关，
     舞台高度只决定两排之间那块对峙区有多高。
     横向仍由 ours.css 定（一排占满 --hs-row-w = 888，格子居中，见 .hs-row 的 justify-content）。
     竖直核对：h 取下限 520 时 24 + 124(敌) + 124(我) + 200(手牌/任务区) = 472 < 520 ✓。 */
  var SLOT_ASPECT = { w: 251, h: 207 };      // 用户给的角色槽宽高比
  function sizeSlots() {
    SLOT_H = Math.round(SLOT_W * SLOT_ASPECT.h / SLOT_ASPECT.w);   // 150 → 124
    STEP = SLOT_W + SLOT_GAP;
    return SLOT_COUNT * SLOT_W + (SLOT_COUNT - 1) * SLOT_GAP;
  }

  function fitStage() {
    var g = stage();
    if (!g) return;
    var h = targetH();
    sizeSlots();                                      // SLOT_W 是常数，按宽高比算出 SLOT_H / STEP
    g.style.setProperty('--hs-slot-h', SLOT_H + 'px');
    g.style.setProperty('--hs-stage-h', h + 'px');   // 写变量，不写 style.height（见 stageH）

    /* 法力槽纵向：**底边与「我方部署位那一排」的底边对齐**（用户 2026-10-03：
       *「把法力值区域抬高，下方和战场下方对齐」*）。
       我方那排是 `bottom: 200px`（见 ours.css 的 #hs-slots-player），所以它的底边 = h − 200；
       法力槽就顶着这条线往上长，高度取舞台高的 55%（夹在 200–440 之间，保证十颗水晶装得下）。 */
    var fieldBottom = h - 200;
    var manaH = Math.round(Math.max(200, Math.min(h * 0.55, 440)));
    g.style.setProperty('--hs-mana-h', manaH + 'px');
    g.style.setProperty('--hs-mana-top', Math.max(8, Math.round(fieldBottom - manaH)) + 'px');
    var 转 = 要转屏();
    /* k = 等比适应窗口，再受"缩放上限"约束（见上面那段说明）：
       上限 0 = 适应窗口（默认，窗口大就等比放大）；1 = 钉死原尺寸；1.5 / 2 = 最多放大到那个倍数。
       两个 fit 项始终在 min 里，所以任何上限下都不会溢出窗口、也不会非等比变形。 */
    var 上限 = 读缩放上限();
    var k = Math.min(可用宽() / DESIGN_W, 可用高() / h);
    if (上限 > 0) k = Math.min(k, 上限);
    g.style.transform = 'translate(-50%, -50%)' + (转 ? ' rotate(90deg)' : '') + ' scale(' + k + ')';
    /* ★ 把这一拍的几何**记在元素上**，给 `toDesign()` 做逆变换用（2026-10-06）。
       为什么不能像以前那样"读 rect 反推"：旋转之后 `getBoundingClientRect()` 拿到的是**旋转后的外接矩形**，
       由它反推出来的 k 与原点都是错的（指针→设计坐标会整体偏掉）。这里存的是**唯一真相**：
       设计宽高、缩放、是否转过 90°。 */
    g.__hsFit = { k: k, 转: 转, 宽: DESIGN_W, 高: h };
    /* ★ 把缩放值暴露成 CSS 变量（2026-10-05）。为什么需要：
       整个舞台是一张被 `scale(k)` 缩放的设计画布 —— 里面的文字是"先按设计字号光栅化、再被放大 k 倍"，
       k 不是整数时**每个字都会糊**（用户："设置按钮、视角按钮的分辨率好模糊"；实测 k=1.024、dpr=1）。
       右栏那几个 chrome 元素用这个变量做**反向缩放**（`scale(1/k)`），让它们按 1:1 光栅化 —— 字就实了。
       画布上也写一份，方便将来舞台外的元素复用同一个口径。 */
    g.style.setProperty('--hs-stage-k', String(k));
    try { if (d.documentElement) d.documentElement.style.setProperty('--hs-stage-k', String(k)); } catch (e) {}
  }

  /* 自愈：每次鼠标按下去之前对一下 —— 如果舞台的实际缩放和当前窗口该有的缩放不一致，
     就重新 fit 一次。
     为什么需要这个兜底：`resize` 事件在有些环境里不一定会来（实测在受节流的内置浏览器里
     `setViewportSize` 改了视口却没触发 resize，舞台一直停在旧尺寸上）。窗口是用户随时会拖的，
     不能指望只有一个信号源。成本只有一次 getBoundingClientRect。 */
  function ensureFit() {
    var g = stage();
    if (!g) return;
    var r = g.getBoundingClientRect();
    var h = targetH();
    var k = Math.min(W.innerWidth / DESIGN_W, W.innerHeight / h);
    var 上限2 = 读缩放上限();
    if (上限2 > 0) k = Math.min(k, 上限2);
    if (Math.abs(r.width / DESIGN_W - k) > 0.005) fitStage();
  }

  /* 视口坐标 → 设计坐标。舞台被 scale 过，事件里的 clientX/Y 必须先换算
     才能拿去和设计坐标比较（箭头就画在设计坐标里）。 */
  /* 屏幕坐标 → 设计坐标。**两种情况分开算**（2026-10-06 加转屏支持）：
     · 不转：舞台的布局盒 Wd×Hd 被 `left/top:50% + translate(-50%,-50%)` 钉在屏幕正中，
       所以 `screen = 屏幕中心 + ((设计坐标 − 盒中心) × k)`；
     · 转 90°：多一层顺时针旋转，本地偏移 (dx,dy) → (−dy, dx)，于是
       `screen = (中心x − (y − Hd/2)·k, 中心y + (x − Wd/2)·k)`。
     ⚠ 别用 `getBoundingClientRect()` 反推 —— 旋转后它给的是**外接矩形**，k 与原点都错（见 fitStage 的 __hsFit）。 */
  function toDesign(clientX, clientY) {
    var g = stage();
    if (!g) return { x: clientX, y: clientY };
    var f = g.__hsFit;
    if (!f) {                                    // 兜底：还没 fit 过（启动最初那一拍）→ 退回旧算法
      var r0 = g.getBoundingClientRect();
      var k0 = r0.width / DESIGN_W || 1;
      return { x: (clientX - r0.left) / k0, y: (clientY - r0.top) / k0 };
    }
    var cx = (W.innerWidth || 0) / 2, cy = (W.innerHeight || 0) / 2;
    if (!f.转) return { x: (clientX - cx) / f.k + f.宽 / 2, y: (clientY - cy) / f.k + f.高 / 2 };
    return { x: (clientY - cy) / f.k + f.宽 / 2, y: -(clientX - cx) / f.k + f.高 / 2 };
  }

  /* ==================== 权威状态（改进 B）：取值器 + 画笔 + 提交点 ====================
     分工写清楚：**状态层（游戏/状态.js）不碰 DOM**，它只管"权威状态长什么样、怎么求差、
     怎么对账、怎么追平"；DOM 的知识全在这两个函数里 —— 于是状态层的核心能在 node 里直接测。 */
  function 采集场面() {
    if (!d.getElementById('game')) return null;
    var 读数字 = function (sel) {
      var e = d.querySelector(sel);
      var t = e ? String(e.textContent || '').trim() : '';
      var n = parseInt(t, 10);
      return isFinite(n) ? n : 0;
    };
    var mm = String((找id('mana') || {}).textContent || '0/0').split('/');
    /* 场上采集：**形状与引擎一致**（2026-10-04 修正）——
       `席位[侧].场上` 只放 id，单位的字段进 `单位` 映射。
       为什么改：状态层的 求差/应用 就是按这个形状写的（压入/抽出拿 id、字段变化写成
       `置 ['单位', id]`），而这里原来交的是**对象数组**，于是"把变更重放回旧状态"永远对不上，
       `ATOMIC_VIOLATION` 在正常对局里乱报（报告里还看不出差在哪）。详见 状态.js 里的说明。 */
    var 单位表 = {};
    function 采场上(侧) {
      var 选择 = (侧 === 'player') ? '.board--player .cardinplay' : '.board--opponent .cardinplay';
      var 出 = [];
      Array.prototype.forEach.call(d.querySelectorAll(选择), function (el) {
        if (!el.id) return;
        var 徽 = el.querySelector('.hs-cost'), 恢 = el.querySelector('.hs-rest'), 名 = el.querySelector('.hs-board-name');
        var 取数 = function (e) { var n = e ? parseInt(String(e.textContent).replace(/[^0-9-]/g, ''), 10) : NaN; return isFinite(n) ? n : null; };
        单位表[el.id] = {
          id: el.id, 卡: el.__hsName || (名 ? 名.textContent : ''),
          攻: 读攻(el), 血: 读血(el), 攻耗: 取数(徽), 恢复: 取数(恢)
        };
        出.push(el.id);
      });
      return 出;
    }
    var 席位 = {
      player: { 英雄血: 读数字('.playerHeroHealth'), 场上: 采场上('player') },
      enemy: { 英雄血: 读数字('.opposingHeroHealth'), 场上: 采场上('enemy') }
    };
    return {
      回合: (W.HS_RESOURCE && typeof W.HS_RESOURCE.回合 === 'function') ? W.HS_RESOURCE.回合() : 1,
      法力: parseInt(mm[0], 10) || 0,
      法力上限: parseInt(mm[1], 10) || 0,
      单位: 单位表,
      席位: 席位,
      手牌: Array.prototype.map.call(全部('#cards .card'), function (c) {
        var n = c.querySelector('.hs-name');
        return n ? n.textContent : '?';
      })
    };
  }

  /* 画笔：把权威状态里的**关键数字**重画回 DOM（"跳过动画" = 调它 + 标记追平）。
     只画规则信息（血量/法力/攻血），不碰位置、不碰演出 —— 那些是展示层自己的事。 */
  function 追平画面(权) {
    var 写 = function (sel, v) { var e = d.querySelector(sel); if (e) e.textContent = String(v); };
    写('.playerHeroHealth', 权.席位.player.英雄血);
    写('.opposingHeroHealth', 权.席位.enemy.英雄血);
    var mana = 找id('mana');
    if (mana) mana.textContent = 权.法力 + '/' + 权.法力上限;
    ['player', 'enemy'].forEach(function (侧) {
      var 席 = (权.席位 && 权.席位[侧]) || {};
      var 单位 = 权.单位 || {};
      (席.场上 || []).forEach(function (id) {
        var u = 单位[id];                    // 场上只放 id：字段要去 单位 映射里取（形状对齐引擎）
        if (!u) return;
        var el = d.getElementById(u.id);
        if (!el) return;
        var a = el.querySelector('.hs-atk'), h = el.querySelector('.hs-hp');
        if (a) a.textContent = u.攻;
        if (h) h.textContent = u.血;
      });
    });
    try { if (W.HS_RESOURCE && typeof W.HS_RESOURCE.渲染 === 'function') W.HS_RESOURCE.渲染(); } catch (e) {}
  }

  /* 提交点：**这一拍之后，局面已经定型** —— 采一份权威、求差、revision+1、记事件。
     三件事同时兑现：① 检错层能查 ATOMIC_VIOLATION/REVISION_GAP/LOG_INCOMPLETE；
     ② 对账有了基准（非提交点的 DOM 变化都会现形 = "两套真相"的探针）；
     ③ "跳过动画"有了追平目标（追平到最新 revision）。 */
  function 提交场面(原因) {
    if (!W.HS_STATE || typeof W.HS_STATE.提交 !== 'function') return null;
    var r = null;
    try { r = W.HS_STATE.提交(采集场面, 原因 || ''); } catch (e) { 报(4, 'ATOMIC_VIOLATION', { 抛错: String(e && e.message) }, '严重'); return null; }
    if (r && r.问题 && r.问题.length) {
      /* 每条问题都是 { 码, 上下文 }（状态层改了形状，见 状态.js 的 提交）——
         上下文里带**差异路径**，报告里就能直接读出"是哪条路径对不上"。 */
      r.问题.forEach(function (问) {
        var 码 = (typeof 问 === 'string') ? 问 : 问.码;
        var 上下文 = { 提交: 原因 || '', revision: r.revision };
        if (问 && 问.上下文) for (var k in 问.上下文) if (问.上下文.hasOwnProperty(k)) 上下文[k] = 问.上下文[k];
        报(4, 码, 上下文, '严重');
      });
    }
    /* ★ E（演出消费事件 / 版本追平）：提交之后**等演出播完**再把"展示"标到最新版本 ——
       这就是流程图里"展示状态追上权威状态"那一步。
       为什么放在这里而不是演出层：演出只管播，**"什么时候算追上"是状态层的事**；
       而且这句只在提交点挂一次，演出队列自己排空就回调，不需要任何轮询。
       "跳过动画"另有其路（追平 = 直接按权威重画），两者最终都收敛到 revision 一致。 */
    if (r && W.HS_PIPELINE && typeof W.HS_PIPELINE.whenIdle === 'function' && W.HS_STATE) {
      try {
        W.HS_PIPELINE.whenIdle().then(function () {
          try { W.HS_STATE.展示追到(r.revision); } catch (e) {}
        });
      } catch (e) {}
    }
    return r;
  }

  /* ==================== 部署位：几何与格子表 ======================= */

  /* 每侧几个部署位：**由卡库.js 乙段定好**（挑战关按关卡表的 slots：第一关 1 格 → 第五关 5 格；
     自由关按 ?free=1|3|5），界面只负责读 —— 本局的形状只能有一个来源。
     读不到才退回 5（例如 node 里单独装这个文件时）。 */
  var SLOT_COUNT = W.HS_SLOTS || 5;
  /* 格子尺寸不再写死 —— fitStage() 每次按舞台高度算出来并回填这三个变量，
     同时写进 CSS 变量给样式用。窗口越矮格子越小，所以上下两排永远不会撞在一起。 */
  var SLOT_W = 150, SLOT_H = 200, SLOT_GAP = 12;
  var STEP = SLOT_W + SLOT_GAP;

  function boardOf(side) {
    return d.querySelector(side === 'player' ? '.board--player' : '.board--opponent');
  }

  /* 元素查找层在 游戏/查找.js（独立模块：沙盒**单条规则**有长度上限，界面.js 早就贴着门限）。
     这里只取别名，让下面原有调用点一个字都不用改；为什么这么做见那个文件的开头。
     ⚠ 名字是 HS_查找，**不是** HS_UI —— 本文件末尾把 HS_UI 用作"刷新任务区"那个小导出，撞过一次。 */
  var 找 = W.HS_查找.找, 找id = W.HS_查找.找id, 全部 = W.HS_查找.全部, 根元素 = W.HS_查找.根;
  var slots = { player: [], enemy: [] };
  for (var _si = 0; _si < SLOT_COUNT; _si++) { slots.player.push(null); slots.enemy.push(null); }
  /* ★★ 两步点选出牌（2026-10-04，用户"导出后手牌用不了"的应对）：
     点一下手牌 → 进入"选格"（点亮两排格位 + 提示条），再点一个空格子 → 出牌。
     为什么要多加这条路：**拖拽出牌依赖的东西太多** —— 精确的落点坐标、舞台缩放的换算、
     只在 mousedown 上挂的处理器；在独立网页里这些都对得上，装进别人家的页面（沙盒舞台）就变脆，
     而且触摸设备上更明显。两步点选只用到"点在哪一格"这一个几何判断，鼠标/触摸/笔都一样。 */
  var 点选卡 = null;
  var pendingSlot = -1;         // 玩家这一次想把卡放哪一格

  function firstFree(side) {
    var s = slots[side];
    for (var i = 0; i < SLOT_COUNT; i++) if (!s[i]) return i;
    return -1;
  }

  function placeAt(side, el, i) {
    slots[side][i] = el;
    // 按**真实格子**的偏移定位（cellLeft 直接量 DOM）——不再用 i × 常量推算，
    // 免得 JS 常量与 CSS 实际尺寸不同步时卡片落偏。
    el.style.left = cellLeft(i, side) + 'px';
    el.dataset.slot = String(i);
  }

  function assignNew(side, el) {
    if (!el) return;
    stampName(side, el);
    if (el.__hsSlotted) return;
    var want = (side === 'player') ? pendingSlot : -1;
    var i = (want >= 0 && want < SLOT_COUNT && !slots[side][want]) ? want : firstFree(side);
    if (i < 0) {
      /* ★★ 满员：这张卡**不该留在场上**（用户 2026-10-03）。
         任何登场途径（出牌 / 召唤 / 复制）都必须先检索有没有空格 ——
         上游是"先 append 进 DOM、再算效果"，所以满了它照样 append，
         而这里找不到空格时原来的写法是直接 return，于是那张卡没有 left，
         停在棋盘左缘（= 第 1 格的位置）：表现就是"都挤在第一格"。
         现在**把它收掉**（撤回这次登场），并给一声提示。 */
      提示码('BOARD_FULL_DEPLOY', { 方: side === 'player' ? '我方' : '敌方' });
      el.__hsNoGhost = true;                 // 登场失败不该演"退场"动画
      try { el.remove(); } catch (err) { el.style.left = cellLeft(SLOT_COUNT - 1, side) + 'px'; }
      return;
    }
    el.__hsSlotted = true;
    /* ★★ 给场上卡补一个**第三个子节点**（空 div）—— 上游处理"神圣护盾/嘲讽破裂"
       时一律要读 `children[2]`（例如 `currentAttackerElement.children[2].classList.add('divineShieldBreak')`），
       而场上的卡只有两个徽章、没有第三个节点 → 那里**直接抛 TypeError**，
       于是在它后面的扣血代码整段不执行：表现就是"有护盾的单位护盾没生效"（还会连累那次攻击）。
       这是我在几轮前记下但没修的潜在坑，2026-10-03 真的踩到了。
       补一个空节点即可：护盾遮罩图本来就被剥掉了，空 div 正好当它的占位。 */
    if (el.children.length < 3) {
      try { el.appendChild(d.createElement('div')); } catch (err) { /* 补不上也不影响落格 */ }
    }
    placeAt(side, el, i);
    pendingSlot = -1;
  }

  /* ==================== ★ 手牌排布（用户 2026-10-03）====================
     问题：手牌是 flex + 固定 10px 间隙、卡宽 100px —— **10 张 = 1000 + 9×10 = 1090px**，
     而手牌区只有 965px，于是整行被两端裁掉：最左那张缺一角、最右那张也缺一角
     （用户截图里 "Razorfen Hunter" 与第 10 张都是半个）。手牌上限本来就是 **10**
     （上游 `hand.childElementCount != 10`，引擎里 `手牌上限` 也是 10，两边一致），
     所以这里要做的不是"提高上限"，而是**让 10 张排得下**。

     规则：能并排就并排（保持自然的 10px 间隙）；排不下就按张数**压缩步距**（轻微重叠），
     但再挤也留 40px 的可见宽度 —— 于是 1~10 张永远整行落在手牌区里，一张都不会被切。
     为什么不用"缩小卡片"：卡面要读攻/血/文案，缩了更看不清；重叠只吃掉左右各几像素。
     步距用**行内 margin** 写（flex 的 gap 没法按张数变），并在 `#cards` 上挂观察器：抽牌、
     出牌、开局发牌都会重排，不用谁记得调。 */
  var 手牌上限 = 10;                 // 与引擎的「手牌上限」保持一致
  var 最小步距 = 40;

  /* 手牌「出得起 / 出不起」：给边框染色（行内样式，`样式.css:358` 那条约定保留）。
     这份活儿原来是上游 `checkForRequiredMana()` 干的（它在 index.js 里，读的是自己的 `mana`）——
     2026-10-05 起我们出牌不再经过它，所以这里接手。
     **判定读资源层那个数**（与出牌校验同一个来源），不会再出现"显示能出、点了说不够"。
     故意**不写 `pointer-events`**：我们的拖拽是捕获阶段按坐标算的，把卡设成不吃指针
     会让它连拖都拖不起来 —— 出不起时给一句说法（见出牌那段的 INSUFFICIENT_MANA）比变成死卡好。 */
  function 刷可出性() {
    var box = d.getElementById('cards');
    if (!box) return 0;
    var 有 = (W.HS_RESOURCE && typeof W.HS_RESOURCE.法力 === 'function')
      ? Number(W.HS_RESOURCE.法力()) : Number(W.mana);
    var 张 = box.querySelectorAll(':scope > .card');
    var 能出 = 0;
    for (var i = 0; i < 张.length; i++) {
      var c = readCard(张[i]);
      var 费 = c ? Number(c.mana) : NaN;
      var ok = isFinite(费) && (有 >= 费);
      if (ok) 能出++;
      var 脸 = 张[i].children[0];
      var 边 = 脸 && 脸.children[4];
      if (边) 边.style.border = ok ? 'solid 4px #0FCC00' : 'solid 4px rgb(56, 56, 56)';
    }
    return 能出;
  }

  function 排手牌() {
    var box = d.getElementById('cards');
    if (!box) return 0;
    var 张 = box.querySelectorAll(':scope > .card');
    var n = 张.length;
    if (!n) return 0;
    var 卡宽 = 张[0].offsetWidth || 100;
    var 区宽 = box.clientWidth || 965;
    var 自然步距 = 卡宽 + 10;                     // 卡的宽 + 原本那 10px 间隙
    var 步距 = (n > 1) ? Math.min(自然步距, (区宽 - 卡宽) / (n - 1)) : 0;
    步距 = Math.max(最小步距, Math.floor(步距));
    for (var i = 0; i < n; i++) {
      张[i].style.marginLeft = (i === 0) ? '0px' : (步距 - 卡宽) + 'px';
    }
    /* 手牌一变就顺带刷一次"出得起"（抽牌、出牌、开局发牌都走这里，不靠谁记得调） */
    刷可出性();
    return 步距;
  }

  function 盯手牌() {
    var box = d.getElementById('cards');
    if (!box || box.__hsHandWatched || !W.MutationObserver) return;
    box.__hsHandWatched = true;
    new W.MutationObserver(排手牌).observe(box, { childList: true });
    排手牌();
  }

  function syncSlots() {
    ['player', 'enemy'].forEach(function (side) {
      var board = boardOf(side);
      if (!board) return;
      var alive = Array.prototype.slice.call(board.children).filter(function (c) {
        /* ⚠ 必须排掉**退场克隆体**：它保留 `cardinplay` 类、又被放回原棋盘（为了跟着桌面倾斜），
           不排掉就会被当成一张真卡 —— 会占掉一个格子、甚至让"满员"判断提前成立
           （全线排查 2026-10-03 发现的）。 */
        return c.classList && c.classList.contains('cardinplay') && !c.classList.contains('hs-fx-ghost');
      });
      for (var i = 0; i < SLOT_COUNT; i++) {
        if (slots[side][i] && alive.indexOf(slots[side][i]) < 0) slots[side][i] = null;   // 走了
      }
      alive.forEach(function (el) { assignNew(side, el); });                              // 新来的
      挂全部体力徽章();                    // ★ 体力徽章（卡名可能晚一刻才认出来，所以每轮都补一遍）
      for (var k = 0; k < SLOT_COUNT; k++) {
        if (slots[side][k]) slots[side][k].style.left = cellLeft(k, side) + 'px';          // 摆回自己那一格
      }
      markTaken(side);
    });
  }

  /* 战场图层：两块棋盘 + 两排部署位都搬进 #hs-table。
     为什么要有这一层：立体视角要**只把战场往后倒**，手牌/右栏/法力条必须留在屏幕坐标系里
     （参考图就是这个分层）。倾斜是一个 transform，所以需要一个只包战场的容器。
     平铺视角下它是 inset:0 的中性层 —— 里面那些绝对定位元素的位置一个像素都不变。 */
  function table() { return d.getElementById('hs-table'); }

  function buildTable() {
    var g = stage();
    if (!g || d.getElementById('hs-table')) return;
    var t = d.createElement('div');
    t.id = 'hs-table';
    g.appendChild(t);
    /* 上游按 id/class 取这些元素、拿的是引用，所以搬家不影响它；
       但卡片是 append 到 .board--* 里的，棋盘必须跟着搬，否则卡不在这个图层里。 */
    ['.board--player', '.board--opponent'].forEach(function (sel) {
      var e = d.querySelector(sel);
      if (e && e.parentNode !== t) t.appendChild(e);
    });
  }

  function buildRows() {
    var t = table();
    if (!t || d.getElementById('hs-slots-player')) return;
    ['enemy', 'player'].forEach(function (side) {
      var row = d.createElement('div');
      row.className = 'hs-row';
      row.id = 'hs-slots-' + side;
      for (var i = 0; i < SLOT_COUNT; i++) {
        var s = d.createElement('div');
        s.className = 'hs-slot';
        s.setAttribute('data-slot', String(i + 1));
        row.appendChild(s);
      }
      t.appendChild(row);
    });
  }

  /* 格子矩形：**直接量那一格自己的 rect**，不自己拿常量推算。
     上一版是按 SLOT_W/STEP 算的，而格子宽度实际由 ours.css 定（168）、JS 常量还是旧的 150
     —— 两边一旦不同步，第 2 格往后全部错位（命中与落格都会偏）。
     量真的 DOM 就不可能对不上。 */
  function slotRect(side, i) {
    var row = d.getElementById('hs-slots-' + side);
    if (!row) return null;
    var el = row.children[i];
    if (el) {
      var b = el.getBoundingClientRect();
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    }
    var r = row.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.left, bottom: r.top };
  }

  /* 第 i 格在**棋盘内**的左边距（设计坐标）—— 部署时写 el.style.left 用。
     ⚠ 用 `offsetLeft` 而**不是** getBoundingClientRect：offsetLeft 是布局值，与 transform 无关；
     立体视角下棋盘被 rotateX，量到的是投影后压扁的距离，卡片会一格一格往里挤。
     ★★ 基准是**行**的 offsetLeft，不是"第 0 格"、也不是棋盘的（用户 2026-10-03 报的错位）。
     三者的坐标空间必须分清楚（2026-10-03 实测的数值就摆在这儿）：
       · `.hs-slot` 的 offsetLeft 是**行内坐标**（行是 absolute）：2 格那关实测 = 288，
         正是居中留出的边距 (888 − 312)/2；
       · `.player-cardinplay` 的 `left` 是**板内坐标**（板是 absolute，见 styles.css:441），
         实测棋盘与行的 offsetLeft **同为 85**（同父同级、同一套 left 算式）；
       · 所以"格子的行内坐标"就等于"卡片的板内坐标"，**直接把 cell.offsetLeft 当 left 用**；
         再额外加一个修正项 (行左缘 − 棋盘左缘)：两者本该相等，万一哪天又不相等
         （这个坑真发生过：棋盘 left 引用未定义变量 → 整句失效 → 棋盘落回 x=0 → 卡整体左偏 85px，
         见 ours.css 里 `.board` 那段注释），修正项会自动把它掰回来。
     前两版分别写成「减第 0 格」（格子改成居中之后，第 0 格不再是 0 → 整体少算一个居中边距）
     和「减棋盘 offsetLeft」（把行内坐标当成表内坐标去减表内坐标 → 混了空间）。
     两版都表现为"角色没站在虚线框里" —— 用户报的就是这个。 */
  function cellLeft(i, side) {
    var s = (side === 'enemy') ? 'enemy' : 'player';
    var row = d.getElementById('hs-slots-' + s);
    if (!row) return i * STEP;
    var cell = row.children[i];
    if (!cell) return i * STEP;
    var board = boardOf(s);
    var 修正 = (board && board.offsetParent === row.offsetParent)
      ? (row.offsetLeft - board.offsetLeft) : 0;
    return Math.round(cell.offsetLeft + 修正);
  }

  function slotAt(side, clientX, clientY) {
    for (var i = 0; i < SLOT_COUNT; i++) {
      var r = slotRect(side, i);
      if (r && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return i;
    }
    return -1;
  }

  function markTaken(side) {
    var row = d.getElementById('hs-slots-' + side);
    if (!row) return;
    for (var i = 0; i < SLOT_COUNT; i++) {
      var el = row.children[i];
      if (!el) continue;
      var taken = !!slots[side][i];
      el.classList.toggle('taken', taken);
      if (taken) el.classList.remove('hot');
    }
  }

  function showRow(side) {
    var row = d.getElementById('hs-slots-' + side);
    if (!row) return;
    syncSlots();
    row.classList.add('active');
  }

  function hideRows() {
    ['player', 'enemy'].forEach(function (side) {
      var row = d.getElementById('hs-slots-' + side);
      if (!row) return;
      row.classList.remove('active');
      Array.prototype.forEach.call(row.children, function (e) { e.classList.remove('hot'); });
    });
  }

  function hotSlot(side, i) {
    var row = d.getElementById('hs-slots-' + side);
    if (!row) return;
    for (var k = 0; k < SLOT_COUNT; k++) {
      var el = row.children[k];
      if (!el) continue;
      el.classList.toggle('hot', k === i && !el.classList.contains('taken'));
    }
  }

  /* ==================== ③ ④ 箭头层与卡面预览 ==================== */

  var arrow = null, arrowLine = null, arrowHead = null, preview = null, mask = null;

  /* 右栏顶部那颗「设置」与底部预留的「任务区」（图 1 里那两个框）。
     设置按钮直接复用上游的游戏菜单 `showGameMenu()` —— 它已经在 index.html 的内联脚本里了。 */
  function buildChrome() {
    var g = stage();
    if (!g) return;

    /* ★ 检错层接线（全链路检错）：登记"每个码怎么**回到安全节点**"，以及"致命错误怎么暂停"。
       这张表就是那张图右下角的分支：**可恢复 → 回到安全节点；不可恢复 → 暂停游戏并提示用户**。
       为什么放在这里：这些恢复动作（撤临时图层 / 关面板 / 跳过演出 / 重画）都是界面自己会的事，
       检错层只管"什么时候叫它们"。 */
    if (W.HS_CHECK) {
      var 码 = W.HS_CHECK.码;
      W.HS_CHECK.登记恢复(码.展示残留, function () {
        ['hs-mask', 'hs-arrow', 'hs-preview'].forEach(function (id) {
          var e = 找id(id); if (e) e.classList.remove('on');
        });
      });
      W.HS_CHECK.登记恢复(码.模态压场, function () {
        if (W.HS_SANDBOX && typeof W.HS_SANDBOX.关面板 === 'function') W.HS_SANDBOX.关面板();
        else {
          ['hs-codex', 'hs-start', 'campaign-overlay'].forEach(function (id) {
            var e = 找id(id); if (e) e.classList.remove('on');
          });
          var m = d.getElementById('hs-mainmenu'); if (m) m.style.display = 'none';
        }
      });
      W.HS_CHECK.登记恢复(码.锁卡住, function () {
        try { if (W.HS_PIPELINE && typeof W.HS_PIPELINE.skip === 'function') W.HS_PIPELINE.skip(); } catch (e) {}
      });
      W.HS_CHECK.登记恢复(码.上限不符, function () {
        try { if (W.HS_RESOURCE && W.HS_RESOURCE.渲染) W.HS_RESOURCE.渲染(); } catch (e) {}
      });
      /* ★ 改进 B：**提交层自己发现的断层**（ATOMIC_VIOLATION / REVISION_GAP）恢复动作 =
         "按权威追平"（重画血量/法力/攻血）—— 这两种场合权威一定是对的。
         ⚠ **`UI_WRONG_SOURCE` 故意不在自动恢复表里**（2026-10-04 实测教训）：
         对账不一致**未必是 DOM 错**，也可能是**权威自己过期**（例如基准建得太早）——
         那时"按权威追平"会把真实进度改回去 ✗。所以它只**上报**，由自检/人判断哪个对；
         （本仓库里的做法：自检 ㉟ 里专门有一条"偷改 DOM → 对账抓到 → 追平改回"来验追平本身是好的。） */
      ['ATOMIC_VIOLATION', 'REVISION_GAP'].forEach(function (k) {
        W.HS_CHECK.登记恢复(k, function () {
          try { if (W.HS_STATE) W.HS_STATE.追平(追平画面); } catch (e) {}
        });
      });
      /* 检错层自己不碰 DOM：把"怎么采一份场面"注册给它（它只在跑不变量时用） */
      W.HS_UI_取值 = 采集场面;
      /* ★ 建立期提交**必须等发牌之后**（改进 B 的第二次实测抓到的）：
         `buildChrome` 跑在启动那一刻，此时 #cards 还是空的、法力还是 0/0 ——
         这时候建基准，之后真实的发牌/进对局就全成了"对账不一致"，
         更糟的是**追平会拿这份过期权威把真实进度改回去**。
         所以这里等发牌（#cards 有牌）再建基准。 */
      (function 等发牌再建基准() {
        var 次 = 0;
        (function 试() {
          var 有牌 = 全部('#cards .card').length > 0;
          if (有牌 || 次++ > 60) { 提交场面('建立'); return; }
          W.setTimeout(试, 50);
        })();
      })();
      W.HS_CHECK.登记暂停(function (条) {        /* 不可恢复：**暂停游戏并提示用户**（复用失败条那套观感，但文案是"出问题了，请导出本局信息"） */
        try {
          var bar = d.getElementById('hs-losebar');
          if (!bar) {
            bar = d.createElement('div'); bar.id = 'hs-losebar';
            var 字 = d.createElement('span'); bar.appendChild(字);
            var 导 = d.createElement('button'); 导.className = 'campaign-btn'; 导.textContent = '导出本局信息';
            导.onclick = function () { try { showReport(); } catch (e) {} };
            bar.appendChild(导);
            ((W.HS_UI_宿主 && W.HS_UI_宿主()) || d.body).appendChild(bar);
          }
          bar.querySelector('span').textContent = '牌桌出了点问题（' + 条.码 + '），已暂停';
          bar.classList.add('on');
        } catch (e) {}
      });
    }

    /* ⚠ 把双方名字标签**搬进 `#game`**。
       它们原本是 `#contents` 的子节点，而 `#contents` **不在被缩放的舞台里** ——
       于是 ours.css 里给它们写的设计坐标（x≈1014）在未缩放的空间里等于 1014px，
       直接落到视口外面去了（实测 rect.left = 1014 > 视口宽 900）。
       搬进来之后它们才和舞台一起缩放。（上游都按 id 取它们，搬家不影响。） */
    /* ⚠ 2026-10-05：这里原来把 `#playerlabel` / `#playerclasslabel` / `#opponentlabel` / `#vs`
       搬进 `#game`（给右栏那两个头像框当标题）。**那四个元素已从 index.html 删除**
       （用户："左上角还有玩家 vs 对方的字样，那个没有存在必要，删除"），所以这一段一起删掉 ——
       留着一份"往不存在的元素上搬家"的代码，只会让人以为标记里还有。 */

    /* ★★ 2026-10-05：**结束回合按钮与双方英雄框也搬进来**。这一步修的是"卡牌预览被它们压住"。
       它们（含英雄血量数字）原本是 `#contents` 的直接子节点，而 `#game` 有自己的**层叠上下文**
       （`transform` 会新建一个）—— 于是 `#hs-preview` 那个 `z-index:200` 只能在自己那个上下文
       里赢，**永远压不过上下文之外的兄弟**（实测：预览正中命中是 `#endturn`）。
       搬进来之后三件事一起对了：① 层叠可比（预览 200 > 它们）；② 跟着舞台一起缩放
       （留在 `#contents` 里的话，舞台缩放≠1 时它们会和右栏错位）；③ 与右栏同一个坐标系。 */
    /* ⚠⚠ 这两样**也必须搬进来**（2026-10-05 实测，和上面同一个坑的两副面孔）：
       `#cards`（手牌区，`z-index:9`）与 `#mana`（法力数字）原本是 `#contents` 的直接子节点，
       而 `#game` 有自己的层叠上下文（有 transform）——
         · **层叠**：`#cards` 的 9 是去跟"整个 `#game`（z=auto）"比大小的，于是**手牌永远画在右栏之上**
           （自检 ㉚ 报的"任务区 ← 被 cards 盖住"就是这个，右栏抬到 12 也没用：12 只在 `#game` 里面算数）；
         · **缩放**：它们在舞台**外面**，所以**不随舞台缩放** —— 小视口下实测手牌区宽 965px 而舞台只有 844px，
           比舞台还宽；法力数字也会和管身错位。
       搬进来之后两者都归位：坐标按**设计画布**算（这正是 样式.css 里写 965px / 设计坐标的本意），
       层叠也在同一个上下文里比（预览 200 > 右栏 12 > 手牌 9 > 棋盘）。 */
    ['endturn', 'cards', 'mana'].forEach(function (id) {
      var e = 找id(id);
      if (e && e.parentNode !== g) g.appendChild(e);
    });
    ['.playerhero', '.opponenthero'].forEach(function (sel) {
      try { var e = d.querySelector(sel); if (e && e.parentNode !== g) g.appendChild(e); } catch (err) {}
    });

    if (!找id('hs-settings')) {
      var b = d.createElement('button');
      b.id = 'hs-settings';
      b.textContent = '设置';
      b.onclick = function () {
        /* 走我们自己的菜单入口（游戏/菜单.js）—— 与 ESC 是同一个口子。
           上一版调的是 `index.html` 末尾内联的 `showGameMenu()`，而那个函数定义在
           `</body>` 之后、抽骨架时被丢掉，沙盒里根本不存在 → 按钮点了没反应。 */
        if (W.HS_MENU && typeof W.HS_MENU.开 === 'function') { W.HS_MENU.开(); return; }
        if (typeof W.showGameMenu === 'function') W.showGameMenu();      // 兜底（独立网页旧路径）
      };
      g.appendChild(b);
    }
    /* 视角切换（用户 2026-10-02）。按钮文字显示的是**当前**视角，所以点击时切换。 */
    if (!d.getElementById('hs-view')) {
      var vb = d.createElement('button');
      vb.id = 'hs-view';
      vb.textContent = '平铺视角';
      vb.title = '切换 平铺 / 立体 视角（快捷键 V）';
      vb.onclick = toggleView;
      g.appendChild(vb);
    }
    if (!d.getElementById('hs-quest')) {
      var q = d.createElement('div');
      q.id = 'hs-quest';
      /* 「任务」区（用户 2026-10-03 定的方向）：法力水晶上限以后要靠
         **完成正面任务 +1 / 触发负面任务 -1** 来长，任务就摊在这里。
         此刻任务表还是空的（法力系统在下一轮），所以先把**框和读数**摆好：
         第一行是当前法力上限，下面是任务清单 —— 读 `W.HS_TASKS`，空表就说空表。
         「导出本局信息」按用户要求**搬进设置**里了（见下面那段）。 */
      q.innerHTML = '<div class="hq-label">任务</div>' +
                    '<div class="hq-note" id="hq-mana">法力上限 —</div>' +
                    '<div class="hq-tasks" id="hq-tasks"></div>';
      g.appendChild(q);
      渲染任务区();
    }

    /* ★ 「导出本局信息」从任务区**搬进设置**（用户 2026-10-03：报错入口放设置里面）。
       ⚠ 2026-10-04 用户报"导出报错无法点击"：最早 append 进上游抽屉的 `#gamemenuContent`，
       而那里面上游的按钮是**绝对定位**的 —— 我们的按钮看得见、点不到
       （实测 `elementFromPoint` 命中的是 `concedebutton`；把 z-index 抬到 41 也没用，
       因为那些按钮的层叠上下文压过了抽屉内容这一层）。
       现在挂进抽屉的**标题栏** `#gamemenuTitle`：那里永远在最上面、也不会被任何按钮盖住。 */
    var 设置抽屉 = d.getElementById('gamemenuContent');
    var 设置标题 = d.getElementById('gamemenuTitle');
    if ((设置抽屉 || 设置标题) && !d.getElementById('hs-report-btn')) {
      var rb = d.createElement('button');
      rb.id = 'hs-report-btn';
      rb.textContent = '导出本局信息（报错用）';
      rb.onclick = function () { showReport(); };
      (设置标题 || 设置抽屉).appendChild(rb);
    } else if (!设置抽屉 && !设置标题 && W.console && W.console.error) {
      W.console.error('[设置] 找不到 #gamemenuContent / #gamemenuTitle，导出本局信息的入口没挂上');
    }
  }

  /* 任务区渲染（法力上限 + 任务清单 + 上限变化账本）。
     数据来源分两处，都是**唯一真相**、不另存副本：
       · 法力上限/历史 → `W.HS_RESOURCE`（游戏/资源.js，阶段 C 收回我们手里的那层）；
       · 任务条目 → `W.HS_TASKS`（卡库.js 甲段，现在是空表 —— 玩法设计等用户给）。
     下一轮写"任务驱动法力上限"时**不需要改这里**：往 HS_TASKS 加条目、
     在判定处调 `HS_RESOURCE.完成正面任务(名)`，这个面板自己就跟着变。 */
  function 渲染任务区() {
    var 读 = d.getElementById('hq-mana');
    var 资 = W.HS_RESOURCE;
    if (读) {
      var 顶尖 = (资 && 资.顶尖 && 资.顶尖()) ||
                 (W.HS_ENGINE && W.HS_ENGINE.常量 && W.HS_ENGINE.常量.法力顶尖) || 10;
      var 上 = 资 ? 资.上限() : ((typeof W.manaCapacity === 'number') ? W.manaCapacity : '—');
      var 法 = 资 ? 资.法力() : W.mana;
      var 回 = 资 ? 资.回合() : '—';
      读.textContent = '法力上限 ' + 上 + ' / ' + 顶尖 + '　（法力 ' + 法 + '，第 ' + 回 + ' 回合）';
    }
    var 表 = d.getElementById('hq-tasks');
    if (!表) return;
    var 任务 = W.HS_TASKS || [];
    表.innerHTML = '';
    if (任务.length) {
      任务.forEach(function (t) {
        var row = d.createElement('div');
        row.className = 'hq-task' + (t.面向 === '负面' ? ' bad' : '');
        row.textContent = t.名 + '：' + (t.说明 || '') +
                          (t.面向 === '负面' ? '（−1 上限）' : t.面向 === '正面' ? '（+1 上限）' : '');
        表.appendChild(row);
      });
    } else {
      表.appendChild(造任务说明行('（任务表还没接条目 —— 机制已就绪：HS_RESOURCE.完成正面任务/触发负面任务）'));
    }
    /* 上限变化的账本：这是"机制真的在起作用"的可见证据（每一次 ±1 都留痕） */
    if (资 && 资.最近) {
      var 近 = 资.最近(3);
      for (var i = 0; i < 近.length; i++) {
        var 行 = d.createElement('div');
        行.className = 'hq-task hq-log';
        行.textContent = 近[i].文字;
        表.appendChild(行);
      }
    }
  }

  function 造任务说明行(文字) {
    var e = d.createElement('div');
    e.className = 'hq-task hq-log';
    e.style.opacity = '.6';
    e.textContent = 文字;
    return e;
  }

  function buildOverlays() {
    var g = stage();
    if (!g) return;
    if (!mask) {
      mask = d.createElement('div');
      mask.id = 'hs-mask';
      g.appendChild(mask);
    }
    if (!arrow) {
      /* 坐标是**视口坐标** —— 和上游那条红色虚线同一套。原因是立体视角：战场被 rotateX 之后，
         设计坐标到屏幕不再是线性缩放（越远压得越扁），按设计坐标画的箭头会指不到指针底下。
         ⚠ 但**宿主换成了"作品根节点"**（2026-10-05）：原来挂 `document.body`，而沙盒里
         舞台根 `z-index` 21 亿 + `#game` 不透明底色铺满整屏 → 挂 body 的箭头**画在底色下面，看不见**
         （和演出层/提示条是同一个坑）。根节点没有 transform，所以挂它**仍然是屏幕坐标系**，
         两个视角都不用改逻辑，而且层叠归位。 */

      arrow = d.createElementNS('http://www.w3.org/2000/svg', 'svg');
      arrow.id = 'hs-arrow';
      arrowLine = d.createElementNS('http://www.w3.org/2000/svg', 'line');
      ['stroke', 'stroke-width', 'stroke-linecap', 'stroke-dasharray'].forEach(function (a, i) {
        arrowLine.setAttribute(a, ['#6fbf73', '4', 'round', ''][i]);
      });
      arrowHead = d.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      arrowHead.setAttribute('fill', '#6fbf73');
      arrow.appendChild(arrowLine);
      arrow.appendChild(arrowHead);
      ((W.HS_UI_宿主 && W.HS_UI_宿主()) || d.body || g).appendChild(arrow);
    }
    if (!preview) {
      preview = d.createElement('div');
      preview.id = 'hs-preview';
      g.appendChild(preview);
    }
  }

  /* line / circle 不吃 fill，只有 polygon 吃 —— 箭头尖必须用 polygon。
     坐标全部是**设计坐标**。 */
  /* 手牌拖拽那条绿箭头的绘制入口。**坐标全是视口坐标**（与 #hs-arrow 的定位一致）。
     线宽与箭头随舞台缩放乘 k —— 否则窗口一大，箭头就细得像根头发。 */
  function drawArrow(x0, y0, x1, y1) {
    var k = stageK();
    arrow.classList.add('on');
    arrowLine.setAttribute('stroke-width', String(Math.max(2, 4 * k)));
    arrowLine.setAttribute('x1', x0); arrowLine.setAttribute('y1', y0);
    arrowLine.setAttribute('x2', x1); arrowLine.setAttribute('y2', y1);
    var dx = x1 - x0, dy = y1 - y0;
    var len = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
    var ux = dx / len, uy = dy / len;
    var head = Math.max(10, Math.min(len * 0.24, 26)) * k;
    var hw = head * 0.66;
    var bx = x1 - ux * head, by = y1 - uy * head;
    var px = -uy, py = ux;
    arrowHead.setAttribute('points',
      [x1 + ',' + y1,
       (bx + px * hw) + ',' + (by + py * hw),
       (bx - px * hw) + ',' + (by - py * hw)].join(' '));
  }

  /* 舞台此刻的缩放系数（箭头/线宽这类屏幕空间的东西要按它放大） */
  function stageK() {
    var g = stage();
    if (!g) return 1;
    return g.getBoundingClientRect().width / DESIGN_W || 1;
  }

  /* 指针相对舞台的**归一化位置**（0–1）。判断"指针在哪半边"必须用它、不能用设计坐标：
     立体视角下设计坐标到屏幕不是线性映射，同一个屏幕点在两个视角里会映射到不同的设计点。 */
  function norm(clientX, clientY) {
    var g = stage();
    if (!g) return { x: 0.5, y: 0.5 };
    var r = g.getBoundingClientRect();
    return { x: (clientX - r.left) / (r.width || 1), y: (clientY - r.top) / (r.height || 1) };
  }

  function hideArrow() { if (arrow) arrow.classList.remove('on'); }

  /* ---- 上游那条红色虚线的**箭头尖**（我们补的三角） ----------------------------
     上游把这个尖做成了一张光标图 `#arrowcursor`，随美术剥离一起删了 —— 于是选中单位后
     只有一条光秃秃的虚线，没有头（用户报的「只有划线，没有箭头」）。
     这里在同一个 `<svg>` 里追加一个 polygon，每次指针移动按虚线的两端重算方向。

     端点的读法：上游 attack.js 写的是 `M<指针>,<指针> <源>,<源>` ——
     **第一个点才是箭头要指向的地方**（第二个是起点）。 */
  var headEl = null;

  function ensureHead() {
    var svg = d.getElementById('svg');
    if (!svg) return;
    headEl = d.getElementById('hs-arrowhead') || null;
    if (headEl) return;
    headEl = d.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    headEl.id = 'hs-arrowhead';
    headEl.setAttribute('points', '');
    svg.appendChild(headEl);
  }

  function updateHead() {
    if (!headEl) return;
    var path = d.getElementById('svgpath');
    var m = path && /M\s*([-\d.]+)\s*,\s*([-\d.]+)\s+([-\d.]+)\s*,\s*([-\d.]+)/
      .exec(path.getAttribute('d') || '');
    if (!m) { headEl.setAttribute('points', ''); return; }
    var tx = +m[1], ty = +m[2], ox = +m[3], oy = +m[4];
    var vx = tx - ox, vy = ty - oy;
    var len = Math.max(Math.sqrt(vx * vx + vy * vy), 1);
    var ux = vx / len, uy = vy / len;
    /* 三角底边要比虚线**宽**：上游那条虚线 `stroke-width` 是 40（半宽 20），
       三角根部半宽必须大于它，否则虚线会从尖的两侧漏出来（用户 2026-10-02 报的
       "红色箭头和虚线重叠"）。所以 0.62×头长 之外再加一条 26 的下限。 */
    var head = Math.max(36, Math.min(len * 0.2, 72));
    var hw = Math.max(head * 0.62, 26);
    var bx = tx - ux * head, by = ty - uy * head;
    var px = -uy, py = ux;
    headEl.setAttribute('points',
      [tx + ',' + ty,
       (bx + px * hw) + ',' + (by + py * hw),
       (bx - px * hw) + ',' + (by - py * hw)].join(' '));

    /* ★ 把虚线**收短到三角的根部**（用户 2026-10-02：*"红色箭头和虚线重叠了，
       减去一部分虚线长度"*）。
       不收的话，上游那条 60,10 的虚线会一直画到指针底下，从红三角两侧穿出来。
       收短量取 0.9×头长：线尾落进三角体内，而那个位置的三角半宽已经 > 20（虚线的半宽），
       所以残下的那截被完整盖住 —— 既不露头，也不会在三角根部留缝。
       写回 `d` 是安全的：我们的 mousemove 挂在 `document`、上游那条挂在 `body`，
       冒泡顺序保证同一个事件里我们是**最后**写 d 的人（见 onMove 的说明）。 */
    var cut = head * 0.9;
    var qx = Math.round((tx - ux * cut) * 100) / 100;
    var qy = Math.round((ty - uy * cut) * 100) / 100;
    if (path) path.setAttribute('d', 'M' + qx + ',' + qy + ' ' + ox + ',' + oy);
  }

  /* 读卡面数据。
     ⚠ 用 `textContent` 而不是 `innerText`：`innerText` 依赖布局，一旦刚改过样式/变换
     （比如舞台缩放、或者卡片刚被压成幽灵）而布局还没冲刷，它会**静默返回空串** ——
     实测就是这么把牌名读成 "" 的，导致出牌判定查不到这张牌、直接放弃。
     `textContent` 不走布局，读到什么就是什么。 */
  function readCard(el) {
    var f = el.children[0];
    if (!f) return null;
    function t(i) {
      var e = f.children[i];
      return e ? String(e.textContent || '').replace(/\s+/g, ' ').trim() : '';
    }
    return { atk: t(0), hp: t(1), mana: t(2), info: t(3), name: t(5) };
  }

  /* 预览面板的内容渲染。左右与上下都用**归一化屏幕位置**决定（0–1），不用设计坐标 ——
     见 norm() 的说明：立体视角下两者不是同一个东西。
     字段允许为空：手牌有全部字段；**场上的卡只有攻血**（卡面在去卡图那轮被清空了）。
     ⚠ 这个函数原先引用了已删掉的 ZONE_SPLIT 常量 —— 抛 ReferenceError 之后，
       紧随其后的 applyMask() 就再也不会执行，症状是"遮罩和预览整块消失"。 */
  function renderPreview(c, nx, ny) {
    if (!c || !preview) return;
    // 左右：指针偏左 → 预览放右侧；偏右 → 放左侧（用户 2026-10-02）
    var side = (nx < 0.5) ? 'side-right' : 'side-left';
    // 上下：指针在上半张（敌方区）→ 预览**下移**；在下半张（我方区）→ **上移**
    //       —— 总是往没在指的那半边靠，不跟箭头抢地方（用户 2026-10-03）
    var shift = (ny < 0.5) ? 'shift-down' : 'shift-up';
    preview.className = 'on ' + side + ' ' + shift;
    preview.innerHTML =
      '<div class="hp-name">' + esc(c.name) + '</div>' +
      (c.mana ? '<div class="hp-cost">' + esc(c.mana) + ' 费</div>' : '') +
      ((c.atk || c.hp) ? '<div class="hp-stats">' +
        (c.atk ? '<span class="hp-atk">攻 ' + esc(c.atk) + '</span>' : '') +
        (c.hp ? '<span class="hp-hp">血 ' + esc(c.hp) + '</span>' : '') + '</div>' : '') +
      (c.info ? '<div class="hp-text">' + esc(c.info) + '</div>' : '');
  }

  function showPreview(cardEl, nx, ny) { renderPreview(readCard(cardEl), nx, ny); }

  function hidePreview() { if (preview) preview.classList.remove('on'); }

  /* ---- 悬停在**场上卡牌**上的预览（用户 2026-10-02） -------------------------
     和拖手牌共用同一个面板，差别只在数据来源：
       · 手牌：DOM 里有完整卡面（名字/费用/攻血/文案）→ readCard()
       · 场上：DOM 里**只剩攻血两个数字**（卡面在去卡图那一轮被清掉了），
         名字得靠我们自己在卡片上场时记下来 → stampName()
     只在**空闲**时出：拖拽与演出各有各的预览，不互相抢。 */
  var hoverUnit = null;

  /* 指针底下的场上卡 / 英雄。和 enemyTargetAt 同一套做法：**按矩形判定**，
     因为立体视角下 getBoundingClientRect 给的是投影后的矩形，而 elementFromPoint
     会被任何全屏图层挡掉。 */
  function hoverCardAt(clientX, clientY) {
    var list = d.querySelectorAll('.board .cardinplay, #opposinghero, #playerhero');
    for (var i = list.length - 1; i >= 0; i--) {
      var el = list[i];
      /* 退场克隆体不是真卡，别对着它出预览（同上，全线排查 2026-10-03） */
      if (el.classList && el.classList.contains('hs-fx-ghost')) continue;
      if (!el.getClientRects().length) continue;
      var b = el.getBoundingClientRect();
      if (clientX >= b.left && clientX <= b.right && clientY >= b.top && clientY <= b.bottom) return el;
    }
    return null;
  }

  function numOf(x) {
    return x ? String(x.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function unitCardInfo(el) {
    if (!el) return null;
    var hero = (el.id === 'opposinghero' || el.id === 'playerhero');
    /* 名字的兜底来源里原来读过 `#opponentlabel` / `#playerlabel` —— 那两个元素已删除，
       英雄框的显示名改由关卡数据直接写进 DOM（见 卡库.js 乙段的 写('.opposingHeroHealth') 一族）。 */
    return {
      name: el.__hsName ||
            (el.classList.contains('computer-cardinplay') ? '对方单位' : '我方单位'),
      mana: '',
      atk: hero ? '' : numOf(el.children[0] && el.children[0].children[0]),
      hp: numOf(el.children[1] && el.children[1].children[0]),
      info: el.classList.contains('canAttack') ? '本回合可以攻击' : '',
    };
  }

  /* 渐变蒙版：压暗**没在指的那半张战场**。
     指针在上半张 → 蒙版盖下半张（从下往上渐隐到透明）；反之亦然。
     `pointer-events:none` 写死在 CSS 里 —— 蒙版只压暗、不吃鼠标，底下的目标照旧点得到。 */
  /* 渐变蒙版：压暗**没在指的那半张战场**。
     指针在上半张 → 蒙版盖下半张（从下往上渐隐到透明）；反之亦然。
     `ny` 是归一化屏幕位置（0–1），理由同 showPreview。
     `pointer-events:none` 写死在 CSS 里 —— 蒙版只压暗、不吃鼠标，底下的目标照旧点得到。 */
  function applyMask(ny) {
    if (!mask) return;
    var upper = ny < 0.5;                    // 分界就是屏幕中线
    var fade = 'rgba(4,7,12,0)';
    var dark = 'rgba(4,7,12,.88)';
    var mid = 'rgba(4,7,12,.62)';
    // 用百分比而不是 px —— 舞台高度是自适应的，写死数值会在矮屏上跑偏
    if (upper) {
      // 指针在上 → 盖下半
      mask.style.top = '42%';
      mask.style.height = '58%';
      mask.style.background = 'linear-gradient(to top, ' + dark + ' 0%, ' + mid + ' 55%, ' + fade + ' 100%)';
    } else {
      // 指针在下 → 盖上半
      mask.style.top = '0';
      mask.style.height = '58%';
      mask.style.background = 'linear-gradient(to bottom, ' + dark + ' 0%, ' + mid + ' 55%, ' + fade + ' 100%)';
    }
    mask.classList.add('on');
  }

  function hideMask() { if (mask) mask.classList.remove('on'); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ================= ⑤ 手牌出牌：我们全包（含落格与结算） ================= */

  /* 出一张手牌 —— **落场我们自己做**（2026-10-05 用户指令：移除上游）。
     上一版是「置 `W.collision = true` → 调上游 `placeCardFunc()` → 无条件 `cardEl.remove()`」。
     这条在沙盒里是坏的：平台把脚本包进 `(function(){…}).call(window)`，上游顶层
     `var collision` 只是 window 上的**副本** —— 我们写的值到不了它读的那个变量，
     `if(collision == true)` 恒假、**落场根本没发生**，而手牌照样被收走。
     现在的口径（用户定的三条）：**先落场 → 复核扣费与落场都成功 → 才收手牌；
     失败就把手牌留下、把刚落的撤掉、把法力还回去，并说出原因。** */
  function playFromHand(cardEl, slotIndex) {
    var c = readCard(cardEl);
    if (!c) return false;
    if (slotIndex < 0 || slotIndex >= SLOT_COUNT) return false;
    if (slots.player[slotIndex]) {                                   // 这一格有人了
      /* 静默失败是**用户反复报过**的毛病（拖过去没反应）。第一关双方各只有 1 格，
         这张牌放不下是常态，所以必须说一声 —— 文案走 文案.js（码 BOARD_FULL）。 */
      提示码('BOARD_FULL', { 后缀: SLOT_COUNT < 5 ? '（本关双方各只有 ' + SLOT_COUNT + ' 格）' : '' });
      return false;
    }
    var cost = Number(c.mana);
    /* ★★ 法力只有一个来源：**资源层**（`HS_RESOURCE`），不是上游的 `W.mana`。
       2026-10-05 实机反馈："有两点费用显示没有费用" —— tooltip 说"你只有 0 点"，
       而任务面板写"法力上限 1/10（法力 1）"、水晶又画着 2 颗：**三处读数互不相同**。
       根因就是这一行原来读 `W.mana`（上游那个全局变量，在沙盒里可能停在 0 / 没人回写），
       而玩家看到的数与资源层用的是另一个数 —— 于是**每一张牌都被判成"法力不够"**，
       表现就是"手牌打出去不进场上"（第 2 条与第 3 条其实是同一个根因）。
       这里改成：**优先问资源层**，资源层不在（独立网页早期/单测）才退回 `W.mana`。
       这也是"引擎统一维护状态、界面只负责展示"的第一步 —— 判定与显示从此读同一个数。 */
    var 有法力 = (W.HS_RESOURCE && typeof W.HS_RESOURCE.法力 === 'function')
      ? Number(W.HS_RESOURCE.法力()) : Number(W.mana);
    if (!(有法力 >= cost)) {                                         // 出不起
      提示码('INSUFFICIENT_MANA', { 卡: c.name, 需: cost, 有: 有法力 });
      return false;
    }

    // ⚠ `originalDeck` 是 index.js 里的 **`let`** —— 它不在 window 上，只能按标识符取
    //   （deckRef 就是干这个的）。写 `W.originalDeck` 会静默拿到 undefined，
    //   而 `typeof undefined === 'undefined'` 又会把这一整段判成「拿不到牌组」直接放弃 ——
    //   出牌于是**静默不生效**。这个坑我踩了两次，所以这里只留 deckRef 一个入口。
    var deckCards = deckRef('originalDeck');
    if (!deckCards) {
      报(1, 'META_INCOMPLETE', { 卡: c.name, 环节: '取不到 originalDeck' }, '严重');
      提示码('META_INCOMPLETE', { 卡: c.name });
      return false;
    }
    var 卡对象 = null;
    for (var i = 0; i < deckCards.length; i++) {
      if (deckCards[i]['name'] === c.name) { 卡对象 = deckCards[i]; break; }
    }
    if (!卡对象) {
      /* 意图层的"元信息不全"：这张牌在牌库里找不到 —— 以前只 console.error（没人看得到） */
      报(1, 'META_INCOMPLETE', { 卡: c.name, 牌库: deckCards.length }, '严重');
      提示码('META_INCOMPLETE', { 卡: c.name });
      return false;
    }

    /* ★★ 落场：**我们自己 append**，不再借上游的 placeCardFunc（见函数头那段）。
       顺序照上游：扣费 → append 卡面 → 报卡名 → `cardPlaceSnds()` 执行战吼；落完**复核**。 */
    var board = boardOf('player');
    if (!board) { 提示码('BOARD_FULL_DEPLOY', { 方: '我方' }); return false; }
    var 前子数 = board.childElementCount;
    var 前法力 = 有法力;
    var 落下的 = null;
    var 出错 = '';
    try {
      /* ① 扣费 —— 只有资源层那个数说了算（它是法力唯一的事实源） */
      if (W.HS_RESOURCE && typeof W.HS_RESOURCE.花 === 'function') {
        if (!W.HS_RESOURCE.花(cost, c.name)) {
          提示码('INSUFFICIENT_MANA', { 卡: c.name, 需: cost, 有: 前法力 });
          return false;
        }
      } else {
        W.mana = 前法力 - cost;               // 没资源层时退回全局量（独立网页早期 / 单测）
      }
      /* ② 造卡面并落场：用我们自己的工厂（卡库.js 丁段），与敌方那条路同一套 */
      落下的 = (W.HS_CARD && typeof W.HS_CARD.造场上卡 === 'function')
        ? W.HS_CARD.造场上卡(c.name, 'player')
        : (typeof 卡对象.getPlayerHTML === 'function' ? 卡对象.getPlayerHTML() : null);
      if (!落下的) throw new Error('造不出卡面节点');
      pendingSlot = slotIndex;                 // syncSlots 会把它放进这一格
      board.appendChild(落下的);
      /* ③ 战吼：执行器挂在 `cardPlaceSnds`（界面层自己那份），它靠 getNameOfElement 认卡 */
      W.getNameOfElement = c.name;
      try { if (typeof W.cardPlaceSnds === 'function') W.cardPlaceSnds(); }
      catch (err) { 出错 = '战吼执行出错：' + ((err && err.message) || err); }
    } catch (err) {
      出错 = (err && err.message) || String(err);
    }
    /* ④ 复核：**棋盘真的多了一张**、**法力真的扣掉了** —— 两条都成立才算成功 */
    var 现在法力 = (W.HS_RESOURCE && typeof W.HS_RESOURCE.法力 === 'function')
      ? Number(W.HS_RESOURCE.法力()) : Number(W.mana);
    var 落场成功 = !!落下的 && board.childElementCount === 前子数 + 1
      && (前法力 - 现在法力) === cost;
    if (!落场成功) {
      /* 失败：撤掉刚落的、把法力还回去，**手牌留在手上**，并把原因说出来。
         这一段就是这次改动的重点 —— 以前"不管成没成都收手牌"，于是牌没了、场上也没有。 */
      try { if (落下的 && 落下的.parentNode) 落下的.parentNode.removeChild(落下的); } catch (e) {}
      try {
        if (W.HS_RESOURCE && typeof W.HS_RESOURCE.设法力 === 'function') W.HS_RESOURCE.设法力(前法力);
        else W.mana = 前法力;
      } catch (e) {}
      pendingSlot = -1;
      报(1, 'DEPLOY_FAILED', { 卡: c.name, 原因: 出错 || '落场没生效', 子数: 前子数, 法力: 现在法力 }, '严重');
      提示码('DEPLOY_FAILED', { 卡: c.name, 原因: 出错 || '落场没生效' });
      return false;
    }
    cardEl.remove();                         // ★ 确认成功了，才收走手牌那一张
    /* B2：玩家上场也要有叙述（和敌方那条同构：从英雄指向落点 + 卡片浮现）。
       ⚠ 落点必须是**格子**，不是"棋盘最后一个子节点" —— 上一版就是这么写的，结果：
         `placeCardFunc` 刚 append、`syncSlots` 还没落格，那一刻量到的位置是棋盘的左缘，
         于是"拖到第 2 格"的箭头指向了第 1 格、"第 4 格"指向了第 2 格。
       格子（`.hs-slot`）的位置永远是对的，语义上也正是"上场到那一格"。 */
    try {
      syncSlots();                                                   // 先落格，再量
      var rowEl = d.getElementById('hs-slots-player');
      var slotEl = rowEl && rowEl.children[slotIndex];
      if (slotEl && W.HS_PIPELINE && W.HS_PIPELINE.present) {
        W.HS_PIPELINE.present({
          verb: 'deploy', from: d.getElementById('playerhero'), to: slotEl, toKind: 'slot', label: '上场',
        });
      }
    } catch (err) {
      /* ⚠ 不许静默：这一条我上一版就是"catch 里什么都不做"，
         结果探针只看到"没有日志"，查不出为什么。凡是 catch，至少留一行。 */
      if (W.console && W.console.error) W.console.error('[上场叙述] 失败：', err);
    }
    /* ★ 召唤类卡牌的效果要**优先于玩家的操作**结算（用户 2026-10-03）。
       上游是"先把卡 append 进 DOM、再在 setTimeout 里算效果"，所以玩家可以在效果结算前
       继续操作（比如把剩下格子填满 → 被召唤出来的单位就没地方了）。
       这里在出牌后短暂锁住输入，让上游那批定时器把效果跑完再放行。
       （满员检索另有一道硬闸，见 assignNew —— 两道都要：锁只是把窗口关小，闸是保底。） */
    try {
      if (W.HS_PIPELINE && W.HS_PIPELINE.lock) {
        W.HS_PIPELINE.lock('SUMMON');
        W.setTimeout(function () { try { W.HS_PIPELINE.unlock('SUMMON'); } catch (err) {} }, 800);
      }
    } catch (err) { /* 锁不上也不能挡住出牌 */ }
    return true;
  }

  /* =========================== ⑥ ⑦ 拖拽状态机 =========================== */

  var state = 'idle';        // idle | aiming
  var srcKind = null;        // 'hand' | 'unit'
  var srcEl = null;
  var handOrigin = null;     // 手牌原位置（**视口坐标**）—— 箭头起点
  var hoverTarget = null;

  var ENEMY_TARGETS = '.computer-cardinplay, #opposinghero';
  var KEEP = '.cardinplay, #playerhero, #opposinghero, .cards, button, ' +
             '#manacontainer, #campaign-overlay, #campaign-afterwin';

  /* 指针底下是哪个敌方目标。
     ⚠ **不能只靠 `elementFromPoint`**：它只认最上面那一个元素，页面上只要有任意一层
     全屏覆盖（上游的载入层 `#load` 就是 —— 全屏、z-index 1000000、pointer-events:auto），
     它就会永远返回那一层，于是**所有**敌方目标都高亮不上（用户 2026-10-02 报的就是这个：
     攻击敌方英雄时没有高亮）。
     所以这里先按**候选目标自己的矩形**做几何命中 —— 与"谁盖在上面"完全无关；
     只有几何上都没命中时，才退回 elementFromPoint 兜底（覆盖将来可能加进来的间接命中）。 */
  function enemyTargetAt(clientX, clientY) {
    var list = d.querySelectorAll(ENEMY_TARGETS);
    for (var i = list.length - 1; i >= 0; i--) {
      var el = list[i];
      if (!el.getClientRects().length) continue;        // 不在布局里（已下场 / 被隐藏）
      var b = el.getBoundingClientRect();
      if (clientX >= b.left && clientX <= b.right && clientY >= b.top && clientY <= b.bottom) return el;
    }
    var hit = d.elementFromPoint(clientX, clientY);
    return (hit && hit.closest) ? hit.closest(ENEMY_TARGETS) : null;
  }

  function clearHover() {
    if (hoverTarget && hoverTarget.classList) hoverTarget.classList.remove('hs-target-hover');
    hoverTarget = null;
  }

  /* ============== ★ 桥上"上游那个攻击处理器"（用户 2026-10-03 报的两个症状）==============
     上游 attack.js 的 `attack()` 做两件事：
       ① 给场上卡加 `canAttack` 绿光
       ② `document.querySelectorAll('.cardinplay').forEach(e => e.addEventListener('mousedown', …))`
     ② 是**一次性绑定**：只对"它跑的那一刻已经在场上的卡"生效。

     我们的包装（wrapAttackBinding）为了避免"3 点攻击打出 4 点伤害"（重复绑定 → 同一个 mousedown
     被同一个处理器处理多次），让上游那段绑定体**只跑一次** —— 副作用是：
     **之后上场的每一张卡都没有那个处理器**。于是：
       · **指定攻击目标时看不到那条红色虚线箭头**（上游的处理器负责 `svg.style.display='block'`
         并注册跟着鼠标更新 `svgpath` 的那个 body mousemove）→ 用户报的「一」
       · 打敌方**英雄**有效（`#opposinghero` 是静态元素，第一次绑定时就在），
         打敌方**随从**完全无效（那些卡是后造的，我们补发的 mousedown 没人接）→ 用户报的「二」

     修法（一个字都不改上游）：装载期把 `EventTarget.prototype.addEventListener` 包一层，
     抓住第一次绑到场上卡上的那个 mousedown 处理器 —— 它对所有卡是**同一套逻辑**、身份完全靠
     `this` 判（`this.classList` / `this.id`），所以任意抓到的一个都能代表全部。
     之后每张新卡上场（syncSlots 是唯一入口）就把同一个处理器补绑上去；绑过的打标记，不重复绑。
     这与 strip.js 换掉 `window.Audio`、包一层 `freshDeck` 是同一个套路：**改能力，不改调用点**。 */


  /* 幂等补绑：给一张场上卡接上上游那个处理器。
     ⚠ 2026-10-03 第三轮之后，**我们自己的攻击结算已经完全不用它了**（见 应用一次攻击）：
       攻击不再补发合成 mousedown、也不再依赖 `currentAttacker`。这条桥接保留下来只为
       "上游自己的流程"（它那套给场上卡加 canAttack 绿光的 `attack()`，以及被隐藏的英雄技能那条路）。
       所以这里绑的是**原样的上游处理器** —— 之前那层"把目标攻击力临时按成 0 再还原"的补正已删
       （那是给上游的无条件反击打补丁；规则现在由我们实现，不再需要在别人的数值上动手脚）。 */

  /* （这里原来有一段"补正层"：`包我的一次攻击` —— 它在调用上游之前把目标的攻击力临时按成 0、
     调用之后再还原，用来抵消上游那套无条件反击。2026-10-03 第三轮**攻击结算收回自己手里**之后
     整段删掉了：规则由 `应用一次攻击()` 实现，不必再在别人的数值上动手脚。
     那两个由此而来的坑（上游抛错时"假 0"留在卡上、`currentAttacker` 被残留）也随之消失。） */


  /* ==================== ★ 体力徽章（用户 2026-10-03 的新战斗机制）====================
     血量**上方**一个红色的 `-x`：执行攻击时要**消耗**的生命值。
     血量**下方**一个绿色的 `+x`：本回合**没攻击**、回合结束时可以**恢复**的生命值。
     两个都**溢出卡框**（用户："可以溢出单位的虚线框，就像护盾那样跟随着卡牌但是不在虚线框体内"），
     位置与样式在 游戏/样式.css 的「体力徽章」那一段。

     数值从 `HS_CARDS`（卡库.js 丙段的效果表）取 —— **和引擎读的是同一张表**，
     所以界面上显示的 -x/+x 跟规则里真正扣的血永远是同一个数，不会两处不一致。

     挂在卡片的**第 3、4 个子节点**上：上游是按 `children[0]`（攻）`children[1]`（血）
     `children[2]`（护盾占位）读数的，往后追加不影响它。 */
  function 挂体力徽章(el) {
    if (!el || !W.HS_CARDS) return false;
    /* ★ 血上限**在场那一刻**记一次（那时它一定是满血）：回合结束回复要用它来封顶。
       只记一次，之后被打掉血也不会覆盖。 */
    if (el.__hs血上限 === undefined) {
      var v = 读血(el);
      if (isFinite(v)) el.__hs血上限 = v;
    }
    var 定 = el.__hsName ? W.HS_CARDS[el.__hsName] : null;
    if (!定 || 定.攻耗 === undefined) return false;                 // 认不出是哪张卡就不挂（宁缺勿错）
    var 恢复值 = (定.恢复 === undefined) ? 定.攻耗 : 定.恢复;
    var 代价 = el.querySelector(':scope > .hs-cost');
    var 回复 = el.querySelector(':scope > .hs-rest');
    if (!代价) { 代价 = d.createElement('div'); 代价.className = 'hs-cost'; el.appendChild(代价); }
    if (!回复) { 回复 = d.createElement('div'); 回复.className = 'hs-rest'; el.appendChild(回复); }
    代价.textContent = '-' + 定.攻耗;
    回复.textContent = '+' + 恢复值;
    /* 顺手把规则要用的几个数**记在元素上**：施加攻击与回合结束回复都读这里，
       不必每次再去查表（也避免卡名认不出时反复查）。 */
    el.__hs攻耗 = 定.攻耗;
    el.__hs恢复 = 恢复值;
    el.__hs反击 = !!(定.关键词 && 定.关键词.反击);
    /* 这两个关键词以前没人实现（上游只把它们写在卡面文案里，全线排查 3.6）。
       攻击结算收回我们自己手里之后，就照引擎的口径一起实现：
         剧毒 = 被它伤到的随从直接销毁；伤害后冻结 = 被它伤到的角色冻结。 */
    el.__hs剧毒 = !!(定.关键词 && 定.关键词.剧毒);
    el.__hs伤害后冻结 = !!(定.关键词 && 定.关键词.伤害后冻结);
    return true;
  }

  function 挂全部体力徽章() {
    /* ⚠ 只给**棋盘里的单位**挂徽章：英雄框也带 `cardinplay` 类，收进来会给英雄多挂一个徽章。 */
    var list = d.querySelectorAll('.board .cardinplay');
    for (var i = 0; i < list.length; i++) 挂体力徽章(list[i]);
  }

  /* ==================== ★★ 一次攻击的施加（我们自己的，双方共用）====================
     用户 2026-10-03 第三轮：「不是说了要抛弃原上游代码的影响，全面使用我们自主的规划器吗」

     所以玩家打、敌方打**走同一个函数**，规则以**引擎**为准（`游戏/引擎.js` 的 `攻击结算`）：

       ① 攻方的攻击力打到目标身上（目标有神圣护盾 → 吸收一次、护盾破掉）
       ② 攻方的关键词在这一拍生效：**剧毒**（被它伤到的随从直接销毁）、
          **伤害后冻结**（被它伤到的角色冻结）
       ③ **默认没有反击**；目标带「反击」词条、且**挨完还活着**才还手
          （"打完还活着才反击"是正确写法 —— 反击是目标的**词条能力**，被打死就没机会发动）
       ④ 攻方付自己的 `攻耗`（体力），**付到 0 就死**；付过就不能在回合结束回血
       ⑤ 归零的单位移除（走我们自己的退场叙述）；英雄归零 → 判胜负

     这一版彻底不碰上游的攻击处理器，于是连带消掉了三个老坑：
       · 不再需要"补发合成 mousedown" → 不再依赖 `currentAttacker`（那个会被残留的全局量）
       · 不再需要"把目标攻击力临时按成 0 再还原"（那个 hack 一旦上游抛错就留下假 0）
       · 不再有"处理器只绑给当初在场的卡"这回事（那条路整个不用了） */
  function 读攻(el) {
    var a = el && el.children[0] && el.children[0].children[0];
    var v = a ? parseInt(String(a.textContent).trim(), 10) : NaN;
    return isFinite(v) ? v : 0;
  }

  function 应用一次攻击(攻方El, 目标El, kind) {
    if (!攻方El || !目标El) return null;

    /* ★★ 每回合攻击次数 —— **在结算层也守一道**（2026-10-05 用户规则）。
       用户在界面上受的那道闸是 `canAttack` 这个类（拖动的第一句就查它），
       但结算也可能被别的路径调到（演出管线替敌方补的那一拍、测试、将来的新入口）——
       规则不该只挂在 UI 上。所以到了真正结算这一步，**次数用尽就拒绝**：
       返回 null 表示"这一拍没打出去"，调用方照常往下走（不会改血量）。 */
    var 已打 = 攻方El.__hs本回合攻击次数 || 0;
    if (已打 >= 攻击上限(攻方El)) {
      报(2, 'MINION_CANT_ATTACK', { 攻方: 攻方El.__hsName || 攻方El.id, 次数: 已打 }, '提示');
      return null;
    }

    var 报告 = { 攻方: 攻方El.id, 目标: 目标El.id, kind: kind, 落地: false, 事件: [] };

    var 攻值 = 读攻(攻方El);
    var 是英雄目标 = (kind === 'player');
    var 目标血节点 = 是英雄目标 ? heroNode(目标El.id) : 血节点(目标El);
    var 攻血节点N = 血节点(攻方El);

    /* ── ① 伤害 ───────────────────────────────────────────────────── */
    var 吃了护盾 = false;
    if (!是英雄目标 && 目标El.classList && 目标El.classList.contains('hasDivineShield')) {
      目标El.classList.remove('hasDivineShield');                  // 护盾破掉（金环随之消失）
      try { if (W.HS_PIPELINE) W.HS_PIPELINE.anim.pop(目标El, '护盾', 'buff'); } catch (e) {}
      吃了护盾 = true;
      报告.事件.push('护盾抵消');
    } else if (目标血节点) {
      var 减值 = 攻值;
      /* ② 剧毒：被它伤到的随从直接销毁 —— 不是"扣一大截血"，是判定成 0（与引擎一致） */
      if (!是英雄目标 && 攻方El.__hs剧毒) 减值 = 9999;
      目标血节点.textContent = String((parseInt(String(目标血节点.textContent).trim(), 10) || 0) - 减值);
      try { 目标血节点.style.color = '#f20301'; } catch (e) {}
      报告.事件.push('伤害 ' + 攻值);
      /* ② 伤害后冻结：被打到的角色冻结 */
      if (攻方El.__hs伤害后冻结 && !是英雄目标) {
        目标El.__hs冻结 = true;
        目标El.classList.add('hs-frozen');                          // 角标在 样式.css 里
        报告.事件.push('冻结');
      }
    }

    /* ── ③ 反击（默认没有；要词条，还要活着）───────────────────────── */
    var 目标现在血 = 是英雄目标
      ? (目标血节点 ? (parseInt(String(目标血节点.textContent).trim(), 10) || 0) : 0)
      : 读血(目标El);
    var 反击伤 = 0;
    if (!是英雄目标 && 目标El.__hs反击 === true && !吃了护盾 && 目标现在血 > 0) {
      反击伤 = 读攻(目标El);
      var 攻方有盾 = 攻方El.classList && 攻方El.classList.contains('hasDivineShield');
      if (攻方有盾 && 反击伤 > 0) {
        攻方El.classList.remove('hasDivineShield');
        try { if (W.HS_PIPELINE) W.HS_PIPELINE.anim.pop(攻方El, '护盾', 'buff'); } catch (e) {}
        反击伤 = 0;
        报告.事件.push('反击被护盾吃掉');
      } else if (反击伤 > 0 && 攻血节点N) {
        攻血节点N.textContent = String((parseInt(String(攻血节点N.textContent).trim(), 10) || 0) - 反击伤);
        报告.事件.push('反击 ' + 反击伤);
      }
    }

    /* ── ④ 攻方付体力（红 -x 那个数）───────────────────────────────── */
    var 攻耗 = (攻方El.__hs攻耗 === undefined) ? 0 : 攻方El.__hs攻耗;
    if (攻耗 > 0 && 攻血节点N) {
      var 现值 = parseInt(String(攻血节点N.textContent).trim(), 10) || 0;
      攻血节点N.textContent = String(现值 - 攻耗);
      报告.事件.push('体力 -' + 攻耗);
    }
    攻方El.__hs攻击过 = true;                                        // 本回合攻击过 → 结束不回血

    /* ★★ 每回合攻击次数（2026-10-05 用户）：**没有特殊词条的卡每回合只能攻击一次**。
       原来唯一的闸门是 `canAttack` 这个类，而打完**没有任何地方把它摘掉**
       （全仓库搜不到一处 `remove('canAttack')`）—— 于是同一个单位能连着打好几次，
       用户报的正是这个。现在：打过就记数，到上限就摘掉 `canAttack` 与绿光；
       下一次拖动会被 `if (!unit.classList.contains('canAttack'))` 那道闸当场拒掉。
       计数在**该方回合开始**时清零（挂在 清攻击过标记 里，时机刚好）。 */
    try {
      var 次数 = (攻方El.__hs本回合攻击次数 || 0) + 1;
      攻方El.__hs本回合攻击次数 = 次数;
      var 上限次 = 攻击上限(攻方El);
      if (次数 >= 上限次) {
        攻方El.classList.remove('canAttack');
        攻方El.style.boxShadow = 'none';
        报告.事件.push('攻击次数用尽（' + 次数 + '/' + 上限次 + '）');
      } else {
        报告.事件.push('攻击次数 ' + 次数 + '/' + 上限次);
      }
    } catch (e5) { /* 计数失败不该挡住结算 */ }

    /* ── ⑤ 移除与胜负 ─────────────────────────────────────────────── */
    var 目标亡 = false;
    if (!是英雄目标) {
      目标亡 = 读血(目标El) <= 0;
      if (目标亡) {
        /* ★ 亡语在这一拍触发（阶段 D）：由**移除**驱动，所以"谁死了 → 谁的亡语"只有这一处判断。
           先把亡语跑完再 remove —— 亡语可能又召唤出东西（Sludge Belcher 的淤泥），
           那是新卡、与这一张的退场互不相干。 */
        try { 触发亡语(目标El); } catch (e) {}
        try { 目标El.remove(); } catch (e2) {}                      // 退场叙述由我们的旁听接手
      }
    }
    var 攻方亡 = !!(攻血节点N && 读血(攻方El) <= 0);
    if (攻方亡) {
      try { 触发亡语(攻方El); } catch (e3) {}
      try { 攻方El.remove(); } catch (e4) {}
    }

    if (是英雄目标) {
      var 英雄血 = 目标血节点 ? (parseInt(String(目标血节点.textContent).trim(), 10) || 0) : 1;
      if (英雄血 <= 0) {
        if (目标El.id === 'opposinghero') {
          try { if (typeof W.gameWon === 'function') W.gameWon(); } catch (e) {}
          报告.事件.push('胜利');
        } else {
          我方失败();
          报告.事件.push('失败');
        }
      }
    }

    try { syncSlots(); } catch (e) {}
    报告.落地 = true;
    /* ★ 提交点（改进 B）：一次攻击**结算完** → 局面定型 → 采权威、求差、revision + 1。
       放在这里而不是"演出播完"：结算就是真相落地的时刻；演出只是**展示**它（可以滞后）。 */
    try { 提交场面('攻击结算'); } catch (e) {}
    return 报告;
  }

  /* 我方失败（英雄血量归零）。
     上游那套是 `alert("You've Lost!") + location.reload()` —— 粗糙，而且卡里不该弹 alert。
     这里换成一条我们自己的小结算条（与关卡层"通关"那条对称）。为什么必须有：
     **结算收回自己手里之后，"血到 0" 不再是上游那套"弹窗+重载"，不补上就会一直跑下去。** */
  function 我方失败() {
    if (d.getElementById('hs-losebar')) return;
    var bar = d.createElement('div');
    bar.id = 'hs-losebar';
    var 字 = d.createElement('span');
    字.textContent = '你输了';
    bar.appendChild(字);
    var 再 = d.createElement('button');
    再.className = 'campaign-btn';
    再.textContent = '重打本关';
    再.onclick = function () { W.location.href = W.location.pathname + W.location.search; };
    bar.appendChild(再);
    var 回 = d.createElement('button');
    回.className = 'campaign-btn ghost';
    回.textContent = '关卡列表';
    回.onclick = function () { W.location.href = W.location.pathname; };
    bar.appendChild(回);
    ((W.HS_UI_宿主 && W.HS_UI_宿主()) || d.body).appendChild(bar);
  }

  /* ==================== ★★ 卡的效果（阶段 D：把 `card_effects.js` 拿回来）====================
     上游那 326 行是一个"按卡名 if-else"的大函数 `cardPlaceSnds()`，由 `index.js` 的
     `placeCardFunc` 在**牌落场之后**调一次，靠全局量 `getNameOfElement` 知道刚打的是哪张卡。
     它的三个问题：
       ① 效果是**写死的 DOM 操作**，加一张卡就要改代码（`card_effects.js` 正是"直接改 DOM"的反面教材）；
       ② **一堆分支其实只播了个音效** —— Elven Archer / Voodoo Doctor / Glacial Shard 这些
          "要选目标"的战吼，上游根本没实现真效果；
       ③ 与我们的引擎**口径不同**（Stormwind Champion 上游是"其他随从全体 +1/+1"，
          我们的效果表写的是"一个友方随从"）。

     这一版：**读同一张效果表**（`卡库.js` 丙段的 `战吼`/`亡语`），用通用执行器落到 DOM 上，
     词汇与引擎（`游戏/引擎.js`）一模一样：伤害 / 治疗 / 加成 / 召唤 / 抽牌 / 冻结 / 消灭。
     接法照老规矩「**改能力，不改调用点**」：把 `cardPlaceSnds` 换成我们自己的实现 ——
     `index.js` 那句 `cardPlaceSnds();` 一个字不动。

     **要选目标**的效果走「待选目标」模式：牌落场后进入选目标态（合法目标描边 + 提示），
     点一个才生效；Esc / 右键 = 落空。这与引擎里的 `待选择` 是同一个模型 ——
     **引擎/界面都不替玩家猜目标**。 */
  var 待选 = null;                     // {卡名, 效果, 席位, 可选:[元素], 来源}

  function 效果定(卡名) { return (W.HS_CARDS || {})[卡名] || null; }

  /* 目标口径 → 这一刻能选哪些**元素**（与引擎 可选目标() 的口径一一对应） */
  function 效果可选(席位, 口径) {
    var 敌 = (席位 === 'player') ? 'enemy' : 'player';
    var 我的 = boardOf(席位) ? Array.prototype.slice.call(boardOf(席位).querySelectorAll('.cardinplay')) : [];
    var 敌的 = boardOf(敌) ? Array.prototype.slice.call(boardOf(敌).querySelectorAll('.cardinplay')) : [];
    function 净(a) { return a.filter(function (e) { return !e.classList.contains('hs-fx-ghost'); }); }
    我的 = 净(我的); 敌的 = 净(敌的);
    var 我英 = d.getElementById(席位 === 'player' ? 'playerhero' : 'opposinghero');
    var 敌英 = d.getElementById(敌 === 'player' ? 'playerhero' : 'opposinghero');
    if (口径 === '无' || !口径) return [];
    if (口径 === '自身') return 来源单位 ? [来源单位] : [];   // 由调用处补
    if (口径 === '自身英雄') return 我英 ? [我英] : [];
    if (口径 === '任意') return 我的.concat(敌的, 我英 ? [我英] : [], 敌英 ? [敌英] : []);
    if (口径 === '任意随从') return 我的.concat(敌的);
    if (口径 === '友方随从' || 口径 === '自身随从') return 我的;
    if (口径 === '敌方随从') return 敌的;
    if (口径 === '敌方嘲讽随从') return 敌的.filter(function (e) { return e.classList.contains('hasTaunt'); });
    if (口径 === '敌方英雄') return 敌英 ? [敌英] : [];
    if (口径 === '敌方角色') return 敌的.concat(敌英 ? [敌英] : []);
    return [];
  }
  var 来源单位 = null;                 // 正在执行效果的那张卡（'自身' 口径要用）

  function 是英雄(el) { return !!el && (el.id === 'playerhero' || el.id === 'opposinghero'); }
  function 元素席位(el) {
    if (el.id === 'playerhero') return 'player';
    if (el.id === 'opposinghero') return 'enemy';
    return (boardOf('player') && boardOf('player').contains(el)) ? 'player' : 'enemy';
  }

  /* 一条效果落到 DOM 上（与引擎 执行效果() 同一套词汇） */
  function 执行效果(效果, 席位, 目标El) {
    if (!效果) return;
    if (效果.动作 === '伤害' || 效果.动作 === '治疗') {
      var 值 = 效果.值 || 0;
      if (是英雄(目标El)) {
        var h = heroNode(目标El.id);
        if (!h) return;
        var 现 = parseInt(String(h.textContent).trim(), 10) || 0;
        var 新 = (效果.动作 === '伤害') ? 现 - 值 : Math.min(现 + 值, 30);
        h.textContent = String(新);
        飘字(目标El, (效果.动作 === '伤害' ? '-' : '+') + 值, 效果.动作 === '伤害' ? 'damage' : 'heal');
      } else {
        var n = 血节点(目标El);
        if (!n) return;
        var 血 = parseInt(String(n.textContent).trim(), 10) || 0;
        var 后 = (效果.动作 === '伤害') ? 血 - 值 : 血 + 值;
        n.textContent = String(后);
        飘字(目标El, (效果.动作 === '伤害' ? '-' : '+') + 值, 效果.动作 === '伤害' ? 'damage' : 'heal');
        if (后 <= 0) { try { 目标El.remove(); } catch (e) {} try { syncSlots(); } catch (e2) {} }
      }
      return;
    }
    if (效果.动作 === '加成') {
      if (是英雄(目标El)) return;
      var a = 目标El.children[0] && 目标El.children[0].children[0];
      var b = 血节点(目标El);
      if (a && 效果.攻) a.textContent = String((parseInt(String(a.textContent).trim(), 10) || 0) + 效果.攻);
      if (b && 效果.血) b.textContent = String((parseInt(String(b.textContent).trim(), 10) || 0) + 效果.血);
      飘字(目标El, (效果.攻 ? '+' + 效果.攻 + '/' : '') + (效果.血 ? '+' + 效果.血 : ''), 'buff');
      return;
    }
    if (效果.动作 === '冻结') {
      if (是英雄(目标El)) return;
      目标El.__hs冻结 = true;
      目标El.classList.add('hs-frozen');
      飘字(目标El, '冻结', 'debuff');
      return;
    }
    if (效果.动作 === '消灭') {
      if (是英雄(目标El)) return;
      飘字(目标El, '消灭', 'debuff');
      try { 目标El.remove(); } catch (e) {}
      try { syncSlots(); } catch (e2) {}
      return;
    }
    if (效果.动作 === '召唤') {
      for (var i = 0; i < (效果.数量 || 1); i++) 召唤随从(效果.卡, 席位);
      return;
    }
    if (效果.动作 === '抽牌') {
      for (var j = 0; j < (效果.数量 || 1); j++) 抽一张(席位);
      return;
    }
    // 表里写了但我们还没实现的动作 → **不许静默**（写进控制台 + 记在自检里）
    try { if (W.console && W.console.warn) W.console.warn('[效果] 还没有实现这个动作：' + 效果.动作); } catch (e3) {}
  }

  function 飘字(el, label, kind) {
    try { if (W.HS_PIPELINE && W.HS_PIPELINE.anim && W.HS_PIPELINE.anim.pop) W.HS_PIPELINE.anim.pop(el, label, kind); } catch (e) {}
  }

  /* 自己造一张随从落场（战吼召唤 / 亡语召唤都用它；与敌方出牌那条路同一套：落格 + 徽章 + 观察器） */
  function 召唤随从(卡名, 席位) {
    var board = boardOf(席位);
    if (!board) return null;
    var 现 = board.querySelectorAll('.cardinplay:not(.hs-fx-ghost)').length;
    if (现 >= SLOT_COUNT) {
      notice(席位 === 'player' ? '我方战场已满' : '敌方战场已满');
      return null;
    }
    if (!W.HS_CARD || !W.HS_CARD.造场上卡) return null;
    var el = W.HS_CARD.造场上卡(卡名, 席位);
    el.__hsName = 卡名;
    board.appendChild(el);
    syncSlots();               // 落格（顺带把体力徽章挂上）
    飘字(el, 卡名, 'buff');
    return el;
  }

  /* 抽一张。玩家侧走上游那份牌库（阶段 C 之前它还是牌库的真相）；敌方侧走我们自己的 enemyHand。 */
  function 抽一张(席位) {
    if (席位 === 'player') {
      var hand = d.getElementById('cards');
      var deck = (typeof playerDeck !== 'undefined') ? playerDeck : null;
      if (!hand || !deck || !deck.cards || !deck.cards.length) return null;
      if (hand.childElementCount >= 手牌上限) return null;
      var el = deck.cards.shift().getPlayerCardsInHandHTML();
      hand.appendChild(el);
      排手牌();
      飘字(el, '抽牌', 'heal');
      return el;
    }
    try { drawForEnemy(1); } catch (e) { return null; }
    return null;
  }

  /* 机器人替自己选目标（**只有非玩家席位走这里**）。
     ⚠ 这一条是补一个我自己捅的漏：早先"要选目标"的效果**对敌方也挂到玩家面前**，
     而第一关敌方牌组里就有 Elven Archer / Voodoo Doctor 这种要选目标的卡 ——
     它一出牌，**玩家的界面就被"等你选目标"卡住**：点手牌出牌被当成"点了非法目标"（按不出卡），
     每点一次还弹一次提示（疯狂提示）。所以：**谁的效果谁选** —— 敌方由 bot 挑，不打扰玩家。
     策略很简单、但与"效果是帮谁"一致：伤害/消灭/冻结砸对面，治疗/加成给自己人。 */
  /* 老的 `机器人选目标()` 已删除（架构改进 D）：它的策略搬进了 `游戏/决策.js` 的
     `选目标(席位, 效, 目标描述符)` —— **纯函数，能在 node 里直接测**，
     由 `机器人决定()` 负责把 DOM 选项翻译成描述符再取回元素。
     留着它就是"两处各知道一半规则"，正是 D 要消灭的东西。 */

  /* ★★ 决策的唯一出口（架构改进 D）。照那份流程图：
       需要选择时发 `DecisionRequest{ 谁选, 选项, 上下文 }` →
         · 玩家 → 界面高亮合法选项、等点击（DecisionResponse）
         · Bot  → 评分挑一个，直接从返回值给出
     为什么必须收成一处：以前"谁该选"写在 应用战吼 里、"Bot 怎么选"写在 机器人选目标 里、
     "玩家怎么选"写在 待选点击 里 —— 三处各知道一半规则，于是出过"敌方战吼问玩家选目标"
     （界面疯狂提示、玩家按不出卡）。现在只有这一处知道"谁选"。 */
  function 发起决策(请求) {
    if (!请求 || !请求.选项 || !请求.选项.length) return { 选择: null };
    if (请求.谁 === 'player') { 进入待选(请求); return { 待定: true }; }
    return { 选择: 机器人决定(请求) };
  }

  /* Bot 的那一半：只把"选项"翻译成描述符交给 决策.js（纯逻辑、可在 node 里测），
     再按下标取回元素。决策层没装上时退化成"取第一个" —— 绝不让战吼凭空落空。 */
  function 机器人决定(请求) {
    var 选项 = 请求.选项;
    var 决策 = W.HS_DECIDE;
    if (决策 && typeof 决策.选目标 === 'function') {
      var 描述 = [];
      for (var i = 0; i < 选项.length; i++) {
        var el = 选项[i];
        描述.push({ i: i, 席位: 元素席位(el), 攻: 读攻(el), 血量: 读血(el), 英雄: 是英雄(el) });
      }
      var 选 = 决策.选目标(请求.席位, 请求.效果, 描述);
      if (选 >= 0 && 选 < 选项.length) return 选项[选];
    }
    return 选项[0];
  }

  /* 把一张卡的战吼执行掉：能定目标的立刻执行；**该谁选就问谁**（见 发起决策）。
     `来源` 是那张刚落场的卡（'自身' 口径要用）。 */
  function 应用战吼(卡名, 席位, 来源) {
    var 定 = 效果定(卡名);
    if (!定 || !定.战吼 || !定.战吼.length) return false;
    来源单位 = 来源 || null;
    for (var i = 0; i < 定.战吼.length; i++) {
      var 效 = 定.战吼[i];
      if (!需目标(效)) { 执行效果(效, 席位, null); continue; }
      var 可选 = 效果可选(席位, 效.目标);
      if (!可选.length) {
        /* 没有合法目标 → 这条落空（引擎里也是"当时就没有合法目标"→ 落空） */
        try { if (W.console && W.console.info) W.console.info('[效果] ' + 卡名 + ' 的这条战吼没有合法目标，落空'); } catch (e) {}
        continue;
      }
      if (可选.length === 1) { 执行效果(效, 席位, 可选[0]); continue; }   // 只有一个合法解 = 不是"猜"
      var 决 = 发起决策({
        谁: (席位 === 'player') ? 'player' : 'bot',      // ★ 角色由席位决定，只在这里判一次
        种类: '战吼目标', 席位: 席位, 效果: 效, 选项: 可选, 上下文: { 卡名: 卡名 }
      });
      if (决.待定) return true;                          // 玩家侧：进待选，等他的 DecisionResponse
      执行效果(效, 席位, 决.选择);
    }
    return false;
  }

  function 需目标(效) {
    if (!效 || !效.动作) return false;
    if (效.动作 === '召唤' || 效.动作 === '抽牌') return false;
    return !(效.目标 === undefined || 效.目标 === '无');
  }

  /* 待选目标态的**常驻提示条**（不锁输入）。
     ⚠ 为什么不用 `notice()`：它走的是演出管线（`present`），而**演出期间输入是被锁住的** ——
     于是"进待选 → 飘一条提示 → 接下来约 1 秒里玩家点手牌会被静默吞掉"（用户报的"按不出卡"，
     这是**第二个**原因）。而且提示每点一次就来一条，看着就是"疯狂提示目标（ESC）"。
     所以待选改用这个**不动管线、不锁输入、一直挂着**的小条：玩家想选就选、想干别的就干别的。 */
  function 提示条(文字) {
    var el = d.getElementById('hs-pick');
    if (!文字) { if (el) el.classList.remove('on'); return; }
    if (!el) {
      el = d.createElement('div');
      el.id = 'hs-pick';
      /* ★ 挂到**本作品的根节点**（沙盒是 `#hs-sandbox-root`，独立网页才落 body）——
         理由与 演出.js 的 `覆盖宿主()` 那段一致：挂 body 的覆盖层会被"舞台根 + `#game` 的不透明底色"
         盖在下面，元素在、样式对，玩家却看不见。 */
      var 宿主 = null;
      try { if (W.HS_UI_根 && typeof W.HS_UI_根 === 'function') 宿主 = W.HS_UI_根(); } catch (e) {}
      (宿主 || d.body).appendChild(el);
    }
    el.textContent = 文字;
    el.classList.add('on');
  }

  /* 检错层的本地别名（全链路检错）：各层都通过它上报，**只有这一处知道"报给谁"**。
     检错层没装上时降级成 console.warn —— 绝不静默（静默正是本会话反复踩的坑）。 */
  function 报(层, 码, 上下文, 严重) {
    if (W.HS_CHECK && typeof W.HS_CHECK.报 === 'function') return W.HS_CHECK.报(层, 码, 上下文, 严重);
    try { if (W.console && W.console.warn) W.console.warn('[检错降级] 层' + 层 + ' · ' + 码, 上下文 || ''); } catch (e) {}
  }

  /* ★ 拒绝提示的**唯一出口**（2026-10-04，架构改进 A：拒绝结构化）。
     口径：**码 + 上下文** → 中文模板（模板只在 游戏/文案.js 里维护）→ 显示。
     为什么不再各处拼中文：拼出来的字符串**会变**，日志/回放/本地化都拿不到稳定的东西；
     而且"哪个提示对应哪种拒绝"散在几十处，改口径就得满仓库找（这正是本会话反复踩的坑之一）。 */
  function 提示码(码, 上下文) {
    var 文 = (W.HS_TEXT && typeof W.HS_TEXT.取 === 'function')
      ? W.HS_TEXT.取(码, 上下文)
      : ('（' + 码 + '）');                 // 文案层没装上也不许静默：至少露出码
    闪提示(文);
    return 文;
  }

  /* 一闪而过的反馈 —— 用同一条"不锁输入"的提示条。
     为什么需要它：出牌被拒（这一格有人 / 法力不够）以前是**静默 return false**，
     玩家看到的就是"拖过去没反应"（B11 立的规矩：不许静默失败。第一关只有 1 格，
     这条特别要紧 —— 场上站着一个人就再也放不下第二个了，必须有话说）。
     为什么不用 `notice()`：它走演出管线、锁输入约 1 秒，那正是"按不出卡"的成因之一。 */
  var 闪提示计时 = 0;
  function 闪提示(文字) {
    提示条(文字);
    if (闪提示计时) W.clearTimeout(闪提示计时);
    闪提示计时 = W.setTimeout(function () {
      闪提示计时 = 0;
      if (!待选) 提示条('');            // 待选还挂着就别抢它的提示
    }, 1800);
  }

  /* 玩家侧的一半：把 DecisionRequest 呈现出来（高亮合法选项 + 提示），等他的 DecisionResponse。
     ⚠ 入参从"四个散装参数"改成**一个请求对象**（架构改进 D）—— 这样"请求长什么样"只有一处定义，
     Bot 侧（机器人决定）吃的是同一个形状。 */
  function 进入待选(请求) {
    待选 = { 请求: 请求, 卡名: 请求.上下文 && 请求.上下文.卡名, 效果: 请求.效果, 席位: 请求.席位, 可选: 请求.选项 };
    请求.选项.forEach(function (el) { el.classList.add('hs-target-hover'); });
    try { applyMask(请求.席位 === 'player' ? 0.1 : 0.9); } catch (e) {}
    提示条((待选.卡名 || '效果') + '：选一个' + (请求.效果.目标 === '任意' ? '目标' : 请求.效果.目标) + '　（Esc 取消）');
  }

  function 清待选() {
    if (!待选) return false;
    待选.可选.forEach(function (el) { el.classList.remove('hs-target-hover'); });
    待选 = null;
    提示条(null);
    try { hideMask(); } catch (e) {}
    return true;
  }

  /* 待选目标态下点一个目标。返回 true 表示这次点击被这个模式吃掉了。
     ⚠ 这里**不再对"点到非法处"弹提示** —— 早先是每点一次弹一次，玩家看见的就是"疯狂提示目标（ESC）"。
     现在只分三种：点中合法目标 → 生效；点在战场上但非法 → 什么都不做（继续等）；*/
  function 待选点击(cx, cy) {
    if (!待选) return false;
    var el = 指针下的角色(cx, cy);
    if (el && 待选.可选.indexOf(el) >= 0) {
      var 效 = 待选.效果, 席位 = 待选.席位;
      清待选();
      执行效果(效, 席位, el);
      return true;
    }
    /* 决策层：点了一个**角色但不在选项里** —— 这是"响应不合法"（DECISION_INVALID）。
       注意**只记录、不提示**：玩家点到非法目标是最常见的用户行为噪声，刷提示就成了
       "疯狂提示目标"（用户报过的那条）。写进诊断报告，出事时查得到。 */
    if (el) 报(3, 'DECISION_INVALID', { 可选: 待选.可选.length, 目标: (el.id || el.className || '') }, '提示');
    return true;                 // 等着（不弹提示、不取消）
  }

  /* 放弃当前待选（那条战吼落空）。任何"新的操作"都会走到这里 ——
     见 onDown：**玩游戏不该被一个选择卡住**。 */
  function 放弃待选(为什么) {
    if (!待选) return false;
    var 卡名 = 待选.卡名;
    清待选();
    提示条(卡名 + ' 的战吼落空（' + 为什么 + '）');
    W.setTimeout(function () { try { 提示条(null); } catch (e) {} }, 1400);
    return true;
  }

  /* 指针底下的"角色"：两排战场上的卡 + 两个英雄（与 应用一次攻击 用同一套取值口径） */
  function 指针下的角色(cx, cy) {
    var 候选 = d.querySelectorAll('.board .cardinplay, #playerhero, #opposinghero');
    for (var i = 候选.length - 1; i >= 0; i--) {
      var el = 候选[i];
      if (el.classList.contains('hs-fx-ghost') || !el.getClientRects().length) continue;
      var b = el.getBoundingClientRect();
      if (cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom) return el;
    }
    return null;
  }

  /* ⚠ 接法：**把 `cardPlaceSnds` 换成我们自己的**（`index.js` 那句调用一个字不动）。
     到 2026-10-03 这一轮，上游那份 326 行（`card_effects.js`）已经**不再加载**，
     所以这里不再要求"必须先有上游那个函数"—— 有就顺着调一下（保底），没有就直接装我们的。
     这条守卫原来写成 `typeof W.cardPlaceSnds !== 'function' → return false`，
     那会在摘掉 card_effects.js 的那一刻让出牌效果整个不装（自检 ㉗ 会当场红）。 */
  function 接管出牌效果() {
    if (W.cardPlaceSnds && W.cardPlaceSnds.__hsOurs) return true;      // 接过一次就不再接
    var 上游的 = (typeof W.cardPlaceSnds === 'function') ? W.cardPlaceSnds : null;
    var 我们 = function () {
      var 卡名 = W.getNameOfElement;                       // 上游的全局量：刚打出的那张卡
      if (上游的) { try { 上游的.apply(this, arguments); } catch (e) { /* 上游那份已退役，抛了无所谓 */ } }
      if (!卡名) return;
      var 席位 = 'player';
      var board = boardOf(席位);
      var 来源 = null;
      if (board) {
        var 全部 = board.querySelectorAll('.cardinplay:not(.hs-fx-ghost)');
        for (var i = 全部.length - 1; i >= 0; i--) { if (全部[i].__hsName === 卡名) { 来源 = 全部[i]; break; } }
        /* ⚠ 兜底：这一刻 `__hsName` 可能还没盖上 —— 落格与盖名由 MutationObserver 走**微任务**，
           而 `cardPlaceSnds()` 是 placeCardFunc 里同步调的。所以按上游自己的约定取"最后一张"
           （上游通篇就是 `playerCardSlot2.lastChild`）。 */
        if (!来源 && 全部.length) 来源 = 全部[全部.length - 1];
      }
      应用战吼(卡名, 席位, 来源);
    };
    我们.__hsOurs = true;
    W.cardPlaceSnds = 我们;
    return true;
  }
  接管出牌效果();

  /* 亡语：由**移除**触发。挂在 `应用一次攻击` 的移除那一拍上（那里是我们自己的结算），
     所以"谁死了 → 谁的亡语"只有一处判断。 */
  function 触发亡语(el) {
    if (!el || !el.__hsName) return;
    var 定 = 效果定(el.__hsName);
    if (!定 || !定.亡语 || !定.亡语.length) return;
    var 席位 = 元素席位(el);
    for (var i = 0; i < 定.亡语.length; i++) 执行效果(定.亡语[i], 席位, null);
  }


  /* 读一张场上卡的"血量数字节点"。上游的结构是 children[1].children[0]；
     某些卡（英雄/降级结构）children[1] 自己就是那个数字，所以两种都容一下。 */
  function 血节点(el) {
    var h = el && el.children && el.children[1];
    return h ? (h.children && h.children.length ? h.children[0] : h) : null;
  }
  function 读血(el) {
    var h = 血节点(el);
    if (!h) return NaN;
    return parseInt(String(h.textContent).trim(), 10);
  }

  /* ==================== ★ 回合结束回复 / 清"攻击过"（用户 2026-10-03）====================
     规则（引擎里权威，这里是老路径的落地）：
       · 某个席位**回合结束时**，它那些**本回合没攻击过**的随从回复 `恢复` 点血（最多回满）。
       · "本回合攻击过"这个标记在**它自己的下一个回合开始**时清掉。
     注意两点：① 只算"当回合主人"的随从（对面不在这时候回血）；
             ② 满血的、恢复为 0 的，什么都不做（不发演出，免得刷屏）。 */
  function 回合结束回复(席位) {
    var board = boardOf(席位);
    if (!board) return 0;
    var 回了 = 0;
    var list = board.querySelectorAll('.cardinplay');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.classList.contains('hs-fx-ghost')) continue;
      if (el.__hs攻击过) continue;                                  // 打过就不回
      if (el.__hs恢复 === undefined) continue;
      var 现 = 读血(el);
      if (!isFinite(现)) continue;
      var 上限 = (el.__hs血上限 === undefined) ? 现 : el.__hs血上限;   // 上限在卡片落场那一刻就记下了
      var 能回 = 上限 - 现;
      if (能回 <= 0 || !el.__hs恢复) continue;                       // 满血 / 恢复 0 → 什么都不做
      var 实际 = Math.min(能回, el.__hs恢复);
      var h = 血节点(el);
      h.textContent = String(现 + 实际);
      try { h.style.color = ''; } catch (err) {}
      回了 += 1;
      try {
        if (W.HS_PIPELINE && W.HS_PIPELINE.present) {
          W.HS_PIPELINE.present({ verb: 'heal', to: el, label: '+' + 实际 });
        }
      } catch (err) {}
    }
    return 回了;
  }

  /* 一张卡**每回合能攻击几次**（2026-10-05 用户规则）：
     **没有特殊词条的角色卡每回合只能打一次**；带 `风怒` / `多次攻击` 这类词条的放宽到 2。
     读的是卡库.js 丙段那张卡表（`HS_CARDS[卡名].关键词`），与引擎/预览读的是同一张表。 */
  function 攻击上限(el) {
    var 名 = el && el.__hsName;
    var 定 = (名 && W.HS_CARDS) ? W.HS_CARDS[名] : null;
    var kw = (定 && 定.关键词) || {};
    if (kw.风怒 || kw.多次攻击 || kw.windfury || kw.连续攻击) return 2;
    return 1;
  }

  function 清攻击过标记(席位) {
    var board = boardOf(席位);
    if (!board) return 0;
    var list = board.querySelectorAll('.cardinplay');
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].__hs攻击过) { list[i].__hs攻击过 = false; n += 1; }
      list[i].__hs本回合攻击次数 = 0;        // ★ 该方回合开始 → 攻击次数清零（见 攻击上限）
    }
    return n;
  }

  function backToIdle() {
    state = 'idle'; srcKind = null; srcEl = null; handOrigin = null;
    clearHover();
    hideRows(); hideArrow(); hidePreview(); hideMask();
    if (srcEl && srcEl.classList) srcEl.classList.remove('dragging');
  }

  /* 把上游那条"瞄准线"整层收掉：虚线本身、我们补的箭头尖、以及瞄准时被隐藏的光标。
     ⚠ 只收视觉，**不碰 `W.currentAttacker`** —— 那是攻击能不能结算的唯一依据，
       演出期间还必须留着（见 onClick 与 pipeline 里那两处说明）。
     ⚠ 为什么必须整层 `display:none` 而不是只清 `d`：上游那次选择给 `body` 挂了一个
       **永不摘除**的 mousemove 闭包，它每次移动都会把 `d` 重新写出来。
       只清路径的话，玩家稍微一动鼠标，那条线就又出现了。 */
  function clearAimLine() {
    var svg = d.getElementById('svg');
    if (svg) svg.style.display = 'none';
    var path = d.getElementById('svgpath');
    if (path) path.setAttribute('d', '');
    if (headEl) headEl.setAttribute('points', '');
    ['innercursor', 'outercursor', 'arrowcursor'].forEach(function (id) {
      var e = 找id(id);
      if (e) e.style.visibility = 'hidden';
    });
    if (d.body) d.body.style.cursor = 'auto';
  }

  /* ★ 瞄准期把虚线**吸附到目标**（用户 2026-10-03 报的「一」）。
     上游那条线是"从发起单位画到**指针**"——指针扫过空地时线也跟着飘，看不出"我到底要打谁"。
     现在：一旦指针落在某个合法目标上，就把线收到**那个目标的边框上**
     （起点 = 攻击方中心，终点 = 目标矩形上朝着攻击方的那个交点，箭头尖就落在框边）。
     没命中目标时**保持上游原样**（跟着指针）—— 那时候确实是在选，还没选中。

     ⚠ 写回 `d` 是安全的：上游那个更新虚线的 mousemove 挂在 `body` 上，
       我们挂在 `document` 上，冒泡顺序保证同一个事件里我们是**最后**写 d 的人
       （和 updateHead 里那条说明是同一件事）。 */
  function edgePoint(b, ox, oy, cx, cy) {
    /* 射线「攻击方中心 → 目标中心」**进入目标矩形**的那一点（slab 法求 t_enter）。
       箭头尖落在目标朝攻击方的那条边框上，不压进卡面。
       ⚠ 两个都已经踩过的坑：
         ① 不能"只算左右一条 + 上下一条再取最小" —— 取到的只是**边界平面**上的点，
            不是**边框线段**上的点（正上方打时算出来的 y 会跑到框外）。
            slab 法的进入参数是 max(各轴的近平面)，不是 min。
         ② 平行于某轴（dx 或 dy 为 0）时不能做除法，要单独判"在不在这一跨之内"。 */
    var dx = cx - ox, dy = cy - oy;
    if (!dx && !dy) return { x: cx, y: cy };
    var 进入 = -Infinity, 离开 = Infinity;
    if (dx) {
      var x1 = (b.left - ox) / dx, x2 = (b.right - ox) / dx;
      进入 = Math.max(进入, Math.min(x1, x2));
      离开 = Math.min(离开, Math.max(x1, x2));
    } else if (ox < b.left || ox > b.right) {
      return { x: cx, y: cy };            // 与 x 轴平行、且不在这一跨里 → 射不中
    }
    if (dy) {
      var y1 = (b.top - oy) / dy, y2 = (b.bottom - oy) / dy;
      进入 = Math.max(进入, Math.min(y1, y2));
      离开 = Math.min(离开, Math.max(y1, y2));
    } else if (oy < b.top || oy > b.bottom) {
      return { x: cx, y: cy };
    }
    if (!isFinite(进入) || 进入 > 离开) return { x: cx, y: cy };
    if (进入 < 0) 进入 = 0;               // 起点已经在框里（正常不会）→ 就用起点
    return { x: ox + dx * 进入, y: oy + dy * 进入 };
  }

  function snapAimLine(target) {
    if (srcKind !== 'unit' || !srcEl || !srcEl.getClientRects().length) return false;
    var svg = d.getElementById('svg');
    var path = d.getElementById('svgpath');
    if (!svg || !path) return false;
    /* 上游的处理器负责把这条线显示出来；它万一没跑到，我们自己显示 —— 瞄准线是我们的交互，
       不该依赖上游那段一次性绑定（见 bridgeCardBindings）。 */
    if (svg.style.display === 'none') svg.style.display = 'block';
    if (!target || !target.getClientRects().length) return false;   // 没目标 → 让上游跟着指针
    var b = srcEl.getBoundingClientRect();
    var ox = b.left + b.width / 2, oy = b.top + b.height / 2;
    var tb = target.getBoundingClientRect();
    var p = edgePoint(tb, ox, oy, tb.left + tb.width / 2, tb.top + tb.height / 2);
    path.setAttribute('d', 'M' + Math.round(p.x) + ',' + Math.round(p.y) +
                           ' ' + Math.round(ox) + ',' + Math.round(oy));
    return true;
  }

  /* 进入 / 退出"点选一格"模式（两步出牌的第二步）。
     ⚠ 点亮方式直接照 拖拽那条路 用的同一套（`showRow()` 加 `.active`、格子加 `.hot`），
     这样两条路线的视觉完全一致；`hotSlot()` 是"只点亮第 i 格"，所以这里直接操作类名。 */
  function 进入点选(card) {
    点选卡 = card;
    if (card && card.classList) card.classList.add('dragging');
    try { showRow('player'); } catch (e) {}
    var row = d.getElementById('hs-slots-player');
    if (row) {
      for (var i = 0; i < SLOT_COUNT; i++) {
        var cell = row.children[i];
        if (cell && !slots.player[i]) cell.classList.add('hot');
      }
    }
    提示条('点一个空格子，把它放上去　（Esc 取消）');
  }

  function 清点选() {
    if (点选卡 && 点选卡.classList) 点选卡.classList.remove('dragging');
    点选卡 = null;
    var row = d.getElementById('hs-slots-player');
    if (row) for (var i = 0; i < row.children.length; i++) row.children[i].classList.remove('hot');
    hideRows();
    if (!待选) 提示条('');
  }

  /* 松手时指针是否还停在这张牌上（= 一次"点"而不是"拖"）。
     用真实的命中测试（elementFromPoint），不用位移阈值估计 —— 缩放/触摸/异种宿主下都成立。 */
  function 点在这张牌上(x, y, card) {
    if (!card || !d.elementFromPoint) return false;
    var el = d.elementFromPoint(x, y);
    return !!(el && (el === card || card.contains(el)));
  }

  function cancelAim() {
    清点选();                     // 点空白 / Esc / 右键 都解除"点选一格"
    var had = (W.currentAttacker !== null && W.currentAttacker !== undefined) || state !== 'idle';
    if (!had) return false;
    W.currentAttacker = null;
    W.canAttack = false;
    clearAimLine();
    backToIdle();
    return true;
  }

  /* 事件处理器里抛的异常**不会冒到任何看得见的地方** —— 只在控制台留一行，
     而症状是"后面的代码整段没跑"（这次就是这样：showPreview 里一个 ReferenceError
     把紧随其后的 applyMask 干掉了，表现成"遮罩和预览整块消失"）。
     所以这里留一个最近的错误，任何一处都能读它来定位。 */
  var lastError = null;
  function guard(fn) {
    return function () {
      try { return fn.apply(this, arguments); }
      catch (err) { lastError = (fn.name || 'fn') + ': ' + err; throw err; }
    };
  }

  function onDown(e) {
    if (e.button === 2) return;
    /* ⚠ 演出里补发的"打中"这一拍（pipeline 的 onStrike）必须**放行**：
       它要送到目标自己绑的处理器（上游那套结算）才算数，而它并不是一次新的操作。
       第一版漏了这一步 —— 锁在捕获阶段把它一起 stopPropagation 掉，
       于是箭头飞过去、数字不出现，伤害根本不生效（自己把自己锁住了）。 */
    if (e.__hsStrike) return;
    /* 演出进行中：**在捕获阶段把事件吃掉** —— 这样上游那些绑在卡片/英雄上的 mousedown
       处理器也进不来，不只是"拖拽被禁用"（方案 §六引用那篇文章的原话：
       *「不要只禁用拖拽，快捷键或双击仍然能出牌」*）。 */
    if (W.HS_PIPELINE && W.HS_PIPELINE.isLocked()) { e.stopPropagation(); return; }
    ensureFit();                       // 先对一次缩放，见 ensureFit 的说明
    var t = e.target;
    if (!t || !t.closest) return;

    /* ★★ 一条硬规矩：**玩游戏不该被"选目标"卡住**（用户 2026-10-03 报的"按不出卡 + 疯狂提示"）。
       只要玩家开始**新的操作**（点手牌 / 点自己的单位 / 点结束回合），就把挂着的待选**放弃掉**
       （那条战吼落空，并说一声），然后这次操作照常走。
       为什么要有这条：待选是我们自己的交互（引擎里对应 `待选择`），但它**不能变成模态**——
       玩家想干别的就该能干；选择被放弃是明确的、有反馈的，而不是"点了没反应"。 */
    if (待选 && (t.closest('.cards .card') || t.closest('.player-cardinplay') || t.closest('#endturn'))) {
      放弃待选('你做了别的操作');
    }

    /* ★★ 两步出牌的第二步：**点一个空格子 → 把它放上去**（用户 2026-10-04："导出后手牌用不了"）。
       这条路只用到"点在哪一格"这一个几何判断，不依赖拖拽的落点精度，鼠标/触摸一样。
       放在最前面：点选态下点格子就是"落子"，不该再走下面的拖拽分支。 */
    if (点选卡) {
      var 落点 = slotAt('player', e.clientX, e.clientY);
      if (落点 >= 0) {
        var 要出的 = 点选卡;
        清点选();
        执行意图({ 类型: '出牌', 卡: 要出的, 格子: 落点 });       // ★ 与拖拽落格同一条意图
        e.stopPropagation();
        return;
      }
      /* 点选态下点了别的手牌 → 换成选它（下面的拖拽分支会接力，松手即进入新的点选） */
      if (!t.closest('.cards .card')) 清点选();
    }

    /* ★★ 敌方目标上的 mousedown **一律在捕获阶段吃掉**（用户 2026-10-03 第三轮）。
       为什么必须：上游 attack.js 的处理器绑在每张 `.cardinplay` 上（英雄也是），
       只要全局量 `currentAttacker` 非空，**在敌方卡/敌方英雄上按一下它就会自己结算一次**
       —— 用的是它的规则（无条件反击、DOM 即状态、还会写 currentAttacker）。
       那等于"两条结算路径同时活着"，正是这一轮要拔掉的病根。
       我们的攻击走"拖/点我方单位 → 松手在目标上"这条路（onUp 里调 应用一次攻击），
       所以敌方目标上的 mousedown 本来就没有正当用途，吃掉它没有任何副作用。 */
    if (t.closest(ENEMY_TARGETS)) {
      /* ★ 例外：**待选目标态**下，点敌方目标是正当操作（战吼要指谁）——交给 onUp 去消费。
         （这里只放行不处理：真正的判定放在 onUp，避开与攻击那条路的捕获顺序纠缠。） */
      if (待选) return;
      e.stopPropagation(); return;
    }

    var card = t.closest('.cards .card');
    if (card) {
      // ★ 拦掉上游的拖拽：它会把卡片挪到指针下（视口坐标，舞台缩放后必错位），而且挡场地。
      //   stopPropagation 在捕获阶段，卡片自己的 onmousedown 收不到，dragElement 就不会启动。
      e.stopPropagation();
      state = 'aiming'; srcKind = 'hand'; srcEl = card;
      // 箭头起点就是这张手牌的中心 —— **视口坐标**（#hs-arrow 挂在 body 上，见 drawArrow）
      var r = card.getBoundingClientRect();
      handOrigin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      card.classList.add('dragging');
      buildOverlays();
      showRow('player');
      var n = norm(e.clientX, e.clientY);
      drawArrow(handOrigin.x, handOrigin.y, e.clientX, e.clientY);
      showPreview(card, n.x, n.y);
      applyMask(n.y);
      return;
    }
    var unit = t.closest('.player-cardinplay');
    if (unit) {
      /* ★★ 只有**真的能打**的单位才起手（用户 2026-10-02 报的"伤害不生效"的根因）。
         上游判定能不能打的唯一标志是 `canAttack`（由它的 `attack()` 在我方回合开始时加上），
         而**不能打的时候它会把这次点击静默忽略**：不扣血、不报错、什么都不发生。
         在它前面还有箭头飞过去、冲上去、飘数字一套演出 —— 于是在玩家看来就是
         "动画放完了，伤害没生效"。
         刚上场的单位本轮本来就不能攻击（召唤延迟），所以"刚放下去就打"必然踩到这一条。
         这里提前拦住，并给一个看得见的反馈（红框 + 抖一下），而不是让它静默失败。 */
      if (!unit.classList.contains('canAttack')) { hoverUnit = null; hidePreview(); refuseAttack(unit); return; }
      /* ★★ 咬住上游的处理器，不让它接手（用户 2026-10-03 第三轮：全面用自主规划器）。
         上游 attack.js 那个 mousedown 处理器**在被选中时会去写全局量 `currentAttacker`**，
         而这个量一旦非空，**下一次点到敌方卡/敌方英雄时上游就会自己结算一次**
         （用它的规则：无条件反击、DOM 即状态）—— 那等于两条结算路径同时活着。
         我们现在把这次 mousedown 在捕获阶段吃掉：选中、瞄准、结算全归我们。 */
      e.stopPropagation();
      state = 'aiming'; srcKind = 'unit'; srcEl = unit;
      /* 面板切到**正在拖的这个单位**，并按指针位置选边 —— 和拖手牌同构：
         手上/箭头拖的是什么，面板就显示什么，而且永远在指针的**对面**那一侧。 */
      hoverUnit = null;
      var nu0 = norm(e.clientX, e.clientY);
      renderPreview(unitCardInfo(unit), nu0.x, nu0.y);
      /* 蒙版：压暗**没在指的那半张战场** —— 这条原来只挂在"拖手牌"上，
         所以用单位攻击时战场是亮的（用户 2026-10-02：*「为什么遮罩又没了」*）。
         单位瞄准和拖手牌是同一件事的两个入口，蒙版当然要一视同仁。 */
      applyMask(nu0.y);
      /* 单位攻击走**上游那条红色虚线**（保留原样呈现，不替换成我们的绿箭头），
         我们只负责给它补一个箭头尖 —— 上游的尖原本是光标图，已随美术剥离删掉。 */
      ensureHead();
      updateHead();
    }
  }

  /* 不能攻击时的反馈：红框 + 抖一下（`.hs-cant-attack` 在 ours.css 里） */
  function refuseAttack(el) {
    if (!el) return;
    el.classList.remove('hs-cant-attack');
    // 重排一次，好让同一个单位被连点时动画能重新开始（否则第二次不会有反应）
    void el.offsetWidth;
    el.classList.add('hs-cant-attack');
    W.setTimeout(function () { el.classList.remove('hs-cant-attack'); }, 460);
  }

  function onMove(e) {
    if (state !== 'aiming') {
      /* 空闲时的悬停预览（用户 2026-10-02）。演出一律让位 —— 那会儿面板与锁都归演出。 */
      var locked = W.HS_PIPELINE && W.HS_PIPELINE.isLocked();
      var el = locked ? null : hoverCardAt(e.clientX, e.clientY);
      if (!el) {
        if (hoverUnit || (preview && preview.classList.contains('on'))) { hoverUnit = null; hidePreview(); }
        return;
      }
      var n0 = norm(e.clientX, e.clientY);
      var want = 'on ' + ((n0.x < 0.5) ? 'side-right' : 'side-left') + ' ' + ((n0.y < 0.5) ? 'shift-down' : 'shift-up');
      /* 内容只在换了一张卡时才重渲染；位置（左/右、上/下）每次移动都跟着指针走 ——
         否则指针从卡片上沿移到下沿，面板不会换到另一半。 */
      if (el !== hoverUnit || (preview && preview.className !== want)) {
        hoverUnit = el;
        renderPreview(unitCardInfo(el), n0.x, n0.y);
      }
      return;
    }

    if (srcKind === 'hand') {
      var n = norm(e.clientX, e.clientY);
      drawArrow(handOrigin.x, handOrigin.y, e.clientX, e.clientY);
      showPreview(srcEl, n.x, n.y);
      applyMask(n.y);
      var i = slotAt('player', e.clientX, e.clientY);
      pendingSlot = i;
      hotSlot('player', i);
      return;
    }

    /* ★ 面板换边：**"鼠标在左 → 面板在右，反之亦然，两者永不同侧"是一条硬规则**，
       指向期间同样成立（用户 2026-10-02 的截图就是它被违反了：指针在左上、面板也在左边）。
       内容不动（就是正在拖的那个单位，onDown 已经渲染好），这里只改左右/上下两个类。 */
    if (srcKind === 'unit' && preview) {
      var nu = norm(e.clientX, e.clientY);
      var wantU = 'on ' + ((nu.x < 0.5) ? 'side-right' : 'side-left') + ' ' + ((nu.y < 0.5) ? 'shift-down' : 'shift-up');
      if (preview.className !== wantU) preview.className = wantU;
      applyMask(nu.y);                       // 蒙版跟着指针换半边（与拖手牌同一套）
    } else if (srcKind === 'unit' && hoverUnit) {
      hoverUnit = null; hidePreview();
    }

    var target = enemyTargetAt(e.clientX, e.clientY);
    if (target !== hoverTarget) {
      clearHover();
      if (target) { target.classList.add('hs-target-hover'); hoverTarget = target; }
    }
    /* 命中目标 → 虚线吸附到那个目标的框边（见 snapAimLine 的说明） */
    snapAimLine(target);
    /* 箭头尖跟着虚线走。虚线由上游 attack.js 挂在 `body` 上的 mousemove 更新，
       我们挂在 `document` 上 —— 冒泡顺序（body 先、document 后）保证读到的是最新端点。 */
    updateHead();
  }

  /* ★★ 输入层归一（架构改进 F）：**所有输入先变成一条"意图"，再由唯一出口执行**。
     意图就是一个纯对象：`{ 类型, … }`
       出牌   `{ 卡: 手牌元素, 格子: 0 基下标 }`
       攻击   `{ 攻方: 场上元素, 目标: 元素, 目标型: 'player' | 'unit' }`
       选目标 `{ 目标: 元素 }`          ← 决策响应那条
     为什么值得收：以前"出牌"被好几处直接调（拖拽松手 / 点选落格 / 清场重开 / 测试），
     每处各自决定"能不能出、出到哪"；归一到一条意图之后 ——
       · **校验只有一处**（`执行意图` 先验参数，再交执行器）；
       · **拖拽与点选走同一条路**，于是"某种输入方式坏了"不会再漏过测试（本会话的教训：
         我一直用合成事件验拖拽，结果真实点击走不通却查不出来）；
       · 非法意图**一定**落进检错层（`UI_INVALID_INPUT`），不再静默丢弃。
     ⚠ 没纳入的：「结束回合」仍走上游那个按钮（+ 我们的 `wo` 叙述包装）—— 它牵扯上游整套
       回合机件，硬接过来收益小风险大，于是**明确记在这里**，不装作已经归一了。 */
  var 意图计数 = {};
  /* 元素"还在场上吗"的判据。⚠ 2026-10-04 实测教训：第一版只写 `el.isConnected`，
     结果**玩家的真实攻击全被自己的输入层拦掉**（`{成:false, 原因:'攻方不在文档里'}`）——
     那个元素明明在场上、可见、能打。所以判据放宽成"在文档里 **或** 有布局盒"，
     并把两个事实都记进检错上下文（下次出错能直接看出是哪一种）。 */
  function 在场上(el) {
    if (!el) return false;
    if (el.isConnected) return true;
    try { return !!(el.getClientRects && el.getClientRects().length); } catch (e) { return false; }
  }
  function 为什么不在(el) {
    if (!el) return '元素为空';
    var 连 = !!el.isConnected, 盒 = 0;
    try { 盒 = el.getClientRects ? el.getClientRects().length : 0; } catch (e) {}
    return 'isConnected=' + 连 + ' 布局盒=' + 盒;
  }
  function 合法意图(意) {
    if (!意 || !意.类型) return '没有类型';
    if (意.类型 === '出牌') {
      if (!在场上(意.卡)) return '手牌元素不在场上（' + 为什么不在(意.卡) + '）';
      if (typeof 意.格子 !== 'number' || !isFinite(意.格子)) return '格子不是数字';
      if (意.格子 < 0 || 意.格子 >= SLOT_COUNT) return '格子越界';
      return null;
    }
    if (意.类型 === '攻击') {
      if (!在场上(意.攻方)) return '攻方不在场上（' + 为什么不在(意.攻方) + '）';
      if (!在场上(意.目标)) return '目标不在场上（' + 为什么不在(意.目标) + '）';
      if (意.目标型 !== 'player' && 意.目标型 !== 'unit') return '目标型不认识';
      return null;
    }
    if (意.类型 === '选目标') {
      if (!在场上(意.目标)) return '目标不在场上（' + 为什么不在(意.目标) + '）';
      return null;
    }
    return '不认识的意图类型：' + 意.类型;
  }

  /* 唯一出口。返回 { 成: bool, 原因?: string } */
  function 执行意图(意) {
    var 坏 = 合法意图(意);
    if (坏) {
      报(0, 'UI_INVALID_INPUT', { 类型: (意 && 意.类型) || null, 原因: 坏 }, '提示');
      return { 成: false, 原因: 坏 };
    }
    意图计数[意.类型] = (意图计数[意.类型] || 0) + 1;
    try {
      if (意.类型 === '出牌') {
        var 成 = !!playFromHand(意.卡, 意.格子);
        /* ★ 提交点要**等异步落定**（改进 B 的第一次实测就抓到这个）：
           上游的扣费在 `setTimeout(…, 0.01)` 里、落场在 MutationObserver 的微任务里 ——
           同步提交会采到"还没扣费、卡还没上场"的旧值，于是权威与 DOM 立刻不一致
           （对账当场报 `法力` 与 `player.场上` 两处差异）。隔一拍再采，才是"这一拍之后的局面"。 */
        if (成) W.setTimeout(function () { try { 提交场面('出牌'); if (W.HS_STATE) W.HS_STATE.展示追到(); } catch (e) {} }, 120);
        return { 成: 成 };
      }
      if (意.类型 === '攻击') {
        /* ⚠ `已演出: true` 是**敌方计划**专用的：那条路已经由演出管线播过"箭头→冲上去→打击"，
           这里只需要在**它自己的那一拍**落地结算。不加这个标记就会**又演一遍** ——
           用户 2026-10-04 报的"敌方单位移动两次、先扣体力再打人"就是它：
           一次攻击被演了两遍（第一遍付攻耗、第二遍才结算伤害）。 */
        if (意.已演出) { 应用一次攻击(意.攻方, 意.目标, 意.目标型); return { 成: true }; }
        发起攻击演出(意.攻方, 意.目标, 意.目标型);
        return { 成: true };
      }
      if (意.类型 === '选目标') {
        if (!待选 || 待选.可选.indexOf(意.目标) < 0) {
          报(3, 'DECISION_INVALID', { 目标: (意.目标.id || 意.目标.className || '') }, '提示');
          return { 成: false, 原因: '这个目标不能选' };
        }
        var 效 = 待选.效果, 席位 = 待选.席位;
        清待选();
        执行效果(效, 席位, 意.目标);
        return { 成: true };
      }
    } catch (e) {
      /* 执行器里的异常以前会被监听器吞掉（本会话踩过：上游监听器抛错、外面接不到） */
      报(0, 'UI_INVALID_INPUT', { 类型: 意.类型, 抛错: String(e && e.message) }, '严重');
      return { 成: false, 原因: '执行出错' };
    }
    return { 成: false, 原因: '没实现的意图' };
  }

  /* 攻击演出 + 结算（原来内联在 onUp 里；抽出来是因为**两种输入与 Bot** 都要走它） */
  function 发起攻击演出(from, t, kind) {
    clearAimLine();
    clearHover();
    state = 'idle'; srcKind = null; srcEl = null;
    hideMask();
    hidePreview();
    if (W.HS_PIPELINE && W.HS_PIPELINE.present) {
      W.HS_PIPELINE.present({
        verb: 'attack', from: from, to: t, toKind: kind,
        onStrike: function () { 应用一次攻击(from, t, kind); },
      });
    } else {
      应用一次攻击(from, t, kind);        // 管线不在 → 松手立即结算
    }
  }

  function onUp(e) {
    /* ★ 待选目标态优先：这时点一下就是"选它"（点非法的地方只提示、不取消 —— 免得手滑） */
    if (待选 && 待选点击(e.clientX, e.clientY)) { e.stopPropagation(); return; }
    if (state !== 'aiming') return;

    if (srcKind === 'hand') {
      var want = slotAt('player', e.clientX, e.clientY);
      var card = srcEl;
      hotSlot('player', -1);
      hideArrow(); hidePreview(); hideMask();     // 松手 → 蒙版与预览一起解锁
      card.classList.remove('dragging');
      state = 'idle'; srcKind = null; srcEl = null; handOrigin = null;
      hideRows();
      /* ★ 输入层归一：**拖拽落格**与**点选落格**最后都变成同一条"出牌"意图 */
      if (want >= 0) 执行意图({ 类型: '出牌', 卡: card, 格子: want });
      /* ★ 两步出牌的第一步：**松手时指针还在那张牌上**（= 一次"点"，不是"拖"）→ 进入点选一格。
         判据用 `elementFromPoint`（真实的命中测试），不是"位移小于几像素"那种估计 ——
         触摸、缩放、别人家的页面里都成立。 */
      else if (点在这张牌上(e.clientX, e.clientY, card)) { 进入点选(card); return; }
      syncSlots();
      return;
    }

    if (srcKind === 'unit' && hoverTarget) {
      var t = hoverTarget, from = srcEl;
      var kind = (t.id === 'opposinghero') ? 'player' : 'unit';
      /* ★ 瞄准线到此为止（用户 2026-10-02）：接下来这条线由**演出自己的箭头**接手 ——
         它从同一个单位画向同一个目标，所以看上去是"箭头接手"，而不是两条线同时挂着。
         ⚠ 结算改由**我们自己**做（用户 2026-10-03 第三轮：全面改用自主规划器）：
           以前这里补发一次合成的 mousedown 交给上游 attack.js（DOM 即状态 + currentAttacker），
           那套给过我们三类坑（处理器只绑当初在场的卡、currentAttacker 残留、无条件反击）。
           现在玩家打、敌方打**共用同一个** `应用一次攻击()`，规则以引擎为准。
         输入层归一之后，这里不再自己演出/结算，只发一条"攻击"意图。 */
      执行意图({ 类型: '攻击', 攻方: from, 目标: t, 目标型: kind });
      return;
    }

    cancelAim();
  }

  function onClick(e) {
    /* ★★ 演出进行中不取消（用户 2026-10-02 报「所有攻击都不生效」的根因，是我的责任）：
       mousedown 落在**单位**、mouseup 落在**目标**上时，浏览器会在两者的**公共祖先**
       （通常是 `#game`）补发一次 `click` —— 它不是白名单里的元素，于是这里会调
       `cancelAim()`，把上游那个 `currentAttacker` 清成 null。
       以前结算是同步的（就在 mouseup 里），赶得在这次 click 之前；而我们现在把结算
       推迟到"箭头到达"那一拍，于是这次 click 先跑、结算时"攻击方不见了"，
       表现就是**每一次攻击都静默不生效**。合成事件不会自动产生 click，所以自动测试一直测不出来。

       ⚠ 2026-10-03 第三轮：判断"有没有在瞄准"的依据从上游那个 `currentAttacker` 换成了
       **我们自己的 `state`** —— 结算收回自己手里之后，上游那个全局量已经不再被任何人写，
       再拿它当依据，"点空白取消瞄准"就会失效（它是我们自己的交互，就该看我们自己的状态）。 */
    if (W.HS_PIPELINE && W.HS_PIPELINE.isLocked()) return;
    if (state === 'idle' && (W.currentAttacker === null || W.currentAttacker === undefined)) return;
    var t = e.target;
    if (t && t.closest && t.closest(KEEP)) return;
    cancelAim();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' || e.keyCode === 27) {
      // 跳过演出：把在飞的动画**跳到终态**（不是回起点），状态不会停在一半
      if (W.HS_PIPELINE) W.HS_PIPELINE.skip();
      /* 待选目标态：Esc 先取消它（= 那条战吼落空），不再往下走 */
      if (清待选()) { notice('已取消选目标'); e.stopPropagation(); e.preventDefault(); return; }
      if (cancelAim()) { e.stopPropagation(); e.preventDefault(); }
      return;
    }
    if (e.key === 'v' || e.key === 'V' || e.keyCode === 86) toggleView();
  }

  function onRightDown(e) {
    if (e.button !== 2) return;
    if (W.HS_PIPELINE) W.HS_PIPELINE.skip();
    cancelAim();
  }

  function onDragStart(e) { e.preventDefault(); }     // ⑥ 禁掉原生拖拽

  /* ==================== 牌堆抽空：洗回去（无疲劳） ==================== */

  var PLAYER_TPL = null, ENEMY_TPL = null;

  /* index.js 里 `let originalDeck, playerDeck, computerDeck` —— 用 let 声明的顶层绑定
     **不会**挂到 window 上，只能按标识符取。所以统一走这一个取值的口子，
     免得再写出 `W.playerDeck` 那种静默 undefined。 */
  function deckRef(name) {
    try {
      if (name === 'originalDeck' && typeof originalDeck !== 'undefined' && originalDeck) return originalDeck.cards;
      if (name === 'playerDeck' && typeof playerDeck !== 'undefined' && playerDeck) return playerDeck.cards;
      if (name === 'computerDeck' && typeof computerDeck !== 'undefined' && computerDeck) return computerDeck.cards;
    } catch (e) { /* 还没初始化 */ }
    return null;
  }

  function snapshotDecks() {
    var oc = deckRef('originalDeck');
    if (!oc) return;
    // 开局那份是 [30 张玩家牌] + [1 张占位] + [29 张对手牌] + [召唤物]，见 levels.js 的说明
    PLAYER_TPL = oc.slice(0, 30);
    ENEMY_TPL = oc.slice(31, 60);
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* 用户 2026-10-02：这套规则没有「卡组耗尽的疲劳」，牌打完就把墓地重新洗入牌组。
     上游牌空时 `deck.cards[0]` 会直接炸，所以这里兜一道：
     空了就用开局那份牌组重新洗一副放回去。
     （严格意义上的「墓地」需要记录每张牌的去向，属于演出管线里的 zone 模型，见方案 §8.3。） */
  function refillIfEmpty() {
    try {
      var p = deckRef('playerDeck');
      if (PLAYER_TPL && p && p.length === 0) {
        playerDeck.cards = shuffle(PLAYER_TPL.slice());     // 按标识符赋回，见 deckRef 的说明
        notice('我方牌堆重洗');
      }
      var c = deckRef('computerDeck');
      if (ENEMY_TPL && c && c.length === 0) {
        computerDeck.cards = shuffle(ENEMY_TPL.slice());
        notice('敌方牌堆重洗');
      }
    } catch (err) { /* 拿不到就当没有；不能因为兜底把回合打断 */ }
  }

  /* C7：洗回牌堆的提示（规则早就有了 —— 见 refillIfEmpty），现在让它看得见 */
  function notice(text) {
    try {
      if (W.HS_PIPELINE && W.HS_PIPELINE.present) {
        W.HS_PIPELINE.present({ verb: 'turn', to: d.getElementById('manacontainer') || stage(), label: text });
      }
    } catch (err) { /* 提示失败不影响规则 */ }
  }

  /* 回合叙述：按**回合开始判断 → 抽牌 → 行动**这个顺序（用户 2026-10-02）。
     ⚠ 上一版把「抽牌」挂在一个盯敌方牌堆长度的观察器上 —— 那是**误报**：
       上游的敌方**根本不抽牌**（`opponentTurn` 里没有任何 shift），
       而 `computerCardPlace` 会把打出的那张从牌堆里去掉，于是"打出一张牌"被当成了"抽一张"。
       所以现在改成两条**有确切入口**的叙述：
         · 玩家回合：包 `playerTurn` —— 它在函数开头涨法力、在结尾抽牌，包一层就能按真实时序叙述；
         · 敌方回合：包 `opponentTurn` —— 它没有抽牌这一步，只报一次"敌方回合"，
           行动由 `computerCardPlace` 的包装负责（第 2 期），攻击留给第 3 期。
     顺带把"牌堆抽空就洗回去"合并进同一个包装（原来那个 wrapDrawers）。 */
  function wrapTurnNarration() {
    var upPlayer = W.playerTurn;
    /* ★ 留痕：回合切换次数（导出本局信息里会打印）。真机"点了没反应"要能区分
       "点击没落到按钮上"和"落上了但回合没推进" —— 前者看点击日志，后者看这两个计数。 */
    if (typeof W.HS_TURN_LOG !== 'object') W.HS_TURN_LOG = { opponentTurn: 0, playerTurn: 0 };
    if (typeof upPlayer === 'function' && !upPlayer.__hsNarrated) {
      var wp = function () {
        try { W.HS_TURN_LOG.playerTurn++; } catch (e) {}
        /* ★★ 一条硬不变式（用户 2026-10-04 报的"我的回合为什么有遮罩"）：**我方回合 = 没有遮罩**。
           遮罩原本只在"敌方回合那段演出播完"的链条末尾撤掉（见下面 whenIdle 链），
           只要那条链没走到头（演出被打断、页内重开、异常），蒙版就会一直挂在我方回合上 ✗。
           所以在回合开始这一拍**先撤一次**：这是"我的回合"的语义本身，不该依赖演出的收尾。 */
        try { hideMask(); } catch (err) { /* 撤遮罩失败不影响回合 */ }
        setEnemyBusy(false);
        /* ★ 敌方回合结束 → 敌方的随从按新规则回复体力（没攻击过的那些） */
        try { 回合结束回复('enemy'); } catch (err) {}
        清攻击过标记('player');            // 我的新回合：清掉上一轮"攻击过"
        atTurnStart = true;      // ← 只在这一拍允许 attack() 补刷"可攻击"状态
        refillIfEmpty();
        var manaBefore = W.manaCapacity;
        var handBefore = d.getElementById('cards') ? d.getElementById('cards').childElementCount : -1;
        var out = upPlayer.apply(this, arguments);
        /* ★ 提交点必须在**包装函数体里**（2026-10-04 实测教训）：第一版把定时器写在
           "安装包装"那一刻（加载时只跑一次）→ 采到的是开机瞬间的空账，真正的回合变更
           之后再没人提交，于是对账永远报 回合/法力/手牌 不一致。
           这里在**上游把回合开好之后**再采（隔 200ms 让落场/扣费那类异步动作定下来）。 */
        W.setTimeout(function () {
          try { 提交场面('回合开始'); if (W.HS_STATE) W.HS_STATE.展示追到(); } catch (e) {}
        }, 200);
        /* 回合开始那一刻法力上限会 +1（上游在 playerTurn 开头干的）——
           任务区那一行读的就是这个真值，所以在这里刷一次。 */
        try { 渲染任务区(); } catch (err) { /* 任务区只是显示，出错不影响回合 */ }
        try {
          if (W.HS_PIPELINE && W.HS_PIPELINE.present) {
            var mine = d.getElementById('playerhero');
            /* ① 回合开始：法力上限 +1（这是玩家侧的"回合开始判断"里唯一看得见的东西） */
            if (typeof manaBefore === 'number' && W.manaCapacity > manaBefore) {
              W.HS_PIPELINE.present({ verb: 'gain', to: d.getElementById('manacontainer') || mine, label: '法力 +1' });
            }
            /* ② 抽牌：手牌变多了，就是抽到了 */
            var cards = d.getElementById('cards');
            var fresh = (cards && handBefore >= 0 && cards.childElementCount > handBefore) ? cards.lastElementChild : null;
            if (fresh) {
              /* ★ 抽到的那张**先藏起来**，等这段"抽牌"动画播到它自己那一拍才现身。
                 用户 2026-10-03：我方抽牌也要等对方的动画播完、回合真正交出来之后，
                 才正式进手牌区 —— 不能在动画还没放完时就已经躺在手上了。 */
              fresh.style.visibility = 'hidden';
              W.HS_PIPELINE.present({
                verb: 'draw', from: cards, to: fresh, label: '抽牌',
                onStrike: function () { fresh.style.visibility = ''; },
              });
            }
          }
        } catch (err) { /* 叙述出错不该影响回合 */ }
        /* ★ 遮罩收尾：等**我方回合开始的法力与抽牌**这一段演出也播完，才撤掉下半遮罩
           （用户 2026-10-03：敌方回合的遮罩要延到我方抽牌阶段结束）。
           注意这**不影响按钮变绿** —— 按钮按用户定下的规则，在敌方动作演完就绿。 */
        try {
          if (W.HS_PIPELINE && typeof W.HS_PIPELINE.whenIdle === 'function') {
            W.HS_PIPELINE.whenIdle().then(function () { try { hideMask(); } catch (e) {} });
          } else {
            hideMask();
          }
        } catch (err) { /* 撤遮罩失败不影响回合 */ }
        return out;
      };
      wp.__hsNarrated = true;
      /* ★ 把"这一拍归谁"的标记一起搬过来（资源层给自己打的 `__hsOurs`）：
         外面问"回合推进还是我们实现的吗"就靠它。标记一断，自检与文档的口径跟着失真。 */
      wp.__hsOurs = upPlayer.__hsOurs;
      W.playerTurn = wp;
    }

    var upOpp = W.opponentTurn;
    if (typeof upOpp === 'function' && !upOpp.__hsNarrated) {
      /* 规划：**只看不碰**。产出一串"要做的事"，每件事自带一个 `apply` ——
         那个函数**不会在规划时跑**，只在演出播到它自己的那一拍时才跑。 */
      function unitHP(el) {
        var h = el && el.children[1];
        return h ? (h.children.length ? h.children[0] : h) : null;
      }
      function unitATK(el) {
        var a = el && el.children[0] && el.children[0].children[0];
        return parseInt(String(a && a.textContent || '').trim(), 10) || 0;
      }

      function planEnemyTurn() {
        var deck = enemyDeckCards();
        var hero = d.getElementById('opposinghero');
        var plan = [{ verb: 'turn', to: hero, label: '敌方回合' }];
        if (deck && deck.length) {
          plan.push({ verb: 'draw', from: hero, to: hero, label: '抽牌',
            apply: function () { drawForEnemy(1); } });
        }
        /* 出牌：照上游的规则（费用正好等于法力上限的优先，否则第一张）。
           这里"预看"刚抽到的那张（deck[0]）—— 因为决策必须先于施加。 */
        var hand = enemyHand.slice();
        if (deck && deck.length) hand.push(deck[0]);
        var cap = (typeof manaCapacity !== 'undefined' && manaCapacity) ? manaCapacity : 1;
        /* ★ 阶段 E：**挑哪张由决策层说了算**（游戏/决策.js，按难度档位）。
           以前这里是"费用恰好等于上限的优先，否则第一张"，而实际出牌那一步
           （playFromEnemyHand）又按同样规则**自己再挑一次** —— 于是档位挑的与打出的
           根本不是同一张，三个档位等于全废。现在下标一路传下去（`选`）。 */
        var 候选 = [];
        for (var q = 0; q < hand.length; q++) {
          候选.push({ 费: (hand[q] && typeof hand[q].mana === 'number') ? hand[q].mana : 99 });
        }
        var 选 = W.HS_DECIDE ? W.HS_DECIDE.选手牌(候选, cap) : -1;    // −1 = 这回合不出牌（新手档会发呆）
        var pick = (选 >= 0) ? hand[选] : null;
        /* ⚠ 槽位满了就**不出牌**（用户 2026-10-03 报的 bug：5 格已满还继续上场，
           结果三张卡挤在同一个槽里）。原因是 assignNew 找不到空格时直接 return，
           那张卡就没有 left、停在棋盘左缘（= 第 1 格的位置）。所以这里先数格子。 */
        var occupied = d.querySelectorAll('.board--opponent .cardinplay').length;
        if (pick && occupied < SLOT_COUNT) {
          plan.push({ verb: 'deploy', from: hero, toKind: 'slot', label: '上场', 选: 选 });
        }

        /* 攻击：**也交给决策层**（同一份档位语义）。这里是"把 DOM 读成描述符"的那一层 ——
           决策层是纯函数（吃 {攻}/{血量,嘲讽,英雄}），所以档位规则能在 node 里直接测。 */
        var mine = d.querySelectorAll('.board--player .cardinplay');
        var foes = d.querySelectorAll('.board--opponent .cardinplay');
        var 攻方 = [], 目标 = [], k;
        for (k = 0; k < foes.length; k++) 攻方.push({ i: k, 攻: unitATK(foes[k]) });
        for (k = 0; k < mine.length; k++) {
          目标.push({ i: k, 攻: unitATK(mine[k]),
                      血量: parseInt(String((unitHP(mine[k]) || {}).textContent || '').trim(), 10) || 0,
                      嘲讽: !!(mine[k].classList && mine[k].classList.contains('hasTaunt')) });
        }
        目标.push({ i: mine.length, 英雄: true, 血量: 9999 });          // 英雄排在末位：只有"没人可换"时才轮到它
        var 决定 = W.HS_DECIDE ? W.HS_DECIDE.选攻击(攻方, 目标) : null;
        if (决定) {
          var best = foes[决定.攻方];
          var tgt = (决定.目标 === mine.length) ? d.getElementById('playerhero') : mine[决定.目标];
          if (best && tgt) {
            var bestAtk = unitATK(best);
            var kind = (tgt.id === 'playerhero' || tgt.id === 'opposinghero') ? 'player' : 'unit';
            plan.push({ verb: 'attack', from: best, to: tgt, toKind: kind, delta: { hp: -bestAtk },
              /* ★ 输入层归一之后，**Bot 与玩家发的是同一种意图**（只是"谁发"不同）——
                 于是"敌方攻击"与"我方攻击"不可能再各有一套规则（B26 反复强调的那条）。 */
              apply: function () { 执行意图({ 类型: '攻击', 攻方: best, 目标: tgt, 目标型: kind, 已演出: true }); } });
          }
        }
        return plan;
      }

      /* 施加一次攻击 —— 用**我们自己的** `应用一次攻击()`（外层作用域，玩家侧也走它）。
         这里原来有一份敌方专用的 `applyExchange`：2026-10-03 第三轮把它与玩家侧合并成同一个函数，
         两边共用一套规则，就不会再出现"只坑玩家"或"两边各写一份"的偏差。见 应用一次攻击 的说明。 */
      /* 从敌方手牌里出一张。`选` = **决策层已经挑好的下标**（阶段 E 起必须用它 ——
         以前这里会按自己的规则再挑一次，于是"档位挑的那张"和"真正打出的那张"不是同一张，
         难度档位就死在这一步）。hidden：先挂成透明，等演出"浮现"那一拍才看得见。 */
      function playFromEnemyHand(hidden, 选) {
        var board = boardOf('enemy');
        if (!board || !enemyHand.length) return null;
        var cap = (typeof manaCapacity !== 'undefined' && manaCapacity) ? manaCapacity : 1;
        var idx = 0, i;
        if (typeof 选 === 'number' && 选 >= 0 && 选 < enemyHand.length) {
          idx = 选;
        } else {
          /* 兜底（决策层没给/越界）：上游原样 —— 费用恰好等于法力上限的优先，否则第一张 */
          for (i = 0; i < enemyHand.length; i++) if (enemyHand[i] && enemyHand[i].mana == cap) { idx = i; break; }
        }
        var card = enemyHand[idx];
        if (!card || typeof card.getComputerHTML !== 'function') return null;
        var el;
        try { el = card.getComputerHTML(); } catch (err) { return null; }
        if (!el || el.nodeType !== 1) return null;
        enemyHand.splice(idx, 1);
        /* ★ 卡名就在这里定下来（用户 2026-10-03 报的"敌方不显示也不支付体力"的根因）：
           这一路是**我们自己的规划器**在出牌，它不会去填 `enemyNameQueue`（那个队列是给
           上游 `computerCardPlace` 那条路用的）—— 于是紧接着的 `syncSlots()` 里
           `stampName()` 从空队列里取到空串，把 `__hsName` 写死成 `''`（而 stampName 的守卫是
           "不是 undefined 就不再写"），这张卡就**永远认不出自己是谁** → 挂不上体力徽章、
           `__hs攻耗` 为 undefined → 打人时一分体力都不付。
           这里我们明明知道是哪张卡（`card`），直接标上，不用绕队列。 */
        el.__hsName = card.name;
        if (hidden) el.style.opacity = '0';
        board.appendChild(el);
        syncSlots();                      // 立刻落格，别让箭头指到还没归位的卡
        /* ★ 阶段 D：**敌方出带效果的牌时，它的战吼也真的生效**。
           上游那条路（`cardPlaceSnds`）只认玩家的 `getNameOfElement`，敌方出牌**从不走效果**
           —— 这正是《全线排查》里记的那条 ❌（"敌方打出带效果的牌时，效果算谁的？"）。
           现在两边同一个执行器、同一张效果表，这条洞堵上了。 */
        try { 应用战吼(card.name, 'enemy', el); } catch (err) { /* 效果出错不该影响出牌 */ }
        return el;
      }

      /* 把一条规划变成队列里的演出：deploy 先挂上场（透明），其余把 apply 挂到"打击那一拍"。 */
      function stageAction(a) {
        if (a.verb === 'deploy') {
          var el = playFromEnemyHand(true, a.选);
          if (!el) return;                // 手里没有能打的牌 → 这一条取消
          a.to = el;
          delete a.apply;
        } else if (a.verb === 'draw' && a.apply) {
          /* 抽牌的**施加**就放在这里（而不是等动画那一拍）：手牌是隐藏的，
             玩家看不到；可见的只有那张卡背动画。放在这里，后面"上场"那条
             紧接着就能取到牌 —— 否则它的 staging 会在"手牌还是空的"时候跑掉。 */
          try { a.apply(); } catch (err) { /* 抽不到就算了 */ }
          delete a.apply;
        } else if (a.apply) {
          /* 其余（攻击）：**只把施加挂到"打击那一拍"**，动画播到那儿才动血 */
          var fn = a.apply;
          a.onStrike = function () { try { fn(); } catch (err) { /* 施加失败也要把演出走完 */ } };
        }
        W.HS_PIPELINE.present(a);
      }

      var wo = function () {
        try { W.HS_TURN_LOG.opponentTurn++; } catch (e) {}
        /* ★ 点击的落点记一笔：如果这个计数在涨而"最近播过的动作"为空，就说明
           "点击接上了、但演出/结算这条链没走" —— 与"点击根本没落上"是两回事。 */
        setEnemyBusy(true);          // 敌方开始行动 → 按钮变灰，直到它的演出全部播完
        /* ★ 我方回合结束 → 我方随从按新规则回复体力（没攻击过的那些）；
           敌方的新回合开始 → 清掉敌方上一轮"攻击过"的标记。 */
        try { 回合结束回复('player'); } catch (err) {}
        try { 清攻击过标记('enemy'); } catch (err) {}
        /* 同时把**下半张**压暗（我方那半边）：这一段我们确实不能操作，
           遮罩比"按钮变成灰"更能说清这件事。回合结束时撤掉（见下面 whenIdle 链）。
           ⚠ 传 0.1 而不是 0.9：`applyMask(ny)` 是按"指针在哪半边"决定盖哪半边的 ——
             `ny < 0.5`（视作指针在上半）才是**盖下半**。写 0.9 会盖成上半（已踩过）。 */
        try { applyMask(0.1); } catch (err) { /* 遮罩失败不影响回合 */ }
        /* ★★ 敌方回合：**先规划，再边演边施加**（用户 2026-10-02 要求重做）。
           上一版是"上游先把整回合算完，我们再回放"—— 那是错的：玩家会先看到结果
           （牌已经在场上、自己的单位已经死了、甚至已经轮到我了），然后才看到动画。
           现在：规划阶段只看不碰；队列播到哪一条，才在**它自己的那一拍**施加变更；
           **全部播完**（队列排空）才调用 playerTurn —— 玩家在看完之前动不了。 */
        if (!W.HS_PIPELINE || typeof W.HS_PIPELINE.whenIdle !== 'function') {
          return upOpp.apply(this, arguments);       // 管线没就位（或没导出 whenIdle）→ 退回上游
        }
        var plan;
        try { plan = planEnemyTurn(); }
        catch (err) {
          if (W.console && W.console.error) W.console.error('[敌方规划] 失败，退回上游：', err);
          return upOpp.apply(this, arguments);
        }
        try {
          if (typeof playersTurn !== 'undefined') playersTurn = false;
          var ct = d.getElementById('computerTurn'); if (ct) ct.style.display = 'block';
          var et = 找id('endturn');
          if (et) { et.style.backgroundColor = 'grey'; et.innerText = 'ENEMY TURN'; }
        } catch (err) { /* 界面细节，失败不影响流程 */ }
        /* ⚠ staging 也要**排进队列**、逐条做：不能在这里一次性 forEach ——
           "上场"那条要等"抽牌"的 apply（在抽牌那一拍）跑完，手上才有牌可取。
           所以每条都是"先排一次 staging，再排它自己的演出"，顺序天然正确。 */
        try {
          plan.forEach(function (a) {
            W.HS_PIPELINE.push(function () { stageAction(a); return null; });
          });
        } catch (err) { if (W.console && W.console.error) W.console.error('[敌方演出] 失败：', err); }
        /* 排一个"空任务"排在队尾：它的 promise 一解决，说明前面每一条都演完了 */
        /* ★★ 收尾：等**所有演出真的播完**（队列空 + 没在跑），再报一声"敌方回合结束"，
           那一拍才算回合结束 —— 按钮变绿、遮罩撤掉、交给玩家。
           ⚠ 上一版是"往队尾排一个空任务"当结束信号，那是错的：staging 任务和它 append
             的演出都在同一个队列里，空任务会插在**演出之前**跑，于是按钮在动画还没播时
             就变绿了（用户 2026-10-03 报的正是这个）。 */
        return W.HS_PIPELINE.whenIdle().then(function () {
          try {
            W.HS_PIPELINE.present({ verb: 'turn', to: d.getElementById('opposinghero'), label: '敌方回合结束' });
          } catch (err) { /* 报相位失败不影响交回合 */ }
          return W.HS_PIPELINE.whenIdle();
        }).then(function () {
          setEnemyBusy(false);       // ← 到这一拍才算"敌方回合结束"：按钮变绿
          /* ★ 敌方回合结束也是提交点（改进 B），同样**写在函数体里**（见 wp 那段教训）：
             敌方的出牌/攻击都结算完了 —— 这里也是"展示追平权威"的天然时刻。 */
          try { 提交场面('敌方回合结束'); if (W.HS_STATE) W.HS_STATE.展示追到(); } catch (e) {}
          /* ⚠ 遮罩**先不撤**：用户 2026-10-03 要求它一直延到我方回合的**抽牌阶段结束**，
             这样"这一段你不能操作"这件事覆盖得更完整（撤遮罩挪到 wp 里，等法力+抽牌播完）。 */
          try { if (typeof W.playerTurn === 'function') W.playerTurn(); } catch (err) { /* 交回合失败要喊出来 */ if (W.console && W.console.error) W.console.error('[交回合] 失败：', err); }
        });
      };
      wo.__hsNarrated = true;
      W.opponentTurn = wo;
    }
  }

  /* 兼容旧名：牌堆抽空时的洗回包在 wrapTurnNarration 里了 */
  function wrapDrawers() { wrapTurnNarration(); }

  /* ---- 敌方的**手牌与抽牌**（用户 2026-10-02 决定加，属于规则改动）----------------
     上游的敌方**没有手牌**：`computerDeck.cards` 既是牌堆、也是它的出牌池 ——
     所以它"抽牌"这件事在结构上不存在（见 变更清单 D9b）。
     要让它抽牌，就得给它一只手，这只手由我们这一层持有：`enemyHand`。
       · 抽牌：回合开始时从牌堆顶挪一张进手牌（并叙述）；
       · 出牌：`computerCardPlace` 只认 `computerDeck.cards`，所以调用期间
               **临时把手牌顶上这个位置**，让它照原样挑（费用匹配优先），
               挑走的那张自然从手牌里消失 —— 上游的判定一个字没改；
       · 手上没牌：**不调用**它，等于这回合不出牌（这正是"手上没牌就打不出"该有的样子）。
     ⚠ 这是规则改动：敌方从此可以攒牌打，长期看比原来稍强 —— 难度档位可能要重看。 */
  var enemyHand = [];
  var enemyNameQueue = [];

  function enemyDeckCards() {
    try { return (typeof computerDeck !== 'undefined' && computerDeck) ? computerDeck.cards : null; }
    catch (e) { return null; }
  }

  function drawForEnemy(n) {
    var deck = enemyDeckCards();
    if (!deck) return 0;
    var got = 0;
    for (var i = 0; i < n; i++) {
      if (!deck.length) break;              // 牌堆空了就不再抽（洗回由 refillIfEmpty 负责）
      enemyHand.push(deck.shift());
      got++;
    }
    return got;
  }

  function wrapComputerPlace() {
    var up = W.computerCardPlace;
    if (typeof up !== 'function' || up.__hsNamed) return;
    var wrapped = function () {
      refillIfEmpty();                 // 上游牌空时 `cards[0]` 会炸；顺带兑现"无疲劳"那条规则
      var real = enemyDeckCards();
      if (!real) return;
      /* 手上没牌 → 这回合不出牌。注意上游的 `computerCardPlace` 在空池上会
         `cards[0].getComputerHTML()` 直接抛错，所以这里必须拦住。 */
      if (!enemyHand.length) return;
      var before = enemyHand.slice();
      var out;
      try {
        computerDeck.cards = enemyHand;          // 临时把"手牌"顶到出牌池的位置
        out = up.apply(this, arguments);
      } finally {
        computerDeck.cards = real;               // 立刻还原，别让别处读到半截状态
      }
      /* 谁从手牌里消失了 = 刚打出的那张（顺手把名字记下，给悬停预览用） */
      var left = enemyHand.slice();
      for (var i = 0; i < before.length; i++) {
        if (left.indexOf(before[i]) < 0) enemyNameQueue.push(before[i]['name']);
      }
      /* ★ 第 2 期：把这次上场叙述出来（决策没动，只是事后补演出） */
      try { narrateDeploy(); } catch (err) { /* 演出出错不该影响出牌 */ }
      return out;
    };
    wrapped.__hsNamed = true;
    W.computerCardPlace = wrapped;
  }

  /* 刚上场的那张敌方卡（棋盘的最后一个子节点）。敌方的手牌看不见，
     所以用**敌方英雄**当"对面出了张牌"的锚点 —— 立体视角下它就在桌子对面，很好读。 */
  function narrateDeploy() {
    if (!W.HS_PIPELINE || !W.HS_PIPELINE.present) return;
    var board = boardOf('enemy');
    var card = board && board.lastElementChild;
    if (!card || !card.classList || !card.classList.contains('cardinplay')) return;
    /* 同样只**存清单**，不立刻演 —— 它会在敌方回合结束后按序播（见 pendingEnemy） */
    queueEnemy({
      verb: 'deploy', from: d.getElementById('opposinghero'), to: card, toKind: 'slot', label: '上场',
    });
  }

  /* 敌方**抽牌**：上游**没有这一步**（`opponentTurn` 里没有任何 shift，牌堆只在
     `computerCardPlace` 打出牌时才变小）。所以这里**不再有一个"盯牌堆长度"的观察器** ——
     上一版那个把"打出一张牌"误报成了"抽一张牌"，一次出牌会同时报 draw + deploy。
     玩家侧的抽牌是有确切入口的（见 wrapTurnNarration 包住的 playerTurn）。 */

  /* 退场叙述的接线：给 `Element.prototype.remove` 加一层**旁听**。
     ⚠ 只在场上的卡被移除时动手（克隆一份去演退场），**绝不取消或拖延真正的移除** ——
       上游的状态变化照旧立刻发生。这一层出错也只是没动画，不会影响规则。 */
  function wrapRemoval() {
    var proto = W.Element && W.Element.prototype;
    if (!proto || typeof proto.remove !== 'function' || proto.remove.__hsGhosted) return;
    var up = proto.remove;
    var wrapped = function () {
      try {
        if (this.classList && this.classList.contains('cardinplay') && this.parentNode) {
          if (this.__hsNoGhost) return up.apply(this, arguments);   // 登场失败被撤回的卡：不演退场
          var hp = this.children[1] && this.children[1].children[0];
          var n = hp ? parseInt(String(hp.textContent || '').trim(), 10) : NaN;
          if (W.HS_PIPELINE && W.HS_PIPELINE.anim && W.HS_PIPELINE.anim.ghost) {
            W.HS_PIPELINE.anim.ghost(this, { dead: !isNaN(n) && n <= 0 });
          }
        }
      } catch (err) { /* 旁听失败绝不能影响移除 */ }
      return up.apply(this, arguments);
    };
    wrapped.__hsGhosted = true;
    proto.remove = wrapped;
  }

  /* ---- 敌方行动：**先全部走完，再按清单播**（用户 2026-10-02 纠正的核心）------------
     管线不是"边发生边演"。正确顺序是（方案 §三 / 那篇文章）：**规则瞬间算完 → 得到行动清单
     → 按清单依次播**。所以敌方的叙述要**先存进清单**，等它整个回合结束（上游最后一定会
     调用 `playerTurn()`，那就是边界）再一次性交给演出队列。
     这样带来两件好处：
       · 顺序由我们定（回合开始 → 抽牌 → 上场 → 攻击 → 退场），不再被上游的 setTimeout 牵着走；
       · 演出开始的那一刻就**拿住锁**，玩家在看完之前动不了 —— 所以"画面比状态晚"这件事
         （状态早已算完、动画是回放）不会造成任何操作错乱。 */
  var pendingEnemy = [];

  /* ---- 敌方这一回合的**前后快照**：用来在回放里补出「攻击」--------------------------
     为什么需要反推：上游 AI 的伤害是**直接往 DOM 文本上写**的（方案 §8.2），
     拿不到"谁打了谁"。所以取整回合的前后两帧，按**血量变化**认：
       · 两只单位互相掉血、且数值正好等于对方的攻击力 → 它们对打了一架；
       · 我方英雄掉血 → 按伤害值在敌方单位里找攻击力相等的那只（并列取第一个）。
     这是**第 3 期规划器到位前的临时手段**：规划器能直接给出"谁打谁"，就不必反推。
     ⚠ 反推只能还原"打架"，还原不了顺序与同时性 —— 所以清单里把攻击排在
       抽牌/上场之后统一播；真正的顺序要等规划器。 */
  function snapTurn() {
    var list = [];
    var nodes = d.querySelectorAll('.board .cardinplay');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var hp = el.children[1] && el.children[1].children[0];
      var atk = el.children[0] && el.children[0].children[0];
      list.push({
        el: el,
        hp: parseInt(String(hp && hp.textContent || '').trim(), 10) || 0,
        atk: parseInt(String(atk && atk.textContent || '').trim(), 10) || 0,
        enemy: el.classList.contains('computer-cardinplay'),
      });
    }
    var ph = heroNode('playerhero'), eh = heroNode('opposinghero');
    return {
      list: list,
      playerHero: ph ? (parseInt(String(ph.textContent).trim(), 10) || 0) : 0,
      enemyHero: eh ? (parseInt(String(eh.textContent).trim(), 10) || 0) : 0,
    };
  }

  function inferAttacks(before, after) {
    var acts = [];
    if (!before || !after) return acts;
    var findBefore = function (el) {
      for (var i = 0; i < before.list.length; i++) if (before.list[i].el === el) return before.list[i];
      return null;
    };
    var drops = [];
    for (var i = 0; i < after.list.length; i++) {
      var a = after.list[i], b = findBefore(a.el);
      if (!b) continue;
      if (b.hp - a.hp > 0) drops.push({ el: a.el, enemy: a.enemy, atk: a.atk, drop: b.hp - a.hp, used: false });
    }
    /* ① 单位互殴 */
    for (var x = 0; x < drops.length; x++) {
      for (var y = 0; y < drops.length; y++) {
        if (x === y || drops[x].used || drops[y].used) continue;
        if (drops[x].enemy === drops[y].enemy) continue;
        if (drops[y].drop === drops[x].atk && drops[x].drop === drops[y].atk) {
          var e = drops[x].enemy ? drops[x] : drops[y];
          var p = drops[x].enemy ? drops[y] : drops[x];
          acts.push({ verb: 'attack', from: e.el, to: p.el, toKind: 'unit', delta: { hp: -e.atk } });
          e.used = true; p.used = true;
        }
      }
    }
    /* ② 打我英雄（它自己不掉血，所以只能按伤害值反找） */
    var myDrop = before.playerHero - after.playerHero;
    if (myDrop > 0) {
      var foes = [];
      for (var z = 0; z < after.list.length; z++) if (after.list[z].enemy) foes.push(after.list[z]);
      var who = null;
      for (var w = 0; w < foes.length; w++) if (foes[w].atk === myDrop) { who = foes[w].el; break; }
      if (!who && foes.length) who = foes[0].el;
      if (who) {
        acts.push({ verb: 'attack', from: who, to: d.getElementById('playerhero'), toKind: 'player', delta: { hp: -myDrop } });
      }
    }
    return acts;
  }

  var enemyTurnBefore = null;

  function queueEnemy(action) {
    if (action && action.to && action.to.isConnected === false) return;   // 已经离场的元素就别演了
    pendingEnemy.push(action);
  }

  function flushEnemy() {
    var list = pendingEnemy.slice();
    pendingEnemy.length = 0;
    if (!list.length || !W.HS_PIPELINE || !W.HS_PIPELINE.present) return list.length;
    for (var i = 0; i < list.length; i++) W.HS_PIPELINE.present(list[i]);
    return list.length;
  }

  /* ---- 英雄血量的**旁听**（C2/C6）----
     上游对英雄的伤害与治疗（AI.js、card_effects.js）都是**直接往血量的 DOM 文本上写**，
     没有入口可包装。所以这里盯那两个文本：变少 = 受击（闪红 + 飘负数），变多 = 治疗（飘绿）。
     纯旁听：只加反馈，不参与结算（真正扣血的是上游，我们只是看见它发生了）。
     ⚠ 换血的那一下也属于"敌方回合的动作" —— 但它是**结果**，第 3 期用整回合快照对差
       统一收进清单（见文件顶部 动画管线清单.md B7）；现在先即时反馈，不排进队列。 */
  var heroHP = {};

  /* ⚠ 两个英雄的血量**结构不一样**（上游 index.html 如此）：
       敌方：<div class="cardinplay" id="opposinghero"><div><div></div></div><div><div class="opposingHeroHealth">30</div></div></div>
       我方：<div class="cardinplay" id="playerhero"><div></div><div class="playerHeroHealth">30</div></div>
     也就是 `children[1].children[0]` 只对敌方成立；我方 `children[1]` 本身就是那个文本节点。
     第一版按敌方那种写法取，玩家侧永远拿到 undefined —— 旁听于是静默失效。 */
  function heroNode(id) {
    var hero = 找id(id);
    if (!hero || !hero.children[1]) return null;
    var lvl1 = hero.children[1];
    return lvl1.children.length ? lvl1.children[0] : lvl1;
  }

  function watchHeroes() {
    if (!W.setInterval) return;
    var step = function () {
      [['playerhero', '我方'], ['opposinghero', '敌方']].forEach(function (pair) {
        var node = heroNode(pair[0]);
        if (!node) return;
        var n = parseInt(String(node.textContent || '').trim(), 10);
        if (isNaN(n)) return;
        var prev = heroHP[pair[0]];
        heroHP[pair[0]] = n;
        if (prev === undefined || n === prev) return;
        if (!W.HS_PIPELINE || !W.HS_PIPELINE.present) return;
        /* 演出期间的掉血是**我们自己施加的**（在撞击那一拍），而攻击那一条已经飘过字了 ——
           旁听再报一次就是重复。所以锁着的时候不报（上游 AI 兜底那条路不锁，照报不误）。 */
        if (W.HS_PIPELINE.isLocked()) return;
        var hero = d.getElementById(pair[0]);
        if (n < prev) {
          flash(hero, 'hs-hero-hit');
          W.HS_PIPELINE.present({ verb: 'gain', to: hero, label: '−' + (prev - n) });
          if (n > 0 && n <= 8) W.HS_PIPELINE.present({ verb: 'turn', to: hero, label: pair[1] + '英雄濒死' });
        } else {
          W.HS_PIPELINE.present({ verb: 'heal', to: hero, label: '+' + (n - prev) });
          flash(hero, 'hs-hero-heal');
        }
      });
    };
    heroHP = {};
    W.setInterval(step, 400);
  }

  function flash(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;                 // 重排一次，让连击能重新触发动画
    el.classList.add(cls);
    W.setTimeout(function () { el.classList.remove(cls); }, 520);
  }
  /* ---- 结束回合按钮：**演出期间不许变绿**（用户 2026-10-02）--------------------------
     上游在 `playerTurn()` 里把它刷成绿色 + `END TURN`，那是"你可以动了"的信号。
     但演出还没播完的时候就被刷绿，玩家会以为能操作（实际被锁挡着）。
     所以这里让按钮**跟着锁走**：锁着一律灰 + `ENEMY TURN`；解锁后不插手（交给上游）。 */
  /* 敌方是否正在行动（回合 + 它的全部演出）。用户 2026-10-02 把规则说得很清楚：
     **只要敌方的行动动画不在播，那就是我的回合，按钮就一直绿；
       我按下之后变灰，直到对方所有演出播完、我又能动了，再变绿提醒我。**
     所以按钮只有两态，判据就是这个标记 —— 不看我方自己的演出是否在播
     （我方演出期间它照样是绿的）。 */
  var enemyBusy = false;
  var endTurnState = '';

  function setEnemyBusy(v) {
    enemyBusy = !!v;
  }

  function watchEndTurnButton() {
    if (!W.setInterval) return;
    W.setInterval(function () {
      var et = 找id('endturn');
      if (!et) return;
      var want = enemyBusy ? 'enemy' : 'mine';
      if (want === endTurnState) return;
      endTurnState = want;
      /* ⚠ 不要拿 `et.style.backgroundColor` 跟 '#4ce322' 比：CSSOM 会规范化成
         `rgb(76, 227, 34)`，那句比较永远是假、每 150ms 白写一次样式。 */
      if (want === 'enemy') { et.innerText = 'ENEMY TURN'; et.style.backgroundColor = 'grey'; }
      else { et.innerText = 'END TURN'; et.style.backgroundColor = '#4ce322'; }
    }, 150);
  }

  /* ==================== 模块体检 + 兜底回合机 ====================
     ⚠ 2026-10-05（批次 D）之后，这一段的**对象变了**：`index.js` / `attack.js` /
     `elementsController.js` 已经被整个删除，回合与胜负换成 `游戏/回合.js`。
     所以"上游那几个函数在不在"不再是问题 —— 真正要盯的是：
       ① **我们的模块装齐了吗**（缺哪个模块，"点了没反应"就有了解释）；
       ② **回合那几个出口还是我们的吗**（有没有人又把它们换回别人的实现）。
     兜底回合机的价值也变了：以前是"上游 index.js 加载期抛错 → 整段中断"的保底；
     现在是"`游戏/回合.js` 没装上"的保底 —— 同样宁可"敌方不出牌但你能继续打"。 */
  function 模块体检() {
    var 模块 = ['HS_TURN', 'HS_MENU', 'HS_UI', 'HS_RESOURCE', 'HS_PIPELINE', 'HS_STATE', 'HS_CHECK', 'HS_CARD'];
    var 缺 = 模块.filter(function (k) { return !W[k]; });
    /* 回合那几个出口必须**仍然是我们的**；界面层的叙述包装（带 __hsNarrated）是设计如此，不算被换掉 */
    var 我们的 = {
      startGame: W.HS_TURN && W.HS_TURN.开局发牌,
      playerTurn: W.HS_TURN && W.HS_TURN.我方回合开始,
      opponentTurn: W.HS_TURN && W.HS_TURN.结束回合,
      computerCardPlace: W.HS_TURN && W.HS_TURN.敌方出一张,
      updateDeckCount: W.HS_TURN && W.HS_TURN.牌库计数,
      attack: W.HS_TURN && W.HS_TURN.刷可攻击,
    };
    var 被换 = Object.keys(我们的).filter(function (k) {
      var f = W[k];
      if (!f || f === 我们的[k]) return false;
      /* 界面层自己包的那些（叙述包装 wo/wp、敌方出牌的 __hsNamed、攻击绑定的 __hsOnce）
         **包在我们的上面**是设计如此，不算"被别人换掉"。 */
      if (f.__hsNarrated || f.__hsNamed || f.__hsOnce || f.__hsOurs) return false;
      return true;
    });
    return {
      模块: (模块.length - 缺.length) + '/' + 模块.length,
      缺: 缺,
      回合出口是我们的: 被换.length === 0,
      被换掉的: 被换,
    };
  }
  /* 兜底"开始我方回合"：涨法力、抽牌、清状态。只走我们自己的层。 */
  function 兜底开始我方回合() {
    try {
      hideMask();
      setEnemyBusy(false);
      回合结束回复('enemy');
      清攻击过标记('player');
      var 上 = (W.HS_RESOURCE && W.HS_RESOURCE.上限) ? (W.HS_RESOURCE.上限() || 1) : 1;
      var 新 = Math.min(10, 上 + 1);
      if (W.HS_RESOURCE && W.HS_RESOURCE.设上限) { W.HS_RESOURCE.设上限(新); W.HS_RESOURCE.设法力(新); }
      抽一张('player');
      提交场面('兜底回合开始');
      if (W.HS_STATE) W.HS_STATE.展示追到();
    } catch (e) { 报(4, 'ATOMIC_VIOLATION', { 兜底回合失败: String(e && e.message) }, '严重'); }
  }
  function 装兜底回合钮() {
    if (W.HS_TURN && typeof W.HS_TURN.结束回合 === 'function') return false;   // 我们的回合机在：不插手
    var et = 找id('endturn');
    if (!et || et.__hsFallback) return false;
    et.__hsFallback = true;
    et.addEventListener('click', function () {
      setEnemyBusy(true);
      报(4, 'ATOMIC_VIOLATION', { 兜底: '回合一族没装上，用兜底推进', 体检: 模块体检() }, '严重');
      W.setTimeout(兜底开始我方回合, 600);
    });
    return true;
  }
  W.HS_兜底回合 = { 体检: 模块体检, 装: 装兜底回合钮, 开始我方回合: 兜底开始我方回合 };
  /* 装兜底回合钮的**时机**：等我们的回合模块绑完（它自己也在载入期与稍后各绑一次）。
     这里最多试 20 次（每 500ms）：`opponentTurn` 一出现就作罢，一直不出现就装上我们的兜底。 */
  (function 试装兜底() {
    var 次 = 0;
    (function 试() {
      次++;
      if (typeof W.opponentTurn === 'function') return;       // 上游在，收工
      if (装兜底回合钮()) return;                              // 装上了，收工
      if (次 < 20 && W.setTimeout) W.setTimeout(试, 500);
    })();
  })();

  /* ★★ 上游的 `attack()` 每次调用都会**再绑一遍** mousedown ---------------------------------
     它的写法是 `document.querySelectorAll('.cardinplay').forEach(e => e.addEventListener('mousedown', ...))`，
     而 `attack()` 在我方**每个回合开始**都会被调用一次 —— 于是英雄与场上卡会累积监听器：
     回合越往后，同一次攻击被上游处理器的**次数越多**，伤害就会多算
     （用户 2026-10-03 报的"3 点攻击打出 4 点伤害"）。
     所以第二次起不再调它，只手工补它每回合该做的那部分（canAttack 与绿光）—— 语义不变、
     绑定只发生一次。 */
  function wrapAttackBinding() {
    var up = W.attack;
    if (typeof up !== 'function' || up.__hsOnce) return;
    var bound = false;
    var wrapped = function () {
      if (!bound) {
        bound = true;
        /* 上游这一次调用会给"此刻在场的卡"绑上它自己的攻击处理器 —— 我们**不再管它**：
           攻击结算已经是我们自己的（见 应用一次攻击），而我们又在 onDown 的捕获阶段
           把"我方单位"与"敌方目标"上的 mousedown 都吃掉了，所以上游那个处理器
           永远不会拿到一次能结算的点击。这里保留 `up.apply` 只为了它顺带做的
           `canAttack` 绿光那一部分（我们靠这个类判断"这个单位本轮能不能打"）。 */
        return up.apply(this, arguments);
      }
      /* ⚠ **只在我方回合开始那一刻**补刷 canAttack —— 之前写成"每次调用都刷"，
         结果把**已经攻击过**的单位又刷成可攻击，于是同一个单位一回合能连打好几次
         （用户 2026-10-03 报的"2 个单位攻击了 3 次"）。回合开始的标记由 wp 设置。 */
      if (!atTurnStart) return;
      atTurnStart = false;
      try {
        var units = d.querySelectorAll('.player-cardinplay');
        for (var i = 0; i < units.length; i++) {
          if (units[i].classList.contains('canAttack')) continue;   // 已经能打的不重复刷（它不是本轮上场的）
          units[i].classList.add('canAttack');
          units[i].style.boxShadow = '0px 2px 15px 12px #0FCC00';
        }
      } catch (err) { if (W.console && W.console.error) W.console.error('[attack 补刷] 失败：', err); }
    };
    wrapped.__hsOnce = true;
    W.attack = wrapped;
  }

  /* 我方回合开始（`wp` 里在调用上游 playerTurn 之前置位）：`attack()` 只在这时补刷可攻击状态 */
  var atTurnStart = false;

  function stampName(side, el) {
    if (!el || el.__hsName !== undefined) return;
    /* ⚠ **认不出名字时不要把空串写上去**：写上去就等于"已定名"，之后哪怕名字到了
       （敌方那条路的名字是**异步**才凑齐的）也再没机会补 —— 卡会永远认不出自己是谁，
       挂不上体力徽章、打人也不付体力。所以这里只在**真的拿到名字**时才落笔。 */
    var 名 = (side === 'player') ? (W.getNameOfElement || '') : (enemyNameQueue.shift() || '');
    if (名) el.__hsName = 名;
  }

  /* ==================== ⑧ 视角：平铺 / 斜向立体 ==================== */

  /* 视角是**纯表现层**的东西：一个类名（`#game.view-tilt`）+ 一组 CSS 变量。
     倾斜、桌面网格、立牌、敌将搬去桌子对面，全部在 ours.css 的「视角层」那一段里；
     这里只负责切类名、存偏好、维护按钮文字。
     （为什么不用 three.js 做真 3D：见 ours.css 视角层开头那段说明 ——
      离线 + 将来要压进 MMD 卡 + 命中测试/拖放已经稳定，重写渲染层不划算。） */
  var VIEW_KEY = 'hsw_view_v1';
  var view = 'flat';

  function applyView(v) {
    var g = stage();
    if (!g) return view;
    view = (v === 'tilt') ? 'tilt' : 'flat';
    g.classList.toggle('view-tilt', view === 'tilt');
    var b = d.getElementById('hs-view');
    if (b) b.textContent = (view === 'tilt') ? '立体视角' : '平铺视角';
    return view;
  }

  function setView(v) {
    applyView(v);
    try { W.localStorage.setItem(VIEW_KEY, view); } catch (e) { /* 隐私模式等，忽略 */ }
    return view;
  }

  function toggleView() { return setView(view === 'tilt' ? 'flat' : 'tilt'); }

  function initView() {
    var want = null;
    try { want = W.localStorage.getItem(VIEW_KEY); } catch (e) { /* 同上 */ }
    // `?view=tilt` 优先：方便直接给一条链接看效果（也方便自动验图）
    var q = /[?&]view=([a-z]+)/.exec((W.location && W.location.search) || '');
    if (q) want = q[1];
    applyView(want === 'tilt' ? 'tilt' : 'flat');
  }

  /* ============================ 接线 ============================ */

  function boot() {
    buildTable();
    buildRows();
    buildChrome();
    buildOverlays();
    fitStage();
    initView();
    snapshotDecks();
    盯手牌();               // ★ 手牌排布（10 张要排得下，见 排手牌）
    syncSlots();
    /* ★ 必须在第一次 attack() 之前装 —— 第一次调用是 外壳.js 的 enterFight 里那次
       （进对局后 ~1s），远晚于本脚本装载。装晚了就抓不到上游那个处理器了。 */
    wrapDrawers();          // 回合叙述（回合开始判断 → 抽牌 → 行动）+ 洗回兜底
    wrapComputerPlace();
    wrapRemoval();          // 退场叙述（旁听 remove，不改规则）
    wrapAttackBinding();    // 上游 attack() 每回合重复绑监听 → 改成只绑一次（伤害别翻倍）
    watchHeroes();          // 英雄受击/治疗的旁听（C2/C6）
    watchEndTurnButton();   // 演出期间结束回合键保持灰（不许提前变绿）

    /* 指针离开画布就收掉悬停预览（面板本身 pointer-events:none，不会自触发离开） */
    var g0 = stage();
    if (g0) g0.addEventListener('mouseleave', function () { hoverUnit = null; hidePreview(); }, false);

    d.addEventListener('mousedown', guard(onDown), true);
    d.addEventListener('mousemove', guard(onMove), false);
    d.addEventListener('mouseup', guard(onUp), false);
    d.addEventListener('click', onClick, false);
    d.addEventListener('mousedown', onRightDown, false);
    d.addEventListener('keydown', onKeyDown, true);
    d.addEventListener('dragstart', onDragStart, true);
    W.addEventListener('resize', fitStage, false);

    ['player', 'enemy'].forEach(function (side) {
      var board = boardOf(side);
      if (!board || !W.MutationObserver) return;
      new W.MutationObserver(syncSlots).observe(board, { childList: true });
    });
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* ==================== 自检：把"已经谈定的东西"变成可执行断言 ====================
     为什么要有它：这些规则是一条一条谈出来的，而改动经常碰坏另一处 —— 靠人记（包括我）都不可靠。
     凡是能用代码描述的，都在这里断言一遍：**每次构建后跑一次 `HS_INTERACT.check()`**，
     红了就是"又丢东西了"，而不是等你从画面上看出来。
     逐条对应的需求、落点、状态见同目录 `变更清单.md`。 */
  function check() {
    var fail = [], pass = 0;
    function ok(name, cond, detail) {
      if (cond) pass++; else fail.push(name + (detail ? '（' + detail + '）' : ''));
    }
    /* 样式表里有没有这条规则（按选择器文本找，能抓到"规则被删/被注释掉"这类静默失效） */
    function css(sel) {
      var sheets = d.styleSheets || [];
      for (var i = 0; i < sheets.length; i++) {
        var rules; try { rules = sheets[i].cssRules; } catch (e) { continue; }
        if (!rules) continue;
        for (var j = 0; j < rules.length; j++) {
          if (rules[j].selectorText && rules[j].selectorText.indexOf(sel) >= 0) return true;
        }
      }
      return false;
    }
    function R(el) { return el ? el.getBoundingClientRect() : null; }

    var g = stage(), t = table();
    /* ★ 沙盒口径（2026-10-03）：这个自检是**独立网页**那一版的验收 —— 有几条在沙盒舞台里
       没有意义（脚本由平台按规则注入，没有 `?v=` 版本号；舞台是平台给的容器，
       尺寸与"视口坐标系"的关系不同；主页面盖在棋盘上是**设计如此**）。所以这里先问一句。 */
    var 沙盒 = !!(W.HS_SANDBOX && typeof W.HS_SANDBOX.有SDK === 'function' && W.HS_SANDBOX.有SDK());
    /* ★ 还有一个"未开局"口径：主页面开着的时候 `#contents` 是隐藏的，`#game` 宽高为 0 ——
       这时候去断言"舞台 1208 宽""落点半透明红框"都是没意义的（不是坏，是还没进对局）。 */
    var 未开局 = (function () {
      var c = d.getElementById('contents');
      return !!c && getComputedStyle(c).visibility === 'hidden';
    })();
    if (!未开局) {
      ok('① 舞台存在（1208 宽设计画布）', !!g && R(g).width > 0);
    }
    ok('② 战场图层 #hs-table 存在', !!t);
    if (t) {
      ok('③ 图层里有两块棋盘', t.querySelectorAll('.board').length === 2);
      ok('④ 图层里有两排部署位', t.querySelectorAll('.hs-row').length === 2);
    }
    var row = d.getElementById('hs-slots-player');
    if (row && row.children.length) {
      ok('⑤ 每排的格数 = 本局部署位（关卡 1→5 / 自由关 1·3·5）',
         row.children.length === SLOT_COUNT, '本局 ' + SLOT_COUNT + ' 格');
      /* ⚠ 这里量的是 **offsetWidth/Height（布局尺寸）**，不是 getBoundingClientRect：
         立体视角下后者给的是投影后的尺寸（实测同一格 150×124 会量成 227×96），
         拿它算比例必然误报。和 cellLeft 踩的是同一个坑。 */
      var w0 = row.children[0].offsetWidth, h0 = row.children[0].offsetHeight;
      if (w0 && h0) {
        var ratio = w0 / h0;
        ok('⑥ 格子宽高比 251:207', Math.abs(ratio - 251 / 207) < 0.06, '实测 ' + ratio.toFixed(3));
      }
      /* ⑦ 只比两格以上才有意义（1 格那关没有"同排相邻"可比）。
         ⚠ 与 ⑤⑥ 同一条坑（2026-10-04 抓到一次真实误报）：**不要拿 getBoundingClientRect 比相邻格**。
           立体视角是有透视的，投影后的外接矩形（AABB）本来就会互相压一点 ——
           实测同一排 5 格的投影宽度是 161/150/139/139/150（两侧被"拉近"所以更宽），
           于是"格0.right > 格1.left"，看着像重叠，其实布局上稳稳 12px 间距。
           判据改成**布局坐标**（offsetLeft/offsetWidth，不受 transform 影响）。 */
      if (SLOT_COUNT >= 2) {
        var c0 = row.children[0], c1 = row.children[1];
        var 间距 = c1.offsetLeft - (c0.offsetLeft + c0.offsetWidth);
        ok('⑦ 同排格子在布局上不重叠（命中判定依赖它）', 间距 >= 0,
           '相邻两格间距 ' + 间距 + 'px（格0 ' + c0.offsetLeft + '+' + c0.offsetWidth +
           '，格1 起点 ' + c1.offsetLeft + '）');
      }
    }
    /* ⚠ ⑧ 原为"敌方名字贴着自己的英雄框" —— 2026-10-05 起**双方名字标签整个删掉**
       （用户："左上角还有玩家 vs 对方的字样，那个没有存在必要，删除"），这条断言随之取消。
       英雄框本身的相对位置由 ⑧′ 继续盯着（不依赖标签）。 */
    var hb = R(d.querySelector('.opponenthero')), ha = R(d.querySelector('.playerhero'));
    if (!沙盒) {
      ok('⑧′ 双方英雄框都搬进了 #game（预览与右栏的层叠要靠这一点）',
         !!hb && !!ha && hb.width > 0 && ha.width > 0);
    }
    var phr = R(d.querySelector('.playerHeroHealth')), phb = R(d.querySelector('.playerhero'));
    ok('⑨ 我方血量在英雄框内（不越到下沿之外）',
       !!phr && !!phb && phr.top >= phb.top - 1 && phr.bottom <= phb.bottom + 1);
    var ld = d.getElementById('load');
    /* 没有载入层 = 它当然没盖住任何东西（沙盒里 `#load` 由上游脚本按需创建，可能压根不存在） */
    ok('⑩ 载入层已摘除（否则所有命中测试被它盖住）', !ld || getComputedStyle(ld).display === 'none');
    var ar = d.getElementById('hs-arrow');
    /* ⑪ 在沙盒里跳过：箭头挂在 body 上这一点没变，但舞台是平台容器、视口坐标系的判据不适用。 */
    if (!沙盒) {
      ok('⑪ 拖拽箭头活在视口坐标系（fixed / 挂在 body 上）',
         !!ar && getComputedStyle(ar).position === 'fixed' && ar.parentElement === d.body);
    }
    ensureHead();          // 这个尖是懒创建的（第一次选中单位时才补），断言前先确保它存在
    ok('⑫ 上游虚线上补着我们的箭头尖', !!d.getElementById('svgpath') && !!d.getElementById('hs-arrowhead'));
    var pv = d.getElementById('hs-preview');
    ok('⑬ 预览面板在结束回合按钮之上（z-index > 50）',
       !!pv && parseInt(getComputedStyle(pv).zIndex, 10) > 50, pv ? getComputedStyle(pv).zIndex : '无');
    ok('⑭ 预览面板有左右换边两组规则',
       css('#hs-preview.side-left') && css('#hs-preview.side-right'));
    /* ⚠ 三条样式检查改成**行为检查**（加类 → 读计算值 → 还原），不再扫 `document.styleSheets`。
       原因：用户沙盒里 `styleSheets/cssRules` 的访问受限，扫规则的那版在那里全部误报
       （导出里 ⑭⑱㉑ 三条红，而样式其实是好的）。行为检查与环境无关。 */
    var pv2 = d.getElementById('hs-preview');
    if (pv2) {
      var savedCls = pv2.className;
      pv2.className = 'on side-left';
      var leftOn = getComputedStyle(pv2).left;
      pv2.className = 'on side-right';
      var rightOn = getComputedStyle(pv2).right;
      pv2.className = savedCls;
      ok('⑭ 预览面板左右换边有效（side-left/right 各自生效）',
         leftOn !== 'auto' && rightOn !== 'auto', 'left=' + leftOn + ' right=' + rightOn);
    } else {
      ok('⑭ 预览面板左右换边有效（side-left/right 各自生效）', false, '没有 #hs-preview');
    }
    var vw = d.getElementById('hs-view');
    ok('⑮ 视角开关在右栏（absolute，与设置键同排）',
       !!vw && getComputedStyle(vw).position === 'absolute');
    ok('⑯ 桌布是纯色（没有方格纹理）',
       !/repeating-linear-gradient/.test(getComputedStyle(t || d.body, '::before').backgroundImage));
    var mk = d.getElementById('hs-mask');
    /* ⑰⑱ 合成一条：不带 .on 时不显示、带上 .on 时显示 —— 这才是蒙版真正要做的事 */
    if (mk) {
      var hadOn = mk.classList.contains('on');
      mk.classList.remove('on');
      var hidesWhenOff = getComputedStyle(mk).display === 'none';
      mk.classList.add('on');
      var showsWhenOn = getComputedStyle(mk).display !== 'none';
      if (!hadOn) mk.classList.remove('on');
      ok('⑰ 蒙版不带 .on 时不显示', hidesWhenOff);
      ok('⑱ 蒙版带上 .on 时显示', showsWhenOn);
    } else {
      ok('⑰ 蒙版不带 .on 时不显示', false, '没找到 #hs-mask');
      ok('⑱ 蒙版带上 .on 时显示', false, '没找到 #hs-mask');
    }
    ok('⑱ 蒙版有 .on 显示规则', css('#hs-mask.on'));
    /* ⚠ 这里不查 `#hs-fx`：那个图层是**懒创建**的（第一次播演出才建），
       空闲态查它必然误报。查 API 就位即可。 */
    ok('⑲ 演出管线 API 就位（attack / deploy / draw 三条配方）',
       !!W.HS_PIPELINE && ['attack', 'deploy', 'draw'].every(function (v) {
         return W.HS_PIPELINE.recipes.indexOf(v) >= 0;
       }) && typeof W.HS_PIPELINE.log === 'function');
    ok('⑳ 演出原语齐全（箭头/运卡/冲刺/飘字/击中玩家）',
       !!W.HS_PIPELINE && ['arrow', 'flyCard', 'lungeOut', 'lungeBack', 'pop', 'heroHit']
         .every(function (k) { return typeof W.HS_PIPELINE.anim[k] === 'function'; }));
    if (!未开局) {
    ok('㉑ 不能攻击的反馈样式有效（红框抖动）', (function () {
      var probe = d.createElement('div');
      probe.className = 'cardinplay hs-cant-attack';
      probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:10px;height:10px';
      (t || d.body).appendChild(probe);
      var cs = getComputedStyle(probe);
      var good = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1;
      if (probe.parentNode) probe.parentNode.removeChild(probe);
      return good;
    })());
    }
    var tag = d.querySelector('script[src*="游戏/界面.js"]');
    /* ㉒ 沙盒里跳过：脚本是平台按规则注入的，没有 <script src="…?v="> 这回事
       （缓存由平台自己管）。这一条是"独立网页别被宿主缓存住"的保险。 */
    if (!沙盒) {
      ok('㉒ 资源带内容版本号（防止宿主缓存旧脚本）',
         /[?&]v=/.test(String((tag && tag.src) || '')));
    }
    /* ㉔ 攻击结算是**我们自己的**（用户 2026-10-03 第三轮：全面用自主规划器）。
       以前这条断言查的是"上游那个处理器有没有桥接到每一张卡" —— 那套桥接已经整段退役了：
       攻击不再补发合成 mousedown、不再依赖 `currentAttacker`、也不再给场上卡补绑上游处理器。
       现在只查"我们的结算入口在不在"。它要是没了，攻击就会退回"点了没反应"的老样子。 */
    ok('㉔ 攻击结算归我们（应用一次攻击 在位，且不再依赖上游处理器）',
       typeof 应用一次攻击 === 'function');
    /* ㉕ 瞄准线"吸附到目标边框"的几何。这个函数写过两版错：
       先漏了"起点在目标横向跨度内"的情形，又只判到"边界平面"而不是"边框线段" ——
       两版都表现为箭头尖落在卡外/卡里。全是纯数学，在这里逐例断言。 */
    (function () {
      var b = { left: 172, right: 436, top: 255, bottom: 356 };
      var cx0 = 304, cy0 = 305;
      function 在边框线段上(p) {
        if (!p) return false;
        return (Math.abs(p.y - b.top) < 0.6 && p.x >= b.left - 0.6 && p.x <= b.right + 0.6) ||
               (Math.abs(p.y - b.bottom) < 0.6 && p.x >= b.left - 0.6 && p.x <= b.right + 0.6) ||
               (Math.abs(p.x - b.left) < 0.6 && p.y >= b.top - 0.6 && p.y <= b.bottom + 0.6) ||
               (Math.abs(p.x - b.right) < 0.6 && p.y >= b.top - 0.6 && p.y <= b.bottom + 0.6);
      }
      var 例 = [['正下', 304, 468], ['正上', 304, 100], ['正左', 40, 305], ['正右', 600, 305],
                ['左下', 60, 500], ['右上', 560, 120]];
      var 坏 = [];
      for (var i = 0; i < 例.length; i++) {
        var p = edgePoint(b, 例[i][1], 例[i][2], cx0, cy0);
        if (!在边框线段上(p)) 坏.push(例[i][0]);
      }
      ok('㉕ 瞄准线端点落在目标边框线段上（六个方位）', 坏.length === 0, '不对的：' + (坏.join('/') || '无'));
    })();
    /* ㉖ 空闲时上游那个 `currentAttacker` 必须是空的。
       它是一条**很容易被残留毒害**的全局量：敌方攻击的演出也会走同一条配方（attackRecipe），
       那条路不会走到上游"结算末尾清空"的那一句 —— 于是敌方打完一次，就把一个**敌方的卡 id**
       留在里面；下一次我方攻击时上游拿它 `getElementById` 得到 null 再解引用 → 在监听器里抛错 →
       **攻击静默不生效**（用户 2026-10-03 第二轮报的"经常攻击不生效"，导出的 lastStrike 里
       `落地:false` 且 `结算时currentAttacker` 是个 `cpuCardInPlayN`）。
       修法见 演出.js 的 attackRecipe（按攻方所属**无条件覆盖**），这条断言就是它的哨兵。 */
    ok('㉖ 空闲时 currentAttacker 是空的（残留会让下一次攻击静默失效）',
       state !== 'idle' || W.currentAttacker === null || W.currentAttacker === undefined,
       '当前 state=' + state + '，currentAttacker=' + String(W.currentAttacker));
    /* ㉗ 出牌效果归我们（阶段 D）：上游那 326 行的 `cardPlaceSnds` 已被换成**读我们效果表**的执行器。
       它要是被换回去（或压根没接上），出牌就退回"只播个音效、真效果没做"的老样子。 */
    ok('㉗ 出牌效果归我们（cardPlaceSnds 已是我们的执行器）',
       !!(W.cardPlaceSnds && W.cardPlaceSnds.__hsOurs));
    /* ㉓ 新引擎（纯逻辑层）在页面里可用 —— 阶段 2 的"影子跑"就是靠它。
       它跟界面完全解耦：这里只确认"装载成功、接口在"，
       真正的规则对照在 node 里做（test_engine.mjs / test_对照.mjs），
       因为**引擎不该知道 DOM 的存在**，不该由界面来验它的规则。 */
    ok('㉓ 引擎与事件层已装载（纯逻辑，可影子跑）',
       !!W.HS_EVENT && !!W.HS_ENGINE &&
       typeof W.HS_ENGINE.reduce === 'function' && typeof W.HS_ENGINE.回放 === 'function' &&
       !!W.HS_CARDS && Object.keys(W.HS_CARDS).length >= 20);

    /* ㉙ 资源与回合归我们：法力上限的真相在 `HS_RESOURCE`，`W.manaCapacity` 只是它的缓存
       （唯一写入点）；水晶颗数必须等于上限（上限能降 —— 负面任务 −1 时上游只会加不会减，裁水晶是我们干的）。
       ⚠ 2026-10-05（批次 C/D）**这条断言的口径换过一次**：原来判的是 `W.playerTurn.__hsOurs`
       （资源层当年给上游函数打的标记）。现在回合由 `游戏/回合.js` 实现、`W.playerTurn` 是**界面层的
       叙述包装**（它没有那个标记），所以改判"回合一族在位 + 资源层认得它是我们的"。 */
    var 资 = W.HS_RESOURCE;
    if (资) {
      var 上限 = 资.上限();
      var 颗数 = d.getElementsByClassName('manabox').length;
      var 回合是我们的 = !!(W.HS_TURN && typeof W.HS_TURN.我方回合开始 === 'function');
      ok('㉙ 资源与回合归我们（HS_RESOURCE 在位 · 回合一族在位 · 上限 = 全局量 · 水晶颗数 = 上限）',
         回合是我们的 && 资.是不是我们的() &&
         W.manaCapacity === 上限 && 颗数 === 上限,
         '上限 ' + 上限 + ' / 全局 ' + W.manaCapacity + ' / 水晶 ' + 颗数 +
         ' / 回合一族 ' + (回合是我们的 ? '在' : '**不在 ✗**'));
    }

    /* ㉘ 场上卡**落在它那一格里**（用户 2026-10-03 报的"角色没对齐虚线框"）。
       做法与判据都刻意与实现解耦：**不看 cellLeft 怎么算**，直接量屏幕矩形 ——
       卡片矩形的左边缘与它那一格矩形的左边缘必须基本重合（容差 3px）。
       ⚠ 两个例外必须伺候好，否则这条会误报或空转：
         · **立体视角**下棋盘被 rotateX 且有透视，横向也会有亚像素位移 —— 那是投影的账，跳过；
         · 登场动画 `.hs-deploy`（0.3s，我们自己的）会让卡片处于缩放态，量出来又大又偏 ——
           所以先把它的动画 `finish()` 到终态再量。这是自检里的动作，跳掉一个 0.3s 的入场动画
           没有副作用；不这么做就只能"跳过动画中的卡"，而实测那样会让**每一张都跳过**
           （登录动画的 running 状态在我们量之前不会自己结束），等于这条断言空转。 */
    if (view !== 'tilt') {
      var 错位 = [];
      ['player', 'enemy'].forEach(function (side) {
        var row = d.getElementById('hs-slots-' + side);
        if (!row) return;
        for (var i = 0; i < SLOT_COUNT; i++) {
          var el = slots[side][i];
          if (!el || !el.getBoundingClientRect) continue;
          if (el.getAnimations) {
            el.getAnimations().forEach(function (a) {
              if (a.playState === 'running' && a.finish) { try { a.finish(); } catch (e) {} }
            });
          }
          var 卡 = el.getBoundingClientRect(), 格 = row.children[i] && row.children[i].getBoundingClientRect();
          if (!格) continue;
          var 偏 = Math.round(Math.abs(卡.left - 格.left));
          if (偏 > 3) 错位.push(side + '#' + i + ' 偏 ' + 偏 + 'px');
        }
      });
      ok('㉘ 场上卡与它的格子在屏幕上对齐（平铺视角，容差 3px）',
         错位.length === 0, '错位的：' + (错位.join('、') || '无'));
    }

    /* ㉚ **关键落点上没有被别的层盖住**（用户 2026-10-03 报的"无法操作了"）。
       那条报告的根因是 `#fireworkCanvas`（全屏装饰画布）在 fireworks.js 出列后
       没人把它 display:none，于是它盖住棋盘/手牌/结束回合，把点击全吃掉 ——
       而**自检当时是全绿的**：因为自检从没查过"命中测试到底落在谁身上"。
       这里补上：拿 `elementFromPoint` 问一遍几个关键落点，最上面那个必须落在目标（或它的子节点）里。
       ⚠ 采样点选在**各元素的中心**。判据分两类：
         · 真要接点击的元素（结束回合 / 手牌区 / 设置 / 任务区）：命中必须落在它自己或它的子节点里；
         · **格位**：`.hs-slot` 是 `pointer-events:none` 的装饰框（命中判定由 interact.js 按坐标算），
           所以命中落在**它那一侧的棋盘**上才是对的 —— 这也是为什么第三列写着"另一个可接受的落点"。
       这一条不追求"什么都不能盖"，它盯的是**全屏层吞点击**这一类（fireworkCanvas 那次就是）：
       任何面积超过半张舞台的、`pointer-events:auto` 的层压在关键落点上，都会在这里现形。 */
    (function () {
      var 落点 = [
        ['我方第 1 格', '#hs-slots-player .hs-slot', '.board--player'],
        ['敌方第 1 格', '#hs-slots-enemy .hs-slot', '.board--opponent'],
        ['结束回合', '#endturn', null],
        ['手牌区', '#cards', null],
        ['设置', '#hs-settings', null],
        ['任务区', '#hs-quest', null],
      ];
      var 被盖 = [];
      /* ★ 还没进局就别判这条（2026-10-04 补，一次真实误报）：
         舞台在开场/换局的那几秒是 `visibility:hidden` 的，而**隐藏元素不参与命中测试**
         —— `elementFromPoint` 会一路穿透到 body，于是每个落点都"被 body 盖住"，看着像全红。
         判据取"#contents 可见 + #game 有面积"，与检错层那条 `在局里` 同一个口径。 */
      var 舞台在 = (function () {
        var c = d.getElementById('contents'), gm = d.getElementById('game');
        if (!c || !gm) return false;
        try {
          if (getComputedStyle(c).visibility === 'hidden') return false;
          var b = gm.getBoundingClientRect();
          return b.width > 0 && b.height > 0;
        } catch (e) { return true; }
      })();
      /* ★ 模态例外：我们的主页面 / 图鉴 / 开始游戏面板 / 关卡浮层是**故意**盖住棋盘的
         （那是"还没开局"或"在看图鉴"的状态）。它们开着的时候，这一条不该报红（沙盒里尤其常见：
         装上卡先看到的就是主页面）。模态一关，这条照旧盯着"别人偷偷盖住战场"。 */
      var 模态开 = ['hs-mainmenu', 'hs-codex', 'hs-start', 'campaign-overlay', 'gamemenu'].some(function (id) {
        var e = 找id(id);
        if (!e) return false;
        var cs = getComputedStyle(e);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
      });
      for (var i = 0; i < 落点.length && !模态开 && 舞台在; i++) {
        var e = d.querySelector(落点[i][1]);
        if (!e) continue;
        var r = e.getBoundingClientRect();
        if (!r.width || !r.height) continue;                   // 隐藏的元素（0 尺寸）不参与
        var top = d.elementFromPoint ? d.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)) : null;
        if (!top) continue;
        var 也行 = 落点[i][2] ? d.querySelector(落点[i][2]) : null;
        if (top === e || e.contains(top)) continue;
        if (也行 && (top === 也行 || 也行.contains(top))) continue;
        被盖.push(落点[i][0] + ' ← ' + (top.id || top.className || top.tagName));
      }
      ok('㉚ 关键落点没被别的图层盖住（点击能落在该落的地方）',
         被盖.length === 0, '被盖住：' + (被盖.join('、') || '无')
         + (模态开 ? '（当前有模态面板开着，按设计盖住战场）' : '')
         + (!舞台在 ? '（舞台还没显示：开场/换局中，本条跳过）' : ''));
    })();

    /* ㉛ 拒绝结构化（架构改进 A）：**引擎每一条拒绝都带码**，且**每个码都有中文文案**。
       为什么必须机器验：这一层是"玩家看到的提示"的唯一出处，缺一个码就会退化成「（CODE）」
       或者「这个操作不成立」—— 而"没反馈/看不懂的反馈"正是本会话反复踩的那类 bug。 */
    (function () {
      var 引擎 = W.HS_ENGINE, 文案 = W.HS_TEXT;
      if (!引擎 || !文案) { ok('㉛ 拒绝结构化（引擎码表 + 文案表都在）', false, '引擎或文案层没装上'); return; }
      /* ① 抽样：拿两个坏命令去问引擎，拒绝必须带码（且不是 UNKNOWN） */
      var 坏 = [];
      try {
        var 态 = 引擎.新建({ 种子: 1, 牌组: { p0: [], p1: [] }, 卡表: W.HS_CARDS });
        var r1 = 引擎.合法(态, { 类型: '出牌', 席位: 'p0', 手牌序号: 0 });
        if (!r1 || r1.合法 || !r1.码 || r1.码 === 'UNKNOWN') 坏.push('出牌(空手牌) → ' + JSON.stringify(r1 && r1.码));
        var r2 = 引擎.合法(态, { 类型: '这不是一个命令' });
        if (!r2 || r2.合法 || !r2.码 || r2.码 === 'UNKNOWN') 坏.push('怪命令 → ' + JSON.stringify(r2 && r2.码));
      } catch (e) { 坏.push('抽样抛错：' + e.message); }
      ok('㉛ 引擎的拒绝都带码（抽样）', 坏.length === 0, 坏.join('；'));
      /* ② 对齐：引擎码表里的**每一个码**都要能在文案表里翻出中文 */
      var 缺 = [];
      var 表 = 引擎.码表 || [];
      for (var i = 0; i < 表.length; i++) {
        var 码 = 表[i][1];
        if (!文案.有(码)) { 缺.push(码); continue; }
        var 文 = 文案.取(码, { 主动方: 'p0', 卡: '测试', 需: 4, 有: 2, 方: '我方', 后缀: '' });
        if (!文 || 文.indexOf('（' + 码 + '）') >= 0) 缺.push(码 + '(无文案)');
      }
      ok('㉛ 每个拒绝码都有中文文案（码表 ' + 表.length + ' 条）', 缺.length === 0, '缺：' + (缺.join('、') || '无'));
    })();

    /* ㉜ 决策只有一个出口（架构改进 D）：`发起决策(请求)` 是"谁该选"的唯一判断处；
       Bot 的选目标策略在**决策层**（`HS_DECIDE.选目标`，纯函数）；两边吃同一个请求形状。
       为什么必须机器验：以前"谁该选""Bot 怎么选""玩家怎么点"分散在三处，
       于是出过"敌方战吼问玩家选目标"（界面疯狂提示、玩家按不出卡）。 */
    ok('㉜ 决策只有一个出口（发起决策 + 决策层的选目标策略都在）',
       typeof 发起决策 === 'function' &&
       !!W.HS_DECIDE && typeof W.HS_DECIDE.选目标 === 'function');
    ok('㉜ 请求形状唯一（玩家/Bot 走同一个对象）',
       (function () {
         try {
           /* 空选项 → 直接返回，不进待选、不碰 DOM（所以放在自检里是安全的） */
           var r = 发起决策({
             谁: 'player', 种类: '战吼目标', 席位: 'player',
             效果: { 动作: '伤害', 目标: '任意' }, 选项: [], 上下文: { 卡名: '自检' }
           });
           return !!(r && typeof r === 'object' && (r.待定 === true || r.选择 === null));
         } catch (e) { return false; }
       })());

    /* ㉝ 全链路检错在位（层 + 码 + 聚合 + 报告），且**空闲态的运行期不变量全过**。
       最后半句是这一条的重点：它把这一周踩过的坑（残留蒙版/模态压场/锁卡住/水晶颗数与上限不符/
       骨架不全/血量元素缺/模块没装上）通通变成"随时可跑"的断言 —— 空转也跑，出事就现形。 */
    ok('㉝ 检错层在位（HS_CHECK · 报/聚合/报告/恢复）',
       !!W.HS_CHECK && typeof W.HS_CHECK.报 === 'function' && typeof W.HS_CHECK.报告 === 'function' &&
       typeof W.HS_CHECK.登记恢复 === 'function');
    if (W.HS_CHECK) {
      var 问 = W.HS_CHECK.跑不变量();
      /* ★ 演出进行中，展示层那几条**本来就不该是干净的**（这正是设计）：
         演出播着的时候展示落后于权威、"蒙版/箭头还挂着"也是对的。
         所以这里只放行**展示层**的码，其余（引擎/事件/日志/骨架/模块）照旧红 ——
         否则自检会在每次敌方回合动起来的那几秒误报三条，变成"狼来了"。
         （第一版没做这件事，实测在连打三回合时误报 PRESENTATION_LEFTOVER /
           ANIM_LOCK_STUCK / UI_WRONG_SOURCE 三条；等 15 秒演出结束再测就全绿。） */
      var 演出中 = false;
      try {
        演出中 = !!(W.HS_PIPELINE &&
          ((W.HS_PIPELINE.isLocked && W.HS_PIPELINE.isLocked()) ||
           (W.HS_PIPELINE.queueLength && W.HS_PIPELINE.queueLength() > 0)));
      } catch (e) {}
      var 展示层码 = ['PRESENTATION_LEFTOVER', 'ANIM_LOCK_STUCK', 'UI_WRONG_SOURCE',
                    'UI_CAP_MISMATCH', 'PRESENTATION_LAG_STUCK'];
      var 真问 = 问.filter(function (x) { return !(演出中 && 展示层码.indexOf(x.码) >= 0); });
      ok('㉝ 运行期不变量（空闲态）全部通过', 真问.length === 0,
         '不通过：' + (真问.map(function (x) { return x.层 + '/' + x.码; }).join('、') || '无')
         + (演出中 && 问.length > 真问.length ? '（演出进行中：展示层 ' + (问.length - 真问.length) + ' 条按设计跳过）' : ''));
    }

    /* ㉞ 输入层归一（架构改进 F）：**所有输入 → 一条意图 → 唯一出口**。
       这一条验的是"入口真的收成一处"，而且**非法意图一定会落进检错层**（不许静默丢弃）。 */
    ok('㉞ 意图层在位（执行意图 / 意图计数 / 参数校验）',
       typeof 执行意图 === 'function' && typeof 合法意图 === 'function' &&
       !!W.HS_INTERACT && typeof W.HS_INTERACT._执行意图 === 'function');
    (function () {
      var 前 = JSON.parse(JSON.stringify(意图计数));
      var 结果 = 执行意图({ 类型: '这不是一种意图' });
      var 后 = 意图计数;
      var 记了 = !!(W.HS_CHECK && W.HS_CHECK.聚合().计数['UI_INVALID_INPUT']);
      ok('㉞ 非法意图被拦下且留痕（不静默）',
         结果 && 结果.成 === false && !后['这不是一种意图'] && 记了,
         '结果=' + JSON.stringify(结果) + '，检错层记到了=' + 记了);
    })();

    /* ㉟ 权威状态 + revision（改进 B）：状态层在位、版本号在涨、**对账干净**；
       而且——最要紧的一条——**DOM 被偷改时对账必须抓到**，`追平()` 必须能按权威改回来。
       为什么这条值钱：以前"DOM 即权威"，谁改了 DOM 谁就是真相（演出、上游脚本、残留状态都在改）；
       现在有了基准，"两套真相"当场现形。 */
    ok('㉟ 权威状态层在位（HS_STATE · 提交/对账/追平）',
       !!W.HS_STATE && typeof W.HS_STATE.提交 === 'function' &&
       typeof W.HS_STATE.对账 === 'function' && typeof W.HS_STATE.追平 === 'function');
    /* ★ 「在不在局里」算一次，给㉟/㊱ 共用（2026-10-06）。
       权威状态的 revision 是**对局里才有**的：在主页面/沙盒刚装上卡时它一定是 null ——
       那几条"版本号 ≥ 1 / 对账为空 / 展示追平"此时**不该判**，否则主页面会挂一排无意义的红
       （实测：`?level=1` 之外打开时 ㉟×2 ㊱×2 全红，看着像坏了）。 */
    var 在局里 = false;
    try {
      在局里 = !!(W.isInGame === true || (W.CAMPAIGN && W.CAMPAIGN.level) || (W.HS_FREE && W.HS_FREE.slots));
    } catch (e) {}
    if (W.HS_STATE && typeof W.HS_UI_取值 === 'function') {
      var 版 = W.HS_STATE.版本号();
      ok('㉟ 权威状态已有版本号（revision ≥ 1）', !在局里 || (!!版 && 版.revision >= 1),
         (!在局里 ? '（不在局里，本条不判）' : '版本号：' + JSON.stringify(版)));
      var 差0 = W.HS_STATE.对账(W.HS_UI_取值);
      /* 演出进行中，场面本来还在动（敌方刚落下一只随从、提交点还没到）——
         这时要求"对账为空"是错的，会误报（实测连打三回合时误报过 enemy.场上）。
         空闲态必须干净：那才是"两套真相"有意义的时刻。 */
      var 闲3 = true;
      try {
        闲3 = !(W.HS_PIPELINE && ((W.HS_PIPELINE.isLocked && W.HS_PIPELINE.isLocked()) ||
               (W.HS_PIPELINE.queueLength && W.HS_PIPELINE.queueLength() > 0)));
      } catch (e) {}
      ok('㉟ 权威与 DOM 一致（对账为空）', 差0.length === 0 || !闲3,
         '不一致：' + (差0.map(function (x) { return x.项; }).join('、') || '无')
         + (!闲3 && 差0.length ? '（演出进行中，本条不判）' : ''));
      /* 故意偷改 DOM（模拟"演出/别人"改数字）：对账必须抓到，追平必须改回来。
         ⚠ 两个前置条件，缺一个就会**假红**（实测踩过）：
           ① 空闲态 —— 演出进行中本来就有别的差异，分不清是谁改的；
           ② **权威状态已建立**（revision ≥ 1）—— 还没提交过时 `对账` 必然返回空
              （它就是拿"上一次提交的权威"比当前的），那时判它"没抓到"是冤枉。 */
      var 权威在 = false;
      try { 权威在 = !!(W.HS_STATE && W.HS_STATE.版本号 && W.HS_STATE.版本号() && W.HS_STATE.版本号().revision >= 1); } catch (e) {}
      var 血 = d.querySelector('.playerHeroHealth');
      var 原 = 血 ? 血.textContent : null;
      if (血 && 闲3 && 权威在) {
        血.textContent = String((parseInt(原, 10) || 0) - 7);
        var 差1 = W.HS_STATE.对账(W.HS_UI_取值);
        ok('㉟ 偷改 DOM 会被对账抓到（两套真相现形）', 差1.length > 0,
           '差异：' + 差1.map(function (x) { return x.项; }).join('、'));
        W.HS_STATE.追平(追平画面);
        var 差2 = W.HS_STATE.对账(W.HS_UI_取值);
        ok('㉟ 追平把 DOM 按权威改回来（对账恢复为空）', 差2.length === 0,
           '还差：' + 差2.map(function (x) { return x.项; }).join('、'));
      } else if (血) {
        ok('㉟ 偷改 DOM 会被对账抓到（两套真相现形）', true, '（演出进行中，本条不判）');
        ok('㉟ 追平把 DOM 按权威改回来（对账恢复为空）', true, '（演出进行中，本条不判）');
      }
    }

    /* ㊱ 展示/权威的版本语义（改进 E）：展示**不许超前**权威，且空闲时**必须追平**。
       这两条合起来就是流程图里"展示状态可滞后、跳过动画=强制同步"那一段的机器口径。 */
    if (W.HS_STATE && typeof W.HS_STATE.版本号 === 'function') {
      var v2 = W.HS_STATE.版本号();
      ok('㊱ 展示版本号不超过权威（展示只能滞后，不能超前）',
         !在局里 || (!!v2 && v2.展示revision <= v2.revision),
         (!在局里 ? '（不在局里，本条不判）' : '版本号：' + JSON.stringify(v2)));
      var 闲2 = true;
      if (W.HS_PIPELINE && W.HS_PIPELINE.isLocked && W.HS_PIPELINE.queueLength) {
        闲2 = !W.HS_PIPELINE.isLocked() && W.HS_PIPELINE.queueLength() === 0;
      }
      ok('㊱ 空闲时展示已追平权威（演出播完不留尾巴）',
         !在局里 || (!!v2 && (!闲2 || v2.展示revision === v2.revision)),
         '锁=' + (W.HS_PIPELINE ? W.HS_PIPELINE.isLocked() : '-') + ' 队列=' + (W.HS_PIPELINE ? W.HS_PIPELINE.queueLength() : '-') + ' 版本=' + JSON.stringify(v2));
    }

    /* ㊲ 资源齐备（真案例 2026-10-04："展示版打开是裸 HTML"）。
       展示包用白名单拷贝，把 styles.css / index.js / src/scripts/*.js 搬进了子目录，
       而 index.html 引用的是根路径 → 页面必然缺样式与脚本；**当时自检 35 项全绿**，
       因为它只查运行时状态，从来没人查过"资源在不在"。这一条补的就是那一层。
       随时可跑的静态版：`node 工具/引用体检.js <目录>`（打包前后各跑一次，5 毫秒出结论）。 */
    (function () {
      if (!W.HS_CHECK || typeof W.HS_CHECK.资源缺口 !== 'function') {
        ok('㊲ 本地资源齐备（link/script 无 404）', false, '检错层没装上，查不了');
        return;
      }
      var 缺 = W.HS_CHECK.资源缺口(d);
      ok('㊲ 本地资源齐备（页面引用的 link/script 都加载成功）', 缺.length === 0,
         '缺：' + (缺.map(function (x) { return x.谁 + ' ' + x.址 + '（' + x.因 + '）'; }).join('、') || '无'));
    })();

    /* ㊳ 样式**真的生效**（"文件在" ≠ "规则落到了元素上"）。
       判据都是"加载事实"或"只有我们那张表才会有的效果"，**不用计算结果去反推加载**
       （第一版拿"body 必须是纯黑"当判据，被我们自己的深蓝底色误伤 —— 见 检错.js 里的说明）：
       上游样式表加载且非空 · 我们 CSS 藏住的装饰画布确实是 none · 整页容器没有成排外露。
       裸 HTML 那种长相（Victory / Sound / Options / Show FPS 全暴露）会被它当场抓住。 */
    (function () {
      if (!W.HS_CHECK || typeof W.HS_CHECK.样式生效 !== 'function') {
        ok('㊳ 样式真的落到元素上', false, '检错层没装上，查不了');
        return;
      }
      var s = W.HS_CHECK.样式生效(d);
      var 好 = (!s.查了上游 || s.上游表) && s.我们画布 && s.外露 < 2;
      ok('㊳ 样式真的落到元素上（不是裸 HTML）', 好,
         '上游样式表=' + (s.查了上游 ? (s.上游表 ? '已加载' : '**页面上没有**') + '（body 底色实测 ' + (s.底 || '空') + '，仅供诊断）' : '页面未外链 styles.css，跳过') +
         ' · 我们画布被藏=' + s.我们画布 +
         ' · 外露的整页容器=' + (s.该藏的.join('、') || '无'));
    })();

    /* ㊴ **局开了就必须看得见**（2026-10-05：用户"这上面什么都没有"）
       症状：手牌已经发到 3 张（局确实开了），但 `#contents` 还是 `visibility:hidden`
       —— 整张牌桌在屏幕上是空的，而**当时的自检全绿**：因为 ㉚/㉟ 那些断言都带
       "舞台不可见就不判"的前置条件，正好把这一类漏掉（"'检查'看不见'用户看得见'"的盲区）。
       所以单独立一条**只问这一件事**的断言：只要手牌容器里有牌，棋盘就必须是可见的。
       它不看别的东西，也无法被任何"跳过条件"豁免。 */
    (function () {
      var 手 = 找id('cards');
      var 内容 = 找id('contents');
      if (!手 || !内容) { ok('㊴ 局开了牌桌就看得见（手牌有牌 ⇒ 棋盘可见）', true, '（没有手牌容器/棋盘，跳过）'); return; }
      var 有牌 = 手.childElementCount > 0;
      var 可见 = true;
      try { 可见 = getComputedStyle(内容).visibility !== 'hidden'; } catch (e) {}
      ok('㊴ 局开了牌桌就看得见（手牌有牌 ⇒ 棋盘可见）', !有牌 || 可见,
         '手牌 ' + 手.childElementCount + ' 张 · #contents ' + (可见 ? '可见 ✓' : '**还是 hidden ✗（整张牌桌在屏幕上是空的）**'));
    })();

    return { 通过: pass, 失败: fail, 总数: pass + fail.length, 就绪: fail.length === 0 };
  }

  /* ==================== 导出本局信息（排查报错用） ====================
     用户 2026-10-03 要的：把这一局的关键状态、场面、最近播过的动作、最近一次攻击的落地情况、
     以及自检结果汇总成一段文本。放在一个**可选中的文本框**里 —— iframe / 沙盒里剪贴板
     不一定可用，所以「复制」是尽力而为，文本框永远能手动全选。 */
  function buildReport() {
    var L = [];
    function push(x) { L.push(x); }
    try {
      push('=== 卡牌对战 · 本局信息 ===');
      push('时间      : ' + new Date().toLocaleString());
      push('地址/视角 : ' + String((W.location && (String(W.location.pathname || '') + String(W.location.search || ''))) || '（宿主未提供地址）') + '  ' + view);
      /* ★ 运行环境（2026-10-04 加）。起因：用户贴回来的报告里 `脚本版本` 整行空、
         `英雄血量` 是 "?"、还报了 SKELETON_INCOMPLETE —— 而只看那几行**判断不出**
         到底是"沙盒里骨架没注入"还是"模块没装上"，得来回问。
         所以这一行直接回答：我们在哪个文档里、骨架根是谁、哪些关键 id 不在、血量元素找不找得到。
         （沙盒把骨架注入 `#hs-sandbox-root`；独立网页是直连 body。） */
      (function () {
        var 沙盒 = !!(W.HS_SANDBOX && typeof W.HS_SANDBOX.有SDK === 'function' && W.HS_SANDBOX.有SDK());
        var 骨架根 = null;
        try {
          if (W.HS_SANDBOX && W.HS_SANDBOX.根) {
            var 根元素 = W.HS_SANDBOX.根();
            /* 根() 返回的是元素，直接拼字符串会打成 "[object HTMLDivElement]" —— 要它的 id/class */
            骨架根 = 根元素 ? ('#' + (根元素.id || '(无id)') + (根元素.className ? '.' + 根元素.className : '')) : null;
          }
        } catch (e) {}
        /* ⚠ 这一行**必须用根作用域查**（见 游戏/查找.js）：`document.getElementById` 被平台改写过，
           拿它当判据会误报"关键 id 缺"（真机上就这么误导过一次）。两种口径都报。 */
        var 根缺 = '', 文缺 = '';
        ['contents', 'game', 'cards', 'playerhero', 'opposinghero'].forEach(function (id) {
          if (!找('#' + id)) 根缺 += id + '/';
          var e = null; try { e = d.getElementById(id); } catch (err) {}
          if (!e) 文缺 += id + '/';
        });
        var 查 = function (sel) { return 找(sel) ? '在' : '**找不到**'; };
        push('运行环境  : ' + (沙盒 ? '沙盒舞台' : '独立网页') + ' · 骨架根=' + (骨架根 || '（直连本页）') +
             ' · 根里' + (根缺 || '齐') + (文缺 ? '（document 查不到 ' + 文缺 + '←查找被改写）' : '') +
             ' · 血量元素 我' + 查('.playerHeroHealth') + ' 敌' + 查('.opposingHeroHealth') +
             ' · iframe=' + (W.self && W.top && W.self !== W.top ? '是' : '否'));
      })();
      push('自检      : ' + JSON.stringify(check()));
      /* ★ 把**已加载脚本的版本号**一起报出来：出现过"有的脚本新、有的脚本旧"的缓存错位
         （自检文案是旧的、但新字段却在），光看现象判断不出来。这里直接看 URL 上的 ?v=。
         ⚠ 沙盒**没有** `<script src>`（脚本由规则注入），那时这一段会整行空 —— 所以：
           ① 优先报构建戳 `HS_BUILD`（组装/打沙盒卡时写进去的，两种环境都有）；
           ② 没有 script 标签就**明说**为什么空，别让人以为是读失败。 */
      (function () {
        var tags = d.querySelectorAll('script[src*="游戏/"]');
        var list = [];
        for (var i = 0; i < tags.length; i++) {
          var m = /\/([^\/?]+)\?v=([0-9a-f]+)/.exec(tags[i].getAttribute('src') || '');
          if (m) list.push(m[1] + '@' + m[2]);
        }
        var css = d.querySelector('link[href*="样式.css"]');
        var 戳 = (typeof W.HS_BUILD === 'string' && W.HS_BUILD) ? '构建=' + W.HS_BUILD + '  ' : '';
        var 表 = list.length ? list.join(' ') : '（本页没有 游戏/*.js 的 <script src>：沙盒由规则注入，看构建戳）';
        push('脚本版本  : ' + 戳 + 表 + (css ? '  css@' + (/v=([0-9a-f]+)/.exec(css.getAttribute('href')) || [])[1] : ''));
      })();
      push('回合      : playersTurn=' + (typeof playersTurn !== 'undefined' ? playersTurn : '?') +
           '  锁=' + (W.HS_PIPELINE
             ? (HS_PIPELINE.isLocked() ? '持锁（' + String(HS_PIPELINE.reason()) + '）' : '空闲')
             : '（没有管线）') +
           '  队列=' + (W.HS_PIPELINE ? HS_PIPELINE.queueLength() : '-'));
      ['player', 'enemy'].forEach(function (side) {
        var b = boardOf(side);
        var kids = b ? Array.prototype.slice.call(b.children) : [];
        var cards = kids.filter(function (c) { return c.classList && c.classList.contains('cardinplay'); });
        push((side === 'player' ? '我方' : '敌方') + '场面 ' + cards.length + '/' + SLOT_COUNT + ' 张: ' +
          cards.map(function (c) {
            var h = c.children[1] && c.children[1].children[0];
            var a = c.children[0] && c.children[0].children[0];
            return (c.__hsName || c.id || '?') + '(' + (a ? a.textContent : '?') + '/' + (h ? h.textContent : '?') + ')' +
                   ' 第' + (c.dataset && c.dataset.slot !== undefined ? (Number(c.dataset.slot) + 1) : '?') + '格' +
                   ' left=' + (c.style.left || '未落格!');
          }).join('  |  '));
      });
      push('手牌      : 我 ' + (d.getElementById('cards') ? d.getElementById('cards').childElementCount : '?') +
           ' 张 / 敌 ' + enemyHand.length + ' 张');
      var ph = heroNode('playerhero'), eh = heroNode('opposinghero');
      /* 血量读不到时**说清是哪一步断了**（原来一律打 "?"，看不出是元素没建、还是路径取错）。 */
      var 血量 = function (节点, id, sel) {
        if (节点) return String(节点.textContent);
        if (!找id(id)) return '?（没有 #' + id + '）';
        var e = d.querySelector(sel);
        return e ? String(e.textContent) : '?（没有 ' + sel + '）';
      };
      push('英雄血量  : 我 ' + 血量(ph, 'playerhero', '.playerHeroHealth') +
           ' / 敌 ' + 血量(eh, 'opposinghero', '.opposingHeroHealth'));
      push('--- 最近播过的动作 ---');
      push(W.HS_PIPELINE ? HS_PIPELINE.dump() : '(没有管线)');
      /* ★ 点击与回合的留痕由 查找.js 组织成现成的几行（省本文件长度：沙盒单条规则卡得很死）。
         读法：有目标元素但上面"最近播过的动作"为空 → 点击接上了、后面的链没走；
         压根没出现那个元素 → 点击没落到它身上（多半被别的图层盖住）。 */
      (W.HS_UI_点击摘要 ? W.HS_UI_点击摘要() : []).forEach(push);
      push('--- 最近一次攻击（有没有落地 / 有没有抛错）---');
      push(JSON.stringify(W.HS_PIPELINE ? HS_PIPELINE.lastStrike() : null));
      push('--- 交互层最近一次异常 ---');
      push(String(lastError));
    } catch (err) {
      push('[汇总时出错] ' + err);
    }
    return L.join('\n');
  }

  function showReport() {
    var text = buildReport();
    var box = d.getElementById('hs-report');
    if (!box) {
      box = d.createElement('div');
      box.id = 'hs-report';
      box.innerHTML =
        '<div class="hr-head"><span>本局信息（可全选复制）</span>' +
        '<button class="hr-copy">复制</button><button class="hr-close">关闭</button></div>' +
        '<textarea readonly spellcheck="false"></textarea>';
      ((W.HS_UI_宿主 && W.HS_UI_宿主()) || d.body).appendChild(box);
      box.querySelector('.hr-close').onclick = function () { box.classList.remove('on'); };
      box.querySelector('.hr-copy').onclick = function () {
        var ta = box.querySelector('textarea');
        try { ta.select(); d.execCommand && d.execCommand('copy'); } catch (err) { /* 沙盒里可能不给复制，手动选也一样 */ }
      };
    }
    box.querySelector('textarea').value = text;
    box.classList.add('on');
    return text;
  }

  W.HS_STAGE_SCALE = { 读: 缩放上限, 设: 设缩放上限 };   // 设置面板的"桌面缩放"用它

  W.HS_INTERACT = {
    slotAt: slotAt, slotRect: slotRect, hotSlot: hotSlot, toDesign: toDesign,
    要转屏: 要转屏, fit: function () { return stage() ? stage().__hsFit : null; },
    syncSlots: syncSlots, fitStage: fitStage, toDesign: toDesign,
    playFromHand: playFromHand, refillIfEmpty: refillIfEmpty,
    slotsOf: function (side) { return slots[side].slice(); },
    cancel: cancelAim,
    check: check,
    导出报告: showReport,            // 设置面板的「导出报错」调它（面板本身可关）
                    // 自检：把谈定的东西逐条断言（见 变更清单.md）
    enemyHand: function () {         // 敌方手牌（加了抽牌之后才有意义；调试与验证用）
      return enemyHand.map(function (c) { return c && c['name']; });
    },
    /* 调试/验证用：整回合快照与攻击反推。它们平时在回合边界上自动跑，
       但"没有攻击发生"时看不出对错 —— 所以要能单独调。 */
    _snapTurn: snapTurn,
    _inferAttacks: inferAttacks,
    /* 新战斗规则的三个落点（用户 2026-10-03）：平时在回合边界自动跑，单独调是为了能验 */
    _回合结束回复: 回合结束回复,
    _清攻击过标记: 清攻击过标记,
    _挂体力徽章: 挂全部体力徽章,
    /* 攻击结算（我们自己的，双方共用）。导出是为了**能单独调它来验** ——
       走真实拖拽要等整套演出，而这个函数是纯 DOM 施加，单测它最快。 */
    _应用一次攻击: 应用一次攻击,
    _读攻: 读攻,
    _读血: 读血,
    _血节点: 血节点,
    /* 输入层归一（架构改进 F）：意图层导出给自检与调试；两种输入（拖拽/点选）与 Bot 都走它 */
    _执行意图: 执行意图,
    /* 权威状态（改进 B）：导出取值/提交/对账，好单独调来验（尤其"偷改 DOM 能不能抓到"） */
    _采集场面: 采集场面,
    _提交场面: 提交场面,
    _对账: function () { return (W.HS_STATE && W.HS_UI_取值) ? W.HS_STATE.对账(W.HS_UI_取值) : '（状态层没就位）'; },
    _意图计数: function () { return JSON.parse(JSON.stringify(意图计数)); },
    _合法意图: 合法意图,
    /* 卡的效果（阶段 D）：同样导出，好单独调来验 —— 尤其"敌方战吼不许打扰玩家"那条 */
    _应用战吼: 应用战吼,
    /* 决策（架构改进 D）：**唯一出口**导出给自检与调试 —— 谁选、选项、上下文都在一个对象里 */
    _发起决策: 发起决策,
    _决策请求: function () { return 待选 ? 待选.请求 : null; },
    _放弃待选: 放弃待选,
    _待选: function () {
      return 待选 ? { 卡名: 待选.卡名, 席位: 待选.席位, 可选: 待选.可选.length } : null;
    },
    /* 引擎里同一套规则，取值口径来自同一张卡表 —— 界面与引擎不会各说各话 */
    _体力: function (名) {
      var d0 = (W.HS_CARDS || {})[名];
      return d0 ? { 攻耗: d0.攻耗, 恢复: d0.恢复, 反击: !!(d0.关键词 && d0.关键词.反击) } : null;
    },
    _heroNode: heroNode,             // 血量节点取法（两个英雄结构不同，pipeline 的诊断要用）
    setView: setView, view: function () { return view; },   // ⑧ 视角（平铺 / 立体）
    lastError: function () { return lastError; },   // 交互层里最近一次异常（调试用）
    state: function () {
      return { state: state, srcKind: srcKind, pendingSlot: pendingSlot,
               hover: hoverTarget ? (hoverTarget.id || hoverTarget.className) : null };
    },
    DESIGN: { w: DESIGN_W, h: DESIGN_H },
    SLOT_COUNT: SLOT_COUNT,
  };

  /* ★ 界面重入（2026-10-03，进沙盒用）：**页内**换关时骨架是重建过的，于是
     格位数组里存的是旧节点、舞台尺寸要重算、手牌观察器盯着旧容器 —— 这几件事重做一遍。
     不用重绑的：`onDown`/`onUp`/`onUp` 那几条都挂在 **document** 上（捕获阶段），
     换 DOM 不影响它们 ✓；`SLOT_COUNT` 必须按新的 HS_SLOTS 重读（格数由关卡决定）。
     为什么是"重入"而不是"重新加载本文件"：本文件是个大 IIFE，重跑会叠监听、叠观察器。 */
  function rebootUI() {
    try {
      SLOT_COUNT = W.HS_SLOTS || 5;
      slots.player = []; slots.enemy = [];
      for (var i = 0; i < SLOT_COUNT; i++) { slots.player.push(null); slots.enemy.push(null); }
      待选 = null; pendingSlot = -1;
      /* 格数变了就把两排格位**拆了重建**：`buildRows()` 只在"行不存在"时才建
         （它防的是重复建），而换关卡恰恰是"行还在、但格数要变" —— 不拆就还是上一关的格数 ✗。 */
      ['player', 'enemy'].forEach(function (side) {
        var row = d.getElementById('hs-slots-' + side);
        if (row && row.childElementCount !== SLOT_COUNT) row.remove();
      });
      buildChrome();            // 有守卫：已存在就不重建
      buildOverlays();          // 同上
      buildRows();              // 行被清掉过 → 按新的 SLOT_COUNT 重建
      fitStage();
      syncSlots('player'); syncSlots('enemy');
      排手牌();
      盯手牌();                 // 新 #cards 节点没被盯过，所以这里一定会重新观察（老节点随旧骨架一起扔）
      渲染任务区();
      try { if (W.HS_RESOURCE) W.HS_RESOURCE.渲染(); } catch (e) {}
      return true;
    } catch (e) {
      if (W.console && W.console.error) W.console.error('[界面重入] 失败：', e);
      return false;
    }
  }
  W.HS_UI_REBOOT = rebootUI;

  /* 给别的层（资源层 / 将来别的面板）留一个"请重画任务区"的入口。
     ⚠ 加载位次上，资源.js 排在 界面.js **之前**，所以它装载时还看不到 HS_UI ——
     那边是"每次变化时 try 一下 `W.HS_UI.刷新任务区`"，取不到就什么都不做（回合开始与
     这个面板的首次渲染都不依赖它）。 */
  W.HS_UI = { 刷新任务区: 渲染任务区 };
})(typeof window !== 'undefined' ? window : globalThis);
