/* 关卡挑战版 · 卡库数据层自测（node，无需浏览器）
 *
 * 用 vm 起一个共享上下文，把我们的 游戏/卡库.js 按真实顺序装进去，
 * 然后核对「关卡表 / 牌组 / 卡表」到底成不成立。
 *
 * 卡表数值的"对照物"是 `工具/上游卡表基线.json`（**数据基线**，不是源码）：
 *   2026-10-04 之前这里装的是上游 deck.js —— 它已不再随工程分发（去依赖执行表里完成的一步），
 *   于是测试 ENOENT 崩掉。正确做法不是把对照物请回来，而是把要核对的**数值事实**冻成基线：
 *   一张 name → {费,攻,血} 的表 + 生成时记录的上游文件 sha256（可审计）。
 *   想重算基线（需要那份 71 MB 镜像）：node 工具/生成卡表基线.mjs
 *
 * 跑： node test_levels.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } };
const section = (t) => console.log('\n== ' + t + ' ==');

// ---- 对照物：冻结的卡表数值基线 ----
const 基线路径 = path.join(HERE, '工具', '上游卡表基线.json');
if (!fs.existsSync(基线路径)) {
  console.error('缺少对照物 ' + 基线路径 + '\n  → 生成：node 工具/生成卡表基线.mjs（需要上游镜像）');
  process.exit(2);
}
const 基线 = JSON.parse(fs.readFileSync(基线路径, 'utf8'));

// ---- 装载：顺序照 index.html 里的真实顺序 ----
// 卡库.js 的乙段会读 location.search（没有 ?level 就走空分支），所以桩里得给一个 location。
const ctx = vm.createContext({ console, Math, JSON, Object, Array, Error,
                               location: { search: '', pathname: '/', href: '/' } });
for (const f of ['游戏/卡库.js']) {
  const code = fs.readFileSync(path.join(HERE, f), 'utf8');
  new vm.Script(code, { filename: f }).runInContext(ctx);
}
const W = ctx;
const LEVELS = W.CAMPAIGN_LEVELS;
const DATA = W.CAMPAIGN_DATA;

section('A 装载');
ok(Array.isArray(LEVELS), 'CAMPAIGN_LEVELS 是数组');
ok(LEVELS.length === 5, `关卡数 = 5（实际 ${LEVELS && LEVELS.length}）`);
ok(DATA && typeof DATA.deckArray === 'function', 'CAMPAIGN_DATA.deckArray 存在');
const libKeys = Object.keys(DATA.lib());
ok(libKeys.length >= 30, `卡库按名索引到 ${libKeys.length} 张`);
/* 卡池工厂必须是**我们自己的**：上游那份只带 name/mana/attack/health，
   我们这份带中文的 费/攻/血（英文名保留只为兼容）。
   ⚠ 别拿 攻耗 当判据 —— 体力（攻耗/恢复）是**另一套表**（HS_CARDS），
     由 召唤() 在单位落地时固化上去，卡池对象里本来就没有（第一版写错过一次）。 */
{
  const 池 = (typeof ctx.freshDeck === 'function') ? ctx.freshDeck() : [];
  ok(池.length > 0 && 池.every((c) => '费' in c && '攻' in c && '血' in c),
     `卡池工厂是我们自己的（${池.length} 张，都带 费/攻/血）`);
  const 表 = ctx.HS_CARDS || {};
  const 表键 = Object.keys(表);
  ok(表键.length >= 30 && 表键.every((k) => '攻耗' in 表[k]),
     `卡表 ${表键.length} 张，每张都定义了 攻耗（战斗规则要的体力）`);
}

section('B 关卡表字段');
const ids = new Set();
for (const lv of LEVELS) {
  ok(Number.isInteger(lv.id) && lv.id > 0, `关卡 ${lv.id} id 是正整数`);
  ok(!ids.has(lv.id), `关卡 id 不重复：${lv.id}`);
  ids.add(lv.id);
  ok(typeof lv.name === 'string' && lv.name.length > 0, `关卡 ${lv.id} 有名字`);
  ok(typeof lv.opponentLabel === 'string' && lv.opponentLabel.length > 0, `关卡 ${lv.id} 有对手名`);
  ok(lv.player === 'basic' || lv.player === 'full', `关卡 ${lv.id} player 取值合法`);
  ok([0, 1, 2].includes(lv.tier), `关卡 ${lv.id} tier ∈ {0,1,2}`);
  ok(Number.isInteger(lv.playerHp) && lv.playerHp > 0, `关卡 ${lv.id} 玩家血量是正数`);
  ok(Number.isInteger(lv.opponentHp) && lv.opponentHp > 0, `关卡 ${lv.id} 对手血量是正数`);
  // 上游 startGame() 用 opposingHeroHealth==10 嗅探教程 —— 关卡绝不能踩到 10
  ok(lv.opponentHp !== 10, `关卡 ${lv.id} 对手血量不是 10（否则会被上游当成教程）`);
  ok(Array.isArray(lv.opponent) && lv.opponent.length > 0, `关卡 ${lv.id} 有对手牌组`);
  ok(Number.isInteger(lv.slots) && lv.slots >= 1 && lv.slots <= 5, `关卡 ${lv.id} slots ∈ [1,5]`);
  ok(typeof lv.blurb === 'string' && lv.blurb.length > 0, `关卡 ${lv.id} 有说明文案`);
}

section('C 难度阶梯是单调的');
for (let i = 1; i < LEVELS.length; i++) {
  ok(LEVELS[i].opponentHp >= LEVELS[i - 1].opponentHp,
     `第 ${i + 1} 关血量不低于第 ${i} 关`);
}
ok(LEVELS[0].tier === 0, '第一关是最低 AI 档（新手）');
ok(LEVELS[LEVELS.length - 1].tier === 2, '最后一关是最高 AI 档（大师）');

section('C2 部署位数：关卡 1→5 格 · 自由关 1/3/5 · 缺省 5');
ok(LEVELS.every((lv, i) => lv.slots === i + 1), '关卡格数逐关 +1（第一关 1 格 → 第五关 5 格）');
ok(W.HS_SLOTS === 5, '没有 URL 参数时缺省 5 格（上游主菜单那条老路）');
/* 部署位数是「本局的形状」，必须由 URL 决定 —— 所以换个 search 再装一遍 卡库.js。
   （乙段在自由关那条路上会 querySelector 写血量，桩里给个返回 null 的 document 即可。） */
const 装一遍 = (search) => {
  const c = vm.createContext({ console, Math, JSON, Object, Array, Error,
                               location: { search, pathname: '/', href: '/' },
                               document: { querySelector: () => null } });
  new vm.Script(fs.readFileSync(path.join(HERE, '游戏/卡库.js'), 'utf8'), { filename: '卡库.js' })
    .runInContext(c);
  return c;
};
ok(装一遍('?level=1').HS_SLOTS === 1, '?level=1 → 1 格');
ok(装一遍('?level=4').HS_SLOTS === 4, '?level=4 → 4 格');
ok(装一遍('?free=3').HS_SLOTS === 3, '?free=3 → 3 格');
ok(装一遍('?free=2').HS_SLOTS === 5, '?free=2 不是档位（只认 1/3/5）→ 退回 5 格');
ok(装一遍('?free=').HS_SLOTS === 5, '?free= 空值 → 5 格');
ok(装一遍('').HS_SLOTS === 5, '无参数 → 5 格');
ok(typeof 装一遍('?level=1').HS_LEVEL_DECK === 'function', '?level=1 仍然登记关卡牌组来源');
ok(typeof 装一遍('?free=3').HS_LEVEL_DECK === 'undefined', '?free=3 不登记关卡牌组（走自由池）');
ok(装一遍('?free=3').HS_FREE.slots === 3, '?free=3 记下了自由关档位');

section('D 牌组构建：必须吻合上游 startGame() 的下标切分');
// 上游：playerDeck = cards.slice(0,30) · computerDeck = cards.slice(31,60)
const PLAYER_N = 30, OPP_N = 29, TOKEN_N = 3;
const EXPECT_LEN = PLAYER_N + 1 + OPP_N + TOKEN_N;   // 下标 30 是占位
for (const lv of LEVELS) {
  const arr = DATA.deckArray(lv);
  ok(arr.length === EXPECT_LEN,
     `关卡 ${lv.id} 牌组长度 ${EXPECT_LEN}（实际 ${arr.length}）`);

  const player = arr.slice(0, PLAYER_N);
  const skipped = arr[PLAYER_N];
  const opp = arr.slice(PLAYER_N + 1, PLAYER_N + 1 + OPP_N);

  ok(player.every((c) => c && c.name), `关卡 ${lv.id} 前 30 张都是有效卡`);
  ok(!!(skipped && skipped.name), `关卡 ${lv.id} 下标 30 的占位是有效卡（上游会跳过它）`);
  ok(opp.every((c) => c && c.name), `关卡 ${lv.id} 对手那 29 张都是有效卡`);

  // 玩家牌组必须与关卡声明的档位一致
  const wantDeck = lv.player === 'full' ? DATA.FULL_DECK : DATA.BASIC_DECK;
  const wantNames = new Set(wantDeck);
  ok(player.every((c) => wantNames.has(c.name)),
     `关卡 ${lv.id} 玩家牌组用的是「${lv.player === 'full' ? '完整' : '基础'}组」`);

  // 对手牌组必须只含关卡声明的卡名
  const oppNames = new Set(lv.opponent);
  ok(opp.every((c) => oppNames.has(c.name)),
     `关卡 ${lv.id} 对手牌组只含声明的卡`);

  // 对手牌组必须有 1 费牌：上游 computerCardPlace() 按 mana == 法力上限 找牌，
  // 1 费那一回合如果一张都没有，它会一张都不出（等于白让一个回合）
  ok(opp.some((c) => c.mana === 1), `关卡 ${lv.id} 对手牌组里有 1 费牌`);
  // 也必须覆盖到中高费，否则中后期会空过
  const costs = new Set(opp.map((c) => c.mana));
  ok(costs.size >= 3, `关卡 ${lv.id} 对手牌组费用有 ${costs.size} 种（≥3）`);
}

section('E 卡名闭合：关卡表里写的卡名，上游卡库必须真的有');
const KNOWN = new Set(Object.keys(DATA.lib()));
for (const lv of LEVELS) {
  for (const n of lv.opponent) ok(KNOWN.has(n), `关卡 ${lv.id} 对手卡「${n}」在上游卡库里`);
}
for (const n of DATA.BASIC_DECK) ok(KNOWN.has(n), `基础牌组「${n}」在上游卡库里`);
for (const n of DATA.FULL_DECK) ok(KNOWN.has(n), `完整牌组「${n}」在上游卡库里`);

section('F 卡名写错时必须当场报错（而不是静默出一套残牌组）');
{
  const bad = { ...LEVELS[0], opponent: ['This Card Does Not Exist'] };
  let threw = false;
  try { DATA.deckArray(bad); } catch { threw = true; }
  ok(threw, '未知卡名会抛错');
}

section('G 卡表（卡库.js 丙段）与冻结基线逐张核对');
{
  // 效果表是**引擎读的那张数据表**。它是自己抄的一份数值，所以必须被机器盯着：
  // 抄错一位、或者将来改了卡面忘了同步，这里当场红。
  // 对照物 = 工具/上游卡表基线.json（由 生成卡表基线.mjs 从上游 deck.js 抽出，含来源 sha256）。
  const CARDS = ctx.HS_CARDS;
  ok(CARDS && typeof CARDS === 'object', 'HS_CARDS 卡表已导出');
  ok(基线.卡 && Object.keys(基线.卡).length === 基线.张数,
     `对照基线自洽（${基线.张数} 张 · 来源 sha256 ${String(基线.来源sha256).slice(0, 12)}…）`);
  const 上游 = 基线.卡;

  // 上游有**一张死数据**：deck.js 里定义了 Bloodfen Raptor，却从没放进返回的牌组。
  // 我们的表把它也照收了（连数据一起接管），所以"缺名"允许且**只允许**这一张。
  const 死数据 = ['Bloodfen Raptor'];
  const 缺名 = Object.keys(CARDS).filter((n) => !上游[n] && 死数据.indexOf(n) < 0);
  ok(缺名.length === 0, `卡表里的卡名基线里都真有（缺：${缺名.join(' / ') || '无'}）`);
  ok(死数据.every((n) => CARDS[n]), '上游那条死数据（Bloodfen Raptor）也在我们表里（照收、并备注）');

  const 不一致 = [];
  for (const n of Object.keys(CARDS)) {
    if (!上游[n]) continue;
    const d = CARDS[n], u = 上游[n];
    if (d.费 !== u.费 || d.攻 !== u.攻 || d.血 !== u.血) {
      不一致.push(`${n}: 表 ${d.攻}/${d.血}/${d.费} vs 基线 ${u.攻}/${u.血}/${u.费}`);
    }
  }
  ok(不一致.length === 0, `每一张的 攻/血/费 与基线逐项一致（不一致：${不一致.join(' | ') || '无'}）`);

  // 效果表要真的"有表达力"：这几类动作都得至少有一张卡用到
  const 覆盖 = ctx.HS_CARDS_INFO.动作覆盖;
  for (const 动作 of ['伤害', '治疗', '加成', '召唤', '抽牌', '冻结', '消灭']) {
    ok((覆盖[动作] || 0) > 0, `效果表覆盖了「${动作}」这一类效果`);
  }
  for (const 词 of ['嘲讽', '神圣护盾', '剧毒', '伤害后冻结']) {
    ok((覆盖['关键词:' + 词] || 0) > 0, `效果表覆盖了关键词「${词}」`);
  }
  ok(ctx.HS_CARDS_INFO.需要选目标.length > 0,
     `有 ${ctx.HS_CARDS_INFO.需要选目标.length} 张卡的战吼需要玩家选目标（引擎的"待选择"就靠它们）`);
  // 每张卡的 名 都是从键上补的 —— 引擎拿定义时就不必再自己补
  ok(Object.keys(CARDS).every((n) => CARDS[n].名 === n), '每张卡的 名 与键一致');
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
