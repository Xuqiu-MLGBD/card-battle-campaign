/* 关卡挑战版 · 演出管线
 * ===============================================================
 * 设计与逐条推演见 `设计/演出动画管线-方案-v2.md`。这个文件是它的第 1 期落地：
 *   ① 一把带 reason 的锁    ② 串行队列（播完一条才走下一条）
 *   ③ 四个演出原语         ④ 一张配方表
 * 第 1 期的配方只有「攻击」（方案里的第 8/9 条），因为它最小、不依赖卡效果表，
 * 而且最能验证那条主线：**规则先算好，表现按队列逐步播**。
 *
 * 与上游的关系：**一个字都没改**。
 *   方案 §9 原本打算改上游三处（opponentTurn 的调度、停用 AI()、attack.js 的结算时机）。
 *   但「上游一字未改」是这份 fork 的立身之本（`组装.py --check` 里有一条断言盯着它），
 *   所以改成**包装 + 拦截**：
 *     · 上游的 `AI()` / `computerCardPlace()` 用包装保留原决策，规划器只做「叙述」；
 *     · 玩家的攻击本来就走我们自己那一层（拖场上单位 → 松手即结算），
 *       结算入口就在我们手里，直接交给本文件排队即可。
 *   这样两边的规则路径都还是上游那套，我们只接管**什么时候播什么**。
 *
 * 为什么是一个文件、不是方案里列的 8 个：
 *   这套东西最终要压进 MMD 卡，卡里每条正则的硬上限是 18000 UTF-16 —— **规则条数就是成本**。
 *   8 个文件 = 8 条规则起步，而这几层之间只通过几个函数打交道，拆开只增加打包成本。
 *   所以按「层」分节写在同一个文件里。
 *
 * 坐标：全部是**视口坐标**（和 #hs-arrow、上游那条红色虚线同一套）。
 *   理由是立体视角：设计坐标到屏幕不再是线性映射，任何「从 A 画到 B」的东西
 *   都必须活在屏幕坐标系里。位移（lunge）另说 —— 它是施加在被倾斜元素上的 transform，
 *   算的是**元素本地坐标**（见 localDelta 的说明）。
 *
 * 中断（跳过 / 失焦 / Esc）：
 *   原语一律用 Web Animations API，把手上的 Animation 记在 inflight 里；
 *   中断时对它们调 `finish()`（**跳到终态**）而不是 `cancel()`（回起点），
 *   然后把队列剩下的条目走完 —— 这样任何时刻打断，状态都不会停在半路。
 */
(function (W) {
  'use strict';

  if (W.__hsPipeline) return;          // 幂等：创卡页预览会重跑脚本
  W.__hsPipeline = true;

  var d = W.document;

  /* ============================ ① 锁 ============================ */

  /* 方案 §六：**锁只有一把，但带 reason**。手牌、场上单位、英雄、结束回合全部先问锁 ——
     不能只禁用拖拽（文章原话：*「不要只禁用拖拽，快捷键或双击仍然能出牌」*）。
     三个 reason：
       ANIMATING  —— 正在播演出（可跳过）
       RESOLVING  —— 正在结算（不给跳过）
       WAITING    —— 等远端（关卡版没有联机，留着占位，语义与方案一致）
     锁期间 interactive 层会拦掉所有 mousedown，所以上游那些绑在元素上的处理器也进不来。 */
  var locks = {};

  function lock(reason) { locks[reason] = true; syncLock(); }
  function unlock(reason) { delete locks[reason]; syncLock(); }
  function lockReason() { var k = Object.keys(locks); return k.length ? k[0] : null; }
  function isLocked() { return Object.keys(locks).length > 0; }

  function syncLock() {
    if (!d.body) return;
    var r = lockReason();
    d.body.classList.toggle('hs-locked', !!r);
    if (r) d.body.setAttribute('data-hs-lock', r); else d.body.removeAttribute('data-hs-lock');
  }

  /* ============================ ② 队列 ============================ */

  /* 串行：一条播完才走下一条。`push` 返回 Promise，await 它就知道这一条演完了。
     队列空下来时解锁、并通知外面（onIdle）。 */
  var queue = [];
  var running = false;
  var inflight = [];                  // 手上的 Animation，中断时统一 finish()
  var idleHandlers = [];

  function push(fn, meta) {
    return new Promise(function (resolve, reject) {
      queue.push({ fn: fn, meta: meta || null, resolve: resolve, reject: reject });
      pump();
    });
  }

  async function pump() {
    if (running) return;
    running = true;
    lock('ANIMATING');
    while (queue.length) {
      var e = queue.shift();
      try { e.resolve(await e.fn()); }
      catch (err) { e.reject(err); }
    }
    running = false;
    unlock('ANIMATING');
    for (var i = 0; i < idleHandlers.length; i++) {
      try { idleHandlers[i](); } catch (err) { /* 通知回调不许把管线带崩 */ }
    }
  }

  function onIdle(fn) { idleHandlers.push(fn); }
  function queueLength() { return queue.length; }

  /* ★「所有演出都播完」的**确切时点**：队列空 + 没在跑（用户 2026-10-03 要的就是它）。
     为什么不能用"往队尾排一个空任务"来当结束信号：staging 任务与它 append 的演出
     都在同一个队列里，空任务会插在**演出之前**跑 —— 于是"结束"的判定早于动画播放，
     表现就是"敌方回合刚开始，结束回合键就变绿了"。 */
  function whenIdle() {
    return new Promise(function (res) {
      var tick = function () {
        if (!isLocked() && queue.length === 0) res();
        else W.setTimeout(tick, 120);
      };
      tick();
    });
  }
  function stats() { return { queued: queue.length, running: running, inflight: inflight.length, lock: lockReason() }; }

  /* 跳过：把手上所有动画**跳到终态**。调用方（Esc / 右键 / 取消）之后
     照常 `await` 自己那一条，队列会接着往下走。 */
  function skip() {
    var n = inflight.length;
    for (var i = 0; i < inflight.length; i++) {
      try { inflight[i].finish(); } catch (err) { /* 已经结束的会抛，忽略 */ }
    }
    inflight.length = 0;
    return n;
  }

  /* ======================= ③ 演出原语（4 个） ======================= */

  /* 演出层：一整块覆盖视口、不吃鼠标的图层。挂 body 上 → 和 #game 的缩放、
     倾斜都无关，坐标永远是屏幕坐标。 */
  var fx = null;
  function layer() {
    if (fx && d.body && fx.parentNode === d.body) return fx;
    if (!d.body) return null;
    fx = d.getElementById('hs-fx');
    if (!fx) {
      fx = d.createElement('div');
      fx.id = 'hs-fx';
      d.body.appendChild(fx);
    }
    return fx;
  }

  function rectOf(el) {
    if (!el || !el.getBoundingClientRect) return null;
    var b = el.getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height,
             cx: b.left + b.width / 2, cy: b.top + b.height / 2, right: b.right, bottom: b.bottom };
  }

  /* 舞台缩放：屏幕空间的东西（线宽、箭头大小、飘字字号）要按它放大，
     否则窗口一大就细得像头发。 */
  function stageK() {
    var g = d.getElementById('game');
    if (!g) return 1;
    return g.getBoundingClientRect().width / 1208 || 1;
  }

  /* 播一段 Web Animations 动画，返回可 await 的 Promise。
     ⚠ 环境里没有 animate（极老内核）时**直接返回已完成的 Promise** ——
       动画没有不影响结果，这是方案里那条"不要让规则结果依赖动画是否播完"。
     ⚠⚠ 看门狗：完成信号 `finished` 由 rAF 驱动，页面被节流 / 被切到后台 / 在 iframe 里
       被降频时**可能永远不来**，那样队列会一直卡在这一条、锁也永远不放。
       所以每段动画配一个**墙钟超时**：到点就 `finish()`（跳到终态）再放行。
       真浏览器里它永远轮不到触发。 */
  function play(el, keyframes, opts) {
    if (!el || !el.animate) return Promise.resolve();
    var o = opts || {};
    var dur = tuned(o.duration || 300);
    var oo = { duration: dur, easing: o.easing, fill: o.fill, delay: o.delay };
    var a = el.animate(keyframes, oo);
    inflight.push(a);
    var settled = false;
    var timer = W.setTimeout(function () {
      try { a.finish(); } catch (err) { /* 可能已经结束 */ }
      done();
    }, dur + 500);
    function done() {
      if (settled) return;
      settled = true;
      W.clearTimeout(timer);
      var i = inflight.indexOf(a);
      if (i >= 0) inflight.splice(i, 1);
    }
    return a.finished.then(done, done);
  }

  /* ======================= 速率（D2：加速/倍速） =======================
     演出时长统一乘 1/speed。**只有演出变快，结算一点没动** ——
     这正是方案里"规则先算完、表现按队列播"换来的好处：加快动画不会改变任何结果。 */
  var speedFactor = 1;

  function speed(x) {
    if (x) speedFactor = Math.max(0.25, Math.min(4, Number(x) || 1));
    return speedFactor;
  }

  function tuned(ms) { return Math.max(30, Math.round(ms / speedFactor)); }

  function wait(ms) {
    return new Promise(function (r) { W.setTimeout(r, tuned(ms)); });
  }

  /* ---- 原语 1：箭头（从 A 画到 B，画出来 → 驻留 → 淡出） ----
     几何与 `interact.js` 的 drawArrow 同一套：线只画到三角根部，
     三角底宽大于线宽 —— 否则虚线/线尾会从三角两侧穿出来（那一轮修过）。 */
  function arrow(fromEl, toEl, color) {
    var L = layer();
    var a = rectOf(fromEl), b = rectOf(toEl);
    if (!L || !a || !b) return Promise.resolve();
    var NS = 'http://www.w3.org/2000/svg';
    var svg = d.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'hs-fx-arrow');
    var line = d.createElementNS(NS, 'line');
    var head = d.createElementNS(NS, 'polygon');
    var k = stageK();
    var w = Math.max(3, 5 * k);
    line.setAttribute('stroke', color || '#e82e12');
    line.setAttribute('stroke-width', String(w));
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('fill', 'none');
    head.setAttribute('fill', color || '#e82e12');

    var dx = b.cx - a.cx, dy = b.cy - a.cy;
    var len = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
    var ux = dx / len, uy = dy / len;
    var hl = Math.max(22 * k, Math.min(len * 0.22, 46 * k));      // 三角长
    var hw = Math.max(hl * 0.62, w * 1.35);                       // 底半宽 > 线半宽
    var cut = hl * 0.9;                                          // 线尾收进三角体内
    line.setAttribute('x1', a.cx); line.setAttribute('y1', a.cy);
    line.setAttribute('x2', b.cx - ux * cut); line.setAttribute('y2', b.cy - uy * cut);
    var px = -uy, py = ux;
    head.setAttribute('points',
      [b.cx + ',' + b.cy,
       (b.cx - ux * hl + px * hw) + ',' + (b.cy - uy * hl + py * hw),
       (b.cx - ux * hl - px * hw) + ',' + (b.cy - uy * hl - py * hw)].join(' '));

    svg.appendChild(line); svg.appendChild(head);
    L.appendChild(svg);

    /* 线的"画出来"用 stroke-dashoffset 做（经典的描边生长），三角同拍放大浮现 */
    var draw = Math.max(len - cut, 1);
    var p1 = play(line, [
      { strokeDasharray: draw + ' ' + draw, strokeDashoffset: draw, opacity: 0.15 },
      { strokeDasharray: draw + ' ' + draw, strokeDashoffset: 0, opacity: 1 },
    ], { duration: 200, easing: 'ease-out', fill: 'forwards' });
    var p2 = play(head, [
      { opacity: 0, transform: 'scale(.5)' },
      { opacity: 1, transform: 'scale(1)' },
    ], { duration: 180, easing: 'ease-out', fill: 'forwards' });

    return Promise.all([p1, p2]).then(function () {
      return wait(150);                                     // 驻留一下，让玩家看清方向
    }).then(function () {
      return play(svg, [{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' });
    }).then(function () {
      if (svg.parentNode) svg.parentNode.removeChild(svg);
    });
  }

  /* ---- 原语 2：运一张卡（A 飞到 B） ----
     `opts.dy`：目标点再抬高一截（抽牌那种"从身后升起"的观感用）；
     `opts.fade`：飞到终点后淡出（而不是"到达"）。 */
  function flyCard(cardData, fromEl, toEl, opts) {
    var L = layer(), a = rectOf(fromEl), b = rectOf(toEl);
    if (!L || !a || !b) return Promise.resolve();
    var k = stageK();
    var o0 = opts || {};
    var box = d.createElement('div');
    box.className = 'hs-fx-card';
    box.style.left = a.cx + 'px';
    box.style.top = a.cy + 'px';
    box.style.width = Math.max(56, 96 * k) + 'px';
    box.style.height = Math.max(84, 144 * k) + 'px';
    var name = box.appendChild(d.createElement('div'));
    name.className = 'hs-fx-card-name';
    name.textContent = (o0.face && cardData && cardData.name) ? cardData.name : '';
    L.appendChild(box);
    var dx = b.cx - a.cx, dy = b.cy - a.cy + (o0.dy || 0);
    var o = { duration: o0.duration || 420, easing: 'cubic-bezier(.3,.7,.35,1)', fill: 'forwards' };
    var end = o0.fade
      ? { transform: 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px)) scale(.86)', opacity: 0 }
      : { transform: 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px)) scale(.72)', opacity: 1 };
    return play(box, [
      { transform: 'translate(-50%,-50%) scale(1)', opacity: o0.fade ? .85 : .2 },
      { transform: 'translate(-50%,-50%) scale(1.08)', opacity: 1, offset: .25 },
      end,
    ], o).then(function () {
      if (box.parentNode) box.parentNode.removeChild(box);
    });
  }

  /* 元素本地坐标的缩放系数：屏幕位移 → 本地位移。
     拿它所在容器自己的「屏幕尺寸 / 布局尺寸」当比例 —— 立体视角下战场被 rotateX 了，
     `getBoundingClientRect` 量到的是投影后的尺寸，而我们要施加的 transform 是在
     元素**本地坐标系**里生效的。两者差的就是这个系数。 */
  function localScale(box) {
    if (!box || !box.getBoundingClientRect || !box.offsetWidth) return { x: 1, y: 1 };
    var r = box.getBoundingClientRect();
    return { x: (r.width / box.offsetWidth) || 1, y: (r.height / box.offsetHeight) || 1 };
  }

  /* 屏幕位移 → 元素本地位移（frac = 冲过去多少，留一点距离不贴脸） */
  function localDelta(el, targetEl, frac) {
    var a = rectOf(el), b = rectOf(targetEl);
    if (!a || !b) return { x: 0, y: 0 };
    var box = el.offsetParent || el.parentNode;
    var s = localScale(box);
    var f = (frac == null) ? 0.78 : frac;
    return { x: (b.cx - a.cx) / s.x * f, y: (b.cy - a.cy) / s.y * f };
  }

  /* ---- 原语 3：冲刺（冲上去 / 移回来，两段分开 —— 中间那拍要留给结算与飘字） ----
     ⚠ 「在哪」要记在元素上：`lungeOut` 施加的是一个 forwards 的 transform，
     移回来的时候必须知道**冲到了哪**，否则会从 0 开始算、跳一下。 */
  function lungeOut(el, targetEl, frac) {
    if (!el) return Promise.resolve();
    var d0 = localDelta(el, targetEl, frac);
    el.__hsRush = d0;
    return play(el, [
      { transform: 'translate(0,0)' },
      { transform: 'translate(' + d0.x + 'px,' + d0.y + 'px)' },
    ], { duration: 180, easing: 'cubic-bezier(.3,.8,.4,1)', fill: 'forwards' });
  }

  function lungeBack(el) {
    if (!el) return Promise.resolve();
    var r = el.__hsRush || { x: 0, y: 0 };
    el.__hsRush = null;
    return play(el, [
      { transform: 'translate(' + r.x + 'px,' + r.y + 'px)' },
      { transform: 'translate(0,0)' },
    ], { duration: 220, easing: 'ease-out', fill: 'forwards' });
  }

  /* ---- 原语 4：飘数字（伤害 / 治疗 / 增益 / 减益） ----
     参数可以是元素，也可以是一个 **已经量好的 rect** —— 攻击那一拍目标可能已经被移除了
     （上游是 200ms 后 remove），元素没了再量就是全零，飘字会出现在屏幕角上。 */
  function pop(targetOrRect, text, kind) {
    var L = layer();
    var a = (targetOrRect && targetOrRect.cx != null) ? targetOrRect : rectOf(targetOrRect);
    if (!L || !a) return Promise.resolve();
    var k = stageK();
    var el = d.createElement('div');
    el.className = 'hs-fx-pop ' + (kind || 'damage');
    el.textContent = text;
    el.style.left = a.cx + 'px';
    el.style.top = a.cy + 'px';
    el.style.fontSize = Math.round(28 * k) + 'px';
    L.appendChild(el);
    return play(el, [
      { transform: 'translate(-50%,-50%) scale(.6)', opacity: 0 },
      { transform: 'translate(-50%,-50%) scale(1.15)', opacity: 1, offset: 0.22 },
      { transform: 'translate(-50%,-130%) scale(1)', opacity: 1, offset: 0.7 },
      { transform: 'translate(-50%,-190%) scale(.95)', opacity: 0 },
    ], { duration: 820, easing: 'ease-out', fill: 'forwards' }).then(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
  }

  /* ---- 原语 5：击中**玩家**（英雄）的专属特效 ----
     打单位只是"两个棋子碰一下"；打在玩家身上是"你被打了"，所以要更重一点：
     一圈冲击环 + 英雄框震一下。用户 2026-10-02 明确要的。 */
  function heroHit(targetEl, rect) {
    var L = layer();
    var a = rect || rectOf(targetEl);
    if (!L || !a) return Promise.resolve();
    var k = stageK();
    var ring = d.createElement('div');
    ring.className = 'hs-fx-ring';
    ring.style.left = a.cx + 'px';
    ring.style.top = a.cy + 'px';
    ring.style.width = ring.style.height = Math.max(48, a.width * 0.75) + 'px';
    L.appendChild(ring);
    var shake = play(targetEl, [
      { transform: 'translate(0,0)' },
      { transform: 'translate(' + (-7 * k) + 'px,' + (2 * k) + 'px)' },
      { transform: 'translate(' + (7 * k) + 'px,' + (-2 * k) + 'px)' },
      { transform: 'translate(' + (-4 * k) + 'px,0)' },
      { transform: 'translate(0,0)' },
    ], { duration: 320, easing: 'ease-out' });
    var grow = play(ring, [
      { transform: 'translate(-50%,-50%) scale(.25)', opacity: .95 },
      { transform: 'translate(-50%,-50%) scale(1.7)', opacity: 0 },
    ], { duration: 520, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' });
    return Promise.all([shake, grow]).then(function () {
      if (ring.parentNode) ring.parentNode.removeChild(ring);
    });
  }

  /* ========================= 结算自查 ========================= */

  /* 补发那次 mousedown 之后，**数字到底动没动**。
     为什么要查：上游判定"能不能打"靠 `canAttack`，不能打时它把这次点击**静默忽略** ——
     表现就是"箭头飞过去、伤害不生效"（用户报的正是这个）。
     现在不能攻击的单位在 interact.js 里就拦住了，这里只留一份记录：
     `HS_PIPELINE.lastStrike()` 能读出"这一下有没有落地"。**只记录、不重试** ——
     万一是写到了别处，重试会造成二次伤害。 */
  var lastStrike = null;

  function healthSnapshot() {
    var out = {};
    var nodes = d.querySelectorAll('.cardinplay');
    for (var i = 0; i < nodes.length; i++) {
      /* ⚠ 排除**退场克隆体**（它保留 cardinplay 类、没有 id）——
         不排掉的话，一张卡的死亡会往快照里塞一个 `anonN: "-2"` 这样的鬼影（实测过），
         看起来像"凭空多了一个 -2 血的单位"，把诊断搅浑。 */
      if (nodes[i].classList && nodes[i].classList.contains('hs-fx-ghost')) continue;
      var h = nodes[i].children[1] && nodes[i].children[1].children[0];
      var key = nodes[i].id || ('anon' + i);
      if (h) out[key] = String(h.innerHTML || h.innerText || '').trim();
    }
    /* ⚠ 两个英雄的血量节点**结构不同**（我方 `#playerhero` 少一层），
       所以必须走 interact.js 提供的 heroNode（挂在 HS_INTERACT 上）。
       上一版直接写 `children[1].children[0]`，结果**我方英雄根本不在快照里** ——
       于是"敌方打我方英雄"这一路永远显示 `落地:false`（伤害其实落地了，是尺子看不到）。
       用户 2026-10-03 导出的那份就是这么来的。 */
    try {
      var HN = W.HS_INTERACT && W.HS_INTERACT._heroNode;
      if (HN) {
        var ph = HN('playerhero'), eh = HN('opposinghero');
        if (ph) out.playerhero = String(ph.innerHTML || ph.innerText || '').trim();
        if (eh) out.opposinghero = String(eh.innerHTML || eh.innerText || '').trim();
      }
    } catch (err) { /* 取不到就算了，不能因为诊断把结算带崩 */ }
    return out;
  }

  function snapshotChanged(a, b) {
    var k;
    for (k in b) { if (a[k] !== b[k]) return true; }
    for (k in a) { if (a[k] !== b[k]) return true; }
    return false;
  }

  /* ---- 原语 6：退场 ----
     上游的移除是**一句 `element.remove()`**（可能在 setTimeout 里、也可能埋在 AI 的深分支里），
     没有可包装的入口。所以退场用"克隆一份、演完再让它消失"的办法：
       · 克隆体**放回原件所在的容器**（同一块棋盘）→ 立体视角下自然跟着一起倾斜，
         位置也不用换算（`left` 是行内样式，cloneNode 一起带过来）；
       · 类名保留原样再叠一个 `hs-fx-ghost` → 攻血数字、立牌、描边全都照旧；
       · **真正的移除照旧立刻发生** —— 演出只是旁听，不参与任何规则
         （所以就算这段演到一半出错，游戏状态也是对的）。 */
  function ghost(el, opts) {
    if (!el || !el.parentNode) return Promise.resolve();
    var o = opts || {};
    var c;
    try { c = el.cloneNode(true); } catch (err) { return Promise.resolve(); }
    c.removeAttribute('id');
    c.className = String(el.className || '') + ' hs-fx-ghost';
    el.parentNode.appendChild(c);
    var dead = !!o.dead;
    var anim = dead
      ? [ { opacity: .95, transform: 'scale(1) rotate(0deg)', filter: 'none' },
          { opacity: 1, transform: 'scale(1.06) rotate(-2deg)', filter: 'brightness(2)', offset: .18 },
          { opacity: 0, transform: 'scale(.5) rotate(-16deg)', filter: 'none' } ]
      : [ { opacity: .85, transform: 'scale(1) translateY(0)' },
          { opacity: 0, transform: 'scale(.78) translateY(' + (14 * stageK()) + 'px)' } ];
    return play(c, anim, { duration: dead ? 640 : 420, easing: 'ease-out', fill: 'forwards' })
      .then(function () { if (c.parentNode) c.parentNode.removeChild(c); });
  }

  /* ========================= ④ 配方表 ========================= */

  /* （源形态 × 动作）→ 一段演出。看的是**源形态**不是具体哪一条，
     所以「给他自己人加增益」和「给我的人加增益」是同一行 —— 只有箭头终点落在不同半场。
     第 1 期只填 attack；其余四行按方案 §5 的规矩留位，第 2/3 期填。 */

  function attackRecipe(a) {
    var from = a.fromEl, to = a.toEl;
    /* 落点先量一次并留着：上游结算里目标可能被 remove（200ms 后），
       之后元素量为全零，飘字就飞到屏幕角上了。 */
    var toRect = rectOf(to);
    var isHero = (a.toKind === 'player');
    var beforeSnap = null;
    return arrow(from, to, a.color || '#e82e12')
      .then(function () { return lungeOut(from, to); })
      .then(function () { return wait(90); })
      .then(function () {
        /* ★ 结算落在"打中"这一拍 —— 上游那套 mousedown 在这里补发，
           所以扣血数字和打击同时出现，而不是先掉血再飞过去。 */
        /* ★ 2026-10-03 第三轮：这一段原来要"把攻击方是谁**补写回**上游的全局量
           `currentAttacker`"，因为结算是交给上游 attack.js 做的（而它只认那个变量）。
           **攻击结算已经收回我们自己手里**（界面.js 的 `应用一次攻击()`），
           所以这里不再需要补写、也不再有任何东西依赖 `currentAttacker` ——
           随之消失的是一整类坑：那个变量会被"敌方攻击的演出"残留成敌方卡 id，
           下一次我方攻击就拿它去 getElementById 得到 null 再解引用，
           在上游的监听器里抛错 → **攻击静默不生效**（用户 2026-10-03 报的"经常攻击不生效"）。
           页面自检 ㉖ 留着当哨兵：空闲时它必须是空的。 */
        beforeSnap = healthSnapshot();
        var err = null;
        if (a.onStrike) { try { a.onStrike(); } catch (e) { err = String(e); } }
        var afterSnap = healthSnapshot();
        /* ⚠ `落地:false` 必须**自带原因**，否则导出只能告诉我们"没生效"，查不动。
           所以把"攻方是谁、攻击力多少、目标还在不在、结算那一刻 currentAttacker 是什么"
           一起记下来（用户导出的那份就是这么用的）。 */
        var atkNode = from && from.children[0] && from.children[0].children[0];
        /* 目标到底掉了多少血：把"攻方攻击力"和"实扣"并排放，一眼就能看出倍数关系
           （用户 2026-10-03 报的"3 攻打 4 血"，就是靠这两个数对出来的）。 */
        var tKey = to ? (to.id || null) : null;
        var delta = (tKey && beforeSnap[tKey] !== undefined && afterSnap[tKey] !== undefined)
          ? (parseInt(beforeSnap[tKey], 10) || 0) - (parseInt(afterSnap[tKey], 10) || 0)
          : null;
        lastStrike = {
          verb: a.verb, toKind: a.toKind,
          落地: snapshotChanged(beforeSnap, afterSnap),
          报错: err,
          攻方: from ? (from.__hsName || from.id || '?') : null,
          攻方攻击力: atkNode ? String(atkNode.textContent || '').trim() : null,
          实扣血: delta,
          目标: to ? (to.__hsName || to.id || '?') : null,
          目标还在: !!(to && to.parentNode),
          结算时currentAttacker: (typeof W.currentAttacker === 'undefined' ? null : W.currentAttacker),
          前: beforeSnap, 后: afterSnap, at: Date.now(),
        };
        /* ⚠ 这里必须把异常**喊出来**：结算抛错时，界面表现和"结算被静默忽略"一模一样
           （都是数字不动），而第一版把它吞掉之后，`lastStrike` 只显示"没变化" ——
           等于我亲手把最关键的线索藏了起来。 */
        if (err) {
          if (W.console && W.console.error) W.console.error('[演出] 结算抛错：', err);
        }
        if (a.demo) lastStrike.demo = true;
      })
      .then(function () {
        var p = [];
        /* 打玩家比打单位多一圈冲击环 + 一次震动（用户 2026-10-02 要的） */
        if (isHero) p.push(heroHit(to, toRect));
        if (a.delta && a.delta.hp) p.push(pop(toRect || to, String(a.delta.hp), 'damage'));
        if (a.delta && a.delta.back) p.push(pop(from, String(a.delta.back), 'damage'));
        return Promise.all(p).then(function () { return wait(isHero ? 160 : 120); });
      })
      .then(function () { return lungeBack(from); });
  }

  /* ---- 上场（把一张卡放进某一格）----
     ⚠ 上游是**瞬间 append** 的，所以这条配方演的是"事后叙述"：
       · 结算已经发生（卡已经在场上了），`onStrike` 对它没有意义；
       · 于是观感靠三件事补：一条从来源指向它的箭头、卡片自己"弹"一下浮现、一次落位脉冲。
     来源通常是那一方的英雄（敌方的手牌看不见，用英雄当"对面出的牌"的锚点最自然）。 */
  function deployRecipe(a) {
    var from = a.fromEl, to = a.toEl;
    if (!to) return Promise.resolve();
    var p = [];
    if (from) p.push(arrow(from, to, a.color || '#6fbf73'));
    p.push(play(to, [
      { opacity: 0, transform: 'scale(.62)' },
      { opacity: 1, transform: 'scale(1.08)', offset: .6 },
      { opacity: 1, transform: 'scale(1)' },
    ], { duration: 420, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' }));
    p.push(pop(to, a.label || '上场', 'buff'));
    return Promise.all(p).then(function () { return wait(120); });
  }

  /* ---- 抽牌 ----
     张数是**看不见的信息**，所以只演"有人抽了牌"：一张卡背从那一方的英雄身后升起并淡出。
     一次抽多张时最多演 3 次，再多就吵了。 */
  function drawRecipe(a) {
    var at = a.toEl || a.fromEl;
    if (!at) return Promise.resolve();
    var n = Math.max(1, Math.min(a.count || 1, 3));
    var k = stageK();
    var seq = Promise.resolve();
    for (var i = 0; i < n; i++) {
      seq = seq.then(function () {
        return flyCard({ name: '' }, at, at, { duration: 380, dy: -78 * k, fade: true })
          .then(function () { return pop(at, a.label || '抽牌', 'buff'); });
      });
    }
    /* ★ 抽牌那一拍的**施加**：把牌真正拿进手（`apply` 由 planning 阶段挂在 onStrike 上）。
       不调它 = 手牌永远是空的，后面"上场"那条就无牌可取。 */
    return seq.then(function () {
      if (a.onStrike) { try { a.onStrike(); } catch (err) { /* 施加失败也要把演出走完 */ } }
    }).then(function () { return wait(80); });
  }

  /* ---- 回合相位与回合开始的小变化 ----
     `turn`：报一声"轮到谁了"（一个浮起的提示，不带箭头 —— 它不是动作，是相位）
     `gain`：法力上限 +1 这类"回合开始的判定结果" */
  function turnRecipe(a) {
    return pop(a.toEl, a.label || '回合', 'buff').then(function () { return wait(120); });
  }

  function gainRecipe(a) {
    return pop(a.toEl, a.label || '+1', 'buff').then(function () { return wait(80); });
  }

  /* 治疗：和 gain 同形，只是绿色的（上游的回血没有入口，靠英雄血量旁听触发，见 interact.js） */
  function healRecipe(a) {
    return pop(a.toEl, a.label || '+1', 'heal').then(function () { return wait(80); });
  }

  var RECIPES = {
    attack: attackRecipe, deploy: deployRecipe, draw: drawRecipe,
    turn: turnRecipe, gain: gainRecipe, heal: healRecipe,
  };

  /* `from` / `to` 允许写成 `{el: 元素}` 或直接给元素 —— 统一成元素 */
  function el(v) { return (v && v.el) ? v.el : v; }

  /* 最近播过哪些动作（调试与自检用）：`HS_PIPELINE.log()` 能读出来，
     验证"敌方这一回合到底被叙述了几件事"。只留最近 60 条。 */
  var history = [];

  /* 一条动作进队列。动作的形状按方案 §4.2：
       { verb, from, to, delta, count, label, onStrike }
     `from` / `to` 在演出层直接被解析成元素（`{el}` 或裸元素），
     语义层（side / kind / uid）留给规划器往上补 —— 演出只关心"画到哪个元素上"。
     `verb` 没有配方时**安静跳过**（第 3 期还要补 summon/buff/debuff）。 */
  function present(action) {
    var act = action || {};
    var rec = RECIPES[act.verb];
    if (!rec) return Promise.resolve(null);        // 还没实现的动作：安静跳过，不打断队列
    var a = {
      verb: act.verb,
      fromEl: el(act.from), toEl: el(act.to),
      fromKind: act.fromKind || 'unit', toKind: act.toKind || 'unit',
      delta: act.delta || null, color: act.color || null,
      count: act.count || 1, label: act.label || null,
      onStrike: act.onStrike || null,
      demo: !!act.demo,
    };
    history.push({ verb: a.verb, at: Date.now(), toKind: a.toKind, count: a.count, label: a.label });
    if (history.length > 60) history.shift();
    return push(function () { return rec(a); }, act.meta || null);
  }

  /* ========================= 自检 / 演示 ========================= */

  /* 播一段攻击演出，**不改任何游戏状态**（不结算）。
     没有场上单位时退回到两个英雄框，所以随时可以：
       HS_PIPELINE.demo('attack')
     想在真局里看，就用 HS_PIPELINE.demo('attack', {from:'.player-cardinplay', to:'#opposinghero'})。 */
  function demo(verb, opts) {
    var o = opts || {};
    var from = d.querySelector(o.from || '.player-cardinplay') || d.getElementById('playerhero');
    var to = d.querySelector(o.to || '.computer-cardinplay') || d.getElementById('opposinghero');
    if (!from || !to) return null;
    return present({
      verb: verb || 'attack', from: from, to: to,
      toKind: (to.id === 'opposinghero' || to.id === 'playerhero') ? 'player' : 'unit',
      delta: o.delta || { hp: -3 }, demo: true,
    });
  }

  W.HS_PIPELINE = {
    // 队列与锁
    push: push, present: present, onIdle: onIdle, skip: skip,
    whenIdle: whenIdle,      // ★「所有演出都播完」的确切时点（队列空 + 没在跑）
    lock: lock, unlock: unlock, isLocked: isLocked, reason: lockReason,
    stats: stats, queueLength: queueLength,
    // 五个原语（第 2/3 期的配方直接用它们拼）
    anim: { arrow: arrow, flyCard: flyCard, lungeOut: lungeOut, lungeBack: lungeBack, pop: pop, heroHit: heroHit, ghost: ghost },
    // 配方表（缺的动作安静跳过）
    recipes: Object.keys(RECIPES),
    // 最近播过哪些动作（验证"敌方这一回合被叙述了几件事"）
    log: function () { return history.slice(); },
    /* D3：把这段历史导成可读文本（复盘 / seed 铺路，方案第 5 期） */
    dump: function () {
      var t0 = history.length ? history[0].at : Date.now();
      return history.map(function (x) {
        return '+' + ((x.at - t0) / 1000).toFixed(2) + 's ' + x.verb +
               (x.count > 1 ? '×' + x.count : '') + (x.label ? '(' + x.label + ')' : '');
      }).join('\n');
    },
    // D2 速率：只影响演出时长，不影响任何结算
    speed: speed,
    // 结算自查：最近一次攻击"有没有落地"
    lastStrike: function () { return lastStrike; },
    // 自检
    demo: demo,
  };

  /* 页面失焦 / 被切到后台：把在飞的动画跳到终态，别停在一半 */
  W.addEventListener('blur', function () { skip(); }, false);
  if (d.addEventListener) {
    d.addEventListener('visibilitychange', function () { if (d.hidden) skip(); }, false);
  }
})(typeof window !== 'undefined' ? window : globalThis);
