// 工具/引用体检.js —— 页面引用的每个本地文件，是否真的在磁盘上。
//
// 为什么需要它（2026-10-04 事故）：
//   展示包用白名单拷贝，把 styles.css / index.js / src/scripts/* 放进了子目录，
//   而 index.html 引用的是根路径 → 打开包是"裸 HTML"（所有隐藏页面全暴露、没有样式）。
//   页面自检当时全绿（35 项通过 0 失败），因为它只查运行时状态，**从没有人查过资源在不在**。
//   这个脚本补的就是那一层：**静态引用解析**——不跑浏览器，5 毫秒给出结论。
//
// 用法：
//   node 工具/引用体检.js                     # 体检当前工程（脚本的上一级目录）
//   node 工具/引用体检.js <目录>              # 体检指定目录
//   node 工具/引用体检.js <目录A> --对比 <目录B>   # A 里引用的每个本地文件，B 里是否也有
// 退出码：0 全在；1 有缺失（可直接当构建／打包的闸门用）。
const fs = require("fs");
const path = require("path");

const 外链 = /^(?:[a-z]+:)?\/\/|^data:|^blob:|^#|^mailto:|^javascript:/i;

// 已剥离的第三方美术／音频：这些目录按设计就**不在**（组装.py 剥净了 128 个文件 / 71 MB）。
// 第三方 styles.css 仍逐字保留、仍会 url() 它们，浏览器拿到 404 只是少一张背景图，不影响可玩。
// 所以这一类只报「已剥离」，不算失败；代码与样式表不在这个豁免里。
const 已剥离目录 = ["src/images", "src/fonts", "src/cursor", "src/hints", "src/cards",
                "src/audio", "src/sounds", "src/videos", "src/music"];

function 读(p) {
  try { return fs.readFileSync(p, "utf8"); } catch (e) { return ""; }
}

// 抽引用前必须先**剥掉注释**：我们自己的 样式.css 注释里写着 "url(src/...)" 这种示例字样，
// 不剥就会被当成真引用（第一版就误报了这条）。
function 剥注释(文本, 是CSS) {
  return 是CSS ? 文本.replace(/\/\*[\s\S]*?\*\//g, "") : 文本.replace(/<!--[\s\S]*?-->/g, "");
}

// 从一段文本里挑出所有本地引用（html 属性 + css url() + css @import）
function 抽取引用(原始, 是CSS) {
  const 文本 = 剥注释(原始, 是CSS);
  const 出 = [];
  const 取 = (raw) => {
    let u = (raw || "").trim().replace(/^["']|["']$/g, "");
    if (!u || 外链.test(u)) return;
    u = u.split("?")[0].split("#")[0];          // 去掉 ?v=hash 与 #锚点
    if (!u) return;
    出.push(u.replace(/\\/g, "/"));
  };
  if (是CSS) {
    let m;
    const reUrl = /url\(\s*([^)]+?)\s*\)/g;
    while ((m = reUrl.exec(文本))) 取(m[1]);
    const reImp = /@import\s+(?:url\()?\s*["']([^"')]+)["']/g;
    while ((m = reImp.exec(文本))) 取(m[1]);
  } else {
    let m;
    const reAttr = /<(?:link|script|img|source|audio|video|iframe)\b[^>]*?\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
    while ((m = reAttr.exec(文本))) 取(m[1]);
  }
  return 出;
}

function 体检(root, 对比root) {
  const 缺失 = [];       // 硬失败：代码／样式表／页面结构缺了，页面一定不正常
  const 已剥离 = [];     // 已剥离的美术与音频，属于设计结果
  const 已查 = new Set();
  let 对比缺 = 0;

  const 查 = (引用, 来自, 基准目录) => {
    const 键 = 基准目录 + "|" + 引用;
    if (已查.has(键)) return;
    已查.add(键);
    const 全 = path.resolve(基准目录, 引用);
    const 在 = fs.existsSync(全) && fs.statSync(全).isFile();
    if (!在) {
      const 相对 = path.relative(root, 全).replace(/\\/g, "/");
      if (已剥离目录.some((d) => 相对.toLowerCase().startsWith(d))) 已剥离.push(相对);
      else 缺失.push({ 引用, 来自: path.relative(root, 来自) || path.basename(来自), 解析到: 全 });
    }
    if (对比root && 在) {
      const 镜像 = path.resolve(对比root, path.relative(root, 全));
      if (!fs.existsSync(镜像)) { 对比缺 += 1; 缺失.push({ 引用, 来自: path.relative(root, 来自), 解析到: 镜像, 对比: true }); }
    }
    return 全;
  };

  // 入口：index.html（含内联 <style> 里的 url()）
  const 首页 = path.join(root, "index.html");
  if (!fs.existsSync(首页)) {
    缺失.push({ 引用: "index.html", 来自: "(根)", 解析到: 首页 });
    return { 缺失, 已剥离, 扫了: 0 };
  }
  const html = 读(首页);
  for (const 引用 of 抽取引用(html, false)) 查(引用, 首页, root);
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const 引用 of 抽取引用(m[1], true)) 查(引用, 首页 + "(内联样式)", root);
  }

  // 样式文件里还会引用图片／字体：递归查一层（CSS 只查一级，够用且不会绕圈）
  const css队列 = [];
  for (const 引用 of 抽取引用(html, false)) if (/\.css$/i.test(引用)) css队列.push(path.resolve(root, 引用));
  const 我们样式 = path.join(root, "游戏", "样式.css");
  if (fs.existsSync(我们样式)) css队列.push(我们样式);
  const stylesCss = path.join(root, "styles.css");
  if (fs.existsSync(stylesCss)) css队列.push(stylesCss);
  const 见过CSS = new Set();
  while (css队列.length) {
    const f = css队列.pop();
    if (见过CSS.has(f) || !fs.existsSync(f)) continue;
    见过CSS.add(f);
    const 基准 = path.dirname(f);
    for (const 引用 of 抽取引用(读(f), true)) {
      const 全 = 查(引用, f, 基准);
      if (全 && /\.css$/i.test(引用)) css队列.push(全);
    }
  }
  return { 缺失, 已剥离: [...new Set(已剥离)].sort(), 扫了: 已查.size, 对比缺 };
}

function main() {
  const 参 = process.argv.slice(2);
  const 严格 = 参.includes("--严格");
  const 对比位 = 参.indexOf("--对比");
  const 对比root = 对比位 >= 0 ? path.resolve(参[对比位 + 1]) : null;
  // 注意：没有 --对比 时 对比位=-1，若照旧写成 i !== 对比位+1 会把第一个参数当对比值吃掉
  const rootArg = 参.filter((a, i) => !a.startsWith("--") && (对比位 < 0 || i !== 对比位 + 1))[0];
  const root = path.resolve(rootArg || path.join(__dirname, ".."));

  const r = 体检(root, 对比root);
  const 名 = path.basename(root) || root;
  const 破 = r.缺失.length + (严格 ? r.已剥离.length : 0);
  if (!破) {
    console.log("[引用] " + 名 + " ✓ " + r.扫了 + " 条本地引用：必须在的都在"
      + (r.已剥离.length ? "；另 " + r.已剥离.length + " 条指向已剥离的美术/音频（设计如此）" : ""));
    process.exit(0);
  }
  console.log("[引用] " + 名 + " ✗ 扫了 " + r.扫了 + " 条，必须存在的缺 " + r.缺失.length + " 条：");
  for (const m of r.缺失) {
    console.log("  · " + m.引用 + (m.对比 ? "  —— 对比目录里没有" : "  —— 被 " + m.来自 + " 引用"));
    console.log("      → " + m.解析到);
  }
  if (严格 && r.已剥离.length) {
    console.log("  （--严格）另有 " + r.已剥离.length + " 条已剥离美术/音频也算失败：");
    r.已剥离.slice(0, 5).forEach((u) => console.log("      · " + u));
    if (r.已剥离.length > 5) console.log("      · …… 还有 " + (r.已剥离.length - 5) + " 条");
  }
  console.log("  修法：把文件放回它被引用的那个位置（子目录搬家会直接打断引用）。");
  process.exit(1);
}
main();
