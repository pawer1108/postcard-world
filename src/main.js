/* 《寄一个世界给你》—— 主流程
   两种模式共用同一个 URL：
     没有 hash  → 创作者模式（做一个世界，拿到链接）
     有  #w=... → 收件人模式（走进别人送的世界）
   没有后端、没有登录：世界整个压在链接里。
*/
import * as THREE from 'three';
import { SKIES, OBJECTS, MAX_OBJECTS, REPLY_CHOICES, makeEmptyState, starterWorld, demoWorld, readHash, encodeState, decodeState, budget, MINI, CAPSULE_VERSION, capsuleLines, capsuleDays, growthFactors, autumnMix, SHOT_NOW } from './state.js';
import * as W from './world.js';
import { createAudio } from './audio.js';
import { createAttention, applyAttention } from './attention.js';
import { createReplyAnimation } from './reply.js';
import { createPost, softDotTexture, puddleMaskTexture, rainStreakTexture, DEFAULT_GRADE } from './post.js';
// 界面语言（中文 / English）。词典与判定规则见 src/i18n.js —— 不在这里散写字符串。
import { t, lang, setLang, applyI18n, skyName, objectName } from './i18n.js';

const $ = (id) => document.getElementById(id);

/* ---------------- 失败可见：手机上唯一的信息出口 ----------------
   背景：有用户反馈**手机端只有 UI、世界里一片空白（黑屏）**，
   而桌面与"移动仿真"（CDP 的 setDeviceMetricsOverride）都复现不出来 ——
   仿真走的是桌面渲染路径（SwiftShader），真机的驱动/内存/WebGL 能力都不一样。
   既然够不到真机，至少不让它无声地黑：
     · 任何未捕获错误 / Promise 拒绝 → 显示在入场浮层上（可读、可长按复制）
     · 建世界失败 → 同样显示，并把设备信息一起带上
   这块文字是给**人**看的，所以中英并排，不跟着 i18n 走。            */
function reportFatal(title, err) {
  const msg = (err && (err.stack || err.message)) ? (err.stack || err.message) : String(err);
  let gpu = '(未取到)';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (gl) {
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = (d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?') + ' / ' + gl.getParameter(gl.VERSION);
    } else gpu = '拿不到 WebGL 上下文';
  } catch (e) { gpu = '取 WebGL 信息时又抛错: ' + e.message; }
  const info = `[${title}]\n${msg}\n\n`
    + `UA: ${navigator.userAgent}\n`
    + `视口: ${innerWidth}×${innerHeight} @${devicePixelRatio}x  canvas: ${innerWidth * Math.min(devicePixelRatio, 2)}×${innerHeight * Math.min(devicePixelRatio, 2)}\n`
    + `GPU: ${gpu}\n`
    + `WebGL2: ${!!document.createElement('canvas').getContext('webgl2')}\n`
    + `链接: ${location.href.slice(0, 120)}`;
  window.__fatal = info;                       // 也留给验收脚本读
  const el = $('intro-fatal');
  if (el) { el.textContent = info; el.classList.remove('hidden'); }
  console.error(title, err);
}

addEventListener('error', (e) => {
  // 资源加载失败也会走这里，但那种没有 error 对象，忽略掉免得误报
  if (e && e.error) reportFatal('运行时错误 / Runtime error', e.error);
});
addEventListener('unhandledrejection', (e) => reportFatal('未处理的 Promise / Unhandled rejection', e.reason));

/* ---------------- 渲染器 / 场景 ----------------
   ⚠️ 移动端三个已知脆弱点，都在这里处理：

     1. **WebGL2 不可用**（老 iOS Safari / 某些安卓 WebView）→ three r180 只走 WebGL2。
        这里主动探一下：拿不到就立刻报出来，而不是让后面某处抛出难以定位的异常。

     2. **内部分辨率过高 → 手机 GPU 被填充率压垮**。手机 devicePixelRatio 常是 3，
        canvas 内部就是 视口×3；再叠后期处理那几趟渲染（渲染目标 → 辉光 → 色调映射），
        一次要写好几百万像素。这是"只有 UI、世界一片空白"最常见的成因 ——
        它不是崩溃，是**画不出来**，所以没有任何异常可抓。
        对策：手机上把像素比上限压到 1.25，并给 canvas 总面积设一个硬顶。
        观感几乎无差别（手机屏小、像素密），但填充量降到约 1/5。

     3. **后期处理比自己渲染脆弱得多**（要多开浮点渲染目标）。
        见下面 renderFrame()：它挂了就永久降级为直出渲染，宁可朴素不能黑屏。 */

// "像手机"的判据：触摸 + 窄视口。不用 UA 嗅探 —— 它容易被伪装，
// 而且我们要判断的是"算力与屏幕"，不是"品牌"。
const isMobileLike = (navigator.maxTouchPoints > 0 || 'ontouchstart' in window)
  && Math.min(innerWidth, innerHeight) <= 820;

/* 动效偏好。**只关装饰性运动**：入场浮层的呼吸、走路时的镜头起伏与侧倾。
   不关"走进世界""那句话浮出"—— 那是作品的内容，不是点缀。
   matchMedia 在很老的浏览器上可能不存在，所以护一层。 */
const reduceMotion = (() => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
})();

const _probeCanvas = document.createElement('canvas');
if (!_probeCanvas.getContext('webgl2')) {
  reportFatal('浏览器不支持 WebGL2 / WebGL2 unavailable',
    new Error('This browser/device does not provide a WebGL2 context.'));
}

/** 画布内部像素比上限：桌面 1.75、手机 1.5（见上面第 2 条的理由）。
 *  1.25 试过：填充量是小了，但手机屏像素密，边缘明显发糊、光晕变大。
 *  1.5 是"清晰度"与"填充量"的折中（相对 3.0 是 1/4 的像素量）。 */
const MAX_DPR = isMobileLike ? 1.5 : 1.75;
/** 画布总像素硬顶：约 2.3MP。超过这个数，手机 GPU 基本要出事 */
const MAX_CANVAS_PIXELS = 2.3e6;

/** 把渲染尺寸限制在硬顶以内。返回实际使用的像素比。
 *  注意：这里算的是**内部缓冲**大小，CSS 尺寸照旧铺满视口，所以画面不会被缩小。 */
function fitRenderer(w, h) {
  const dpr = Math.min(devicePixelRatio || 1, MAX_DPR);
  const total = w * h * dpr * dpr;
  const k = total > MAX_CANVAS_PIXELS ? Math.sqrt(MAX_CANVAS_PIXELS / total) : 1;
  const use = Math.max(0.75, dpr * k);          // 不低于 0.75，免得糊到看不清
  renderer.setPixelRatio(use);
  renderer.setSize(w, h);
  return use;
}

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
const BOOT_DPR = fitRenderer(innerWidth, innerHeight);
console.log(`[render] 移动端=${isMobileLike} 设备像素比=${devicePixelRatio} 实际使用=${BOOT_DPR.toFixed(2)} `
  + `画布=${Math.round(innerWidth * BOOT_DPR)}×${Math.round(innerHeight * BOOT_DPR)}`);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// 阴影不是为了好看，是为了让物件"落在地上"——没有影子它们像浮在盘子上
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1 * MINI, 200);

/** 竖屏时把 FOV 放宽：透视相机的 fov 是"垂直"视角，手机竖屏 aspect≈0.46，
    横向视野会被压得很窄，世界看着空荡荡。按比例补偿，让竖屏也能看全。 */
function updateFov() {
  const aspect = innerWidth / innerHeight;
  camera.aspect = aspect;
  camera.fov = aspect < 1 ? Math.min(90, 62 + (1 - aspect) * 40) : 62;
  camera.updateProjectionMatrix();
}
updateFov();
const ambient = new THREE.AmbientLight(0xffffff, 0.6);
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
/* 主光仰角是**画面好不好看的第一号参数**，而它长期是错误的：
   原来是 (6,12,8)，仰角 50° —— 那是正午的几何，影长只有 0.83 倍物高。
   结果是"黄昏的配色 + 正午的光"：地面被照得均匀平坦，没有一处阴影，
   因为一盏 50° 的灯等于没有方向性。
   参考稿写明黄昏仰角 8–12°（"低角度是关键"）：仰角 12° 时影长是物高的 4.7 倍，
   0.15 米的草就能在地上拖出 0.7 米的影子 —— 那片"什么都没有"的空地
   于是被草的影子填满，画面立刻有了方向与体积。
   方位角取 37°（原来就是这个方向），让影子从画面左后方往右前拖。 */
const SUN_ELEV_DEG = 12;          // 相对地面的仰角
const SUN_AZIM_DEG = 37;          // 方位角
const SUN_DIST = 14;              // 距离只影响阴影相机的 near/far，不影响方向
function sunPos(elevDeg, azimDeg, dist) {
  const e = elevDeg * Math.PI / 180, a = azimDeg * Math.PI / 180;
  return [Math.sin(a) * Math.cos(e) * dist, Math.sin(e) * dist, Math.cos(a) * Math.cos(e) * dist];
}
sun.position.set(...sunPos(SUN_ELEV_DEG, SUN_AZIM_DEG, SUN_DIST));
sun.target.position.set(0, 0, 0);
scene.add(sun.target);           // 方向光不指向目标就不会更新阴影相机朝向
// 阴影相机范围：世界半径 6.5 米 + 物件散布，±12 留了余量。
// 开太大等于把 1024² 的阴影贴图摊薄，接触阴影会糊；开太小则远处物件没影子。
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
// 阴影相机范围：低角度光会把影子拉得很长（12° 时 4.7 倍物高），
// 范围要放到能装下影子的主体部分，同时别把 1024² 的贴图摊得太薄。
sun.shadow.camera.left = -13;
sun.shadow.camera.right = 13;
sun.shadow.camera.top = 13;
sun.shadow.camera.bottom = -13;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 40;
sun.shadow.bias = -0.0008;
scene.add(ambient, sun);

const clock = new THREE.Clock();

// 后期：辉光。用 composer 之后，场景渲染都走 post.render()
const post = createPost(renderer, scene, camera);
const DOT_TEX = softDotTexture(64);   // 程序生成的柔光点，供粒子与云使用
const RAIN_TEX = rainStreakTexture(32, 128);  // 雨丝：不给贴图的话 Points 会画成方块
const PUDDLE_TEX = puddleMaskTexture(512);  // 水洼遮罩：白色处才出现水面

/* ---------------- 路由 ---------------- */
/* 落地页策略：**没有 `#w=` 的人，直接带他走进一个世界，而不是丢给他创作面板。**
   理由（这是提交策略，不是技术选择）：比赛的评委每条作品只有一两分钟。
   创作面板看起来像一个"3D 摆件编辑器"——他可能就此形成印象、划走，
   而真正能打动他的东西（走进去、走到中心、那句话浮出来）藏在另一条链接里。
   所以我们**不赌评委先点哪条链接**：两条都落到体验上。
   他要做自己的世界，入口是页面里明确的一行，以及 `?create=1`。 */
/* ⚠️ query 判定必须写成 `(?:^|[?&])`，**不能**写成 `(?:^|&)`。
   后者漏掉了开头的 `?` —— 而 `location.search` 是带 `?` 的（`"?create=1"`），
   于是它**永远匹配不上**：`?create=1`、`?x=1&create=1` 全判 false，
   只有 `&create=1&…` 这种中间位置才可能命中。这是一段从未生效过的死代码，
   排查它花了两轮（页面不报错，只表现为"落在错的模式上"）。
   同一个错误原本也复制在拍摄模式的 `take=1` 判定里，一起修。 */
const hasQueryFlag = (name) => new RegExp('(?:^|[?&])' + name + '=1(?:&|#|$)').test(location.search);
const browse = hasQueryFlag('create');
// 自动带进来的样例世界：它决定了开场文案要说"这是别人收到的"，而不是"有人给你留了一个"
const demoFirst = !browse && !/#w=/.test(location.hash);
/* 路由：三种情形
     · `?create=1`      → 创作者面板（显式）
     · 空 URL           → **样例世界**。readHash 对空 hash 的既定语义是"创作者模式"，
                          所以这里必须显式覆盖掉它 —— 第一版只写了 browse 那一半，
                          于是空 URL 仍然落在编辑器上，新规则等于没生效。
     · 带 `#w=…`        → 照旧走 readHash（真正的链接、#w=demo、坏链接提示都不受影响） */
const route = browse ? { mode: 'create', state: null }
  : demoFirst ? { mode: 'receive', state: demoWorld() }
    : readHash(location.hash);
/* 把路由判据原样暴露出来 —— 这一段的调试极难：落地页行为不对外报错，
   只能看到"落在哪个模式"，看这个函数就知道它当时读到了什么。
   （tools/probe-capsule 那一类工具也是靠这套钩子才查到问题的。） */
window.__route = () => ({
  search: location.search, hash: location.hash, browse, demoFirst, mode
});
// 拍摄模式：URL 里带 take=1。相机走固定路径，时间由外部逐帧给定（window.__seek(t)），
// 因此每一帧都完全可复现 —— 换上真 Tripo 资产后能直接重拍，不用重新设计运镜。
// ⚠️ 这里的 `(?:^|&)` 是**对的**，别照着上面 browse 的修法一起改：
// 它作用在**去掉 `#` 的 hash** 上（`"w=abc&take=1"`），那一串里没有 `?`，`&` 就够。
// 逐例量过：`#w=abc&take=1` / `#take=1` / `#w=abc&take=1&x=2` 三种写法都命中，`#take=10` 不命中。
const takeMode = /(?:^|&)take=1(?:&|$)/.test(location.hash.replace(/^#/, ''));
let mode = route.mode;
// 创作者模式从一个"起手世界"开始，而不是空白画布
let state = route.state || (route.mode === 'create' ? starterWorld() : makeEmptyState());
if (route.broken) notice(t('noticeBroken'));

/* 时间胶囊：这个被封存的世界"几岁了"。
   ⚠️ 拍摄模式（take=1）不能把天数归零 —— 那等于**拍摄时把"变老"整个关掉**，
   演示片里永远看不到这条功能（这个坑真的踩过：探针用 take=1 拍，
   于是所有天数拍出来一模一样，我一度以为功能没生效）。
   但拍摄又必须逐帧可复现，不能随"今天几号"漂移。
   解法是给拍摄一个**固定时刻**（SHOT_NOW，定义在 state.js 里，
   量测工具读同一个常量），于是 take 截图既确定、又真的会老。 */
const AGE_NOW = takeMode ? SHOT_NOW : Date.now();
const ageDays = capsuleDays(state, AGE_NOW);
const capLines = capsuleLines(state, AGE_NOW);

document.body.className = takeMode ? 'mode-take' : 'mode-' + mode;
// 自动落到样例世界时打个标记：开场那一行文案与"我也做一个"的入口都靠它（见 index.html 的 CSS）
if (demoFirst) document.body.dataset.demoFirst = '1';
// 收件人一进来是"被薄幕遮着"的状态：世界在下面若隐若现，
// 但 HUD、准星、那句话都藏起来 —— 他还没走进去，不该先看见结局。
// 拍摄模式不受影响（它本来就不显示 HUD）。
if (mode === 'receive' && !takeMode) document.body.classList.add('veiled');

let worldGroup = new THREE.Group();
scene.add(worldGroup);
let weather = null;
let motes = null;
let clouds = null;
let puddles = null;
let core = null;
const placedMeshes = new Map();   // objectId -> THREE.Group
const glowLights = [];            // 发光物挂的点光源，逐帧摇曳
let attention = null;             // 世界对移动的反应（见 attention.js）
let buildToken = 0;
// 草丛的实测量（簇数 / 顶点数）。**给探针用**：时间胶囊到底有没有改变草量，
// 只能从这几个数上读 —— 屏幕像素在低帧率下拍的图未必看得出密度差，
// 而"没生效"与"生效了但看不出来"是两件完全不同的事。
let scatterStats = null;

/* ---------------- 音景 ---------------- */
const audio = createAudio();

/** 浏览器要求音频必须由用户手势启动；第一次点/按就悄悄接上 */
function armAudio() {
  audio.resume();
  audio.setScene((SKIES[state.t] || SKIES[0]).sound);
  removeEventListener('pointerdown', armAudio);
  removeEventListener('keydown', armAudio);
}
addEventListener('pointerdown', armAudio);
addEventListener('keydown', armAudio);

/* ---------------- 造世界 ---------------- */
async function buildWorld() {
  const token = ++buildToken;
  const sky = SKIES[state.t] || SKIES[0];

  // 清掉上一版
  worldGroup.traverse(o => {
    if (o.isMesh || o.isPoints) {
      o.geometry?.dispose?.();
      if (Array.isArray(o.material)) o.material.forEach(m => m.dispose?.());
      else o.material?.dispose?.();
    }
  });
  scene.remove(worldGroup);
  worldGroup = new THREE.Group();
  scene.add(worldGroup);
  placedMeshes.clear();
  glowLights.length = 0;

  W.applySky(scene, sky);
  ambient.intensity = sky.ambI;
  sun.color.setHex(sky.sun);
  sun.intensity = sky.sunI;
  audio.setScene(sky.sound);

  worldGroup.add(W.createGround(sky));
  // 草簇 / 石子 / 落叶。把物件位置传进去，才能做到"物件脚下留白"。
  // ageDays 交给它：草的数量、高度、色相都随"这个世界几岁了"变（见 src/age.js）
  const scatter = W.createScatter(sky, state.o, undefined, ageDays);
  worldGroup.add(scatter);
  // 把草丛的实测量记下来（见 scatterStats 的说明）。同一个天数必须永远得到同一组数，
  // 所以这几个数也是"确定性"的一部分：变了就说明播种顺序被打乱了。
  {
    const tufts = [];
    scatter.traverse(o => {
      if (o.isInstancedMesh) tufts.push({ count: o.count, verts: o.geometry.attributes.position.count });
    });
    scatterStats = {
      tufts: tufts.length,
      clusters: tufts.reduce((a, t) => a + t.count, 0),
      verts: tufts.reduce((a, t) => a + t.count * t.verts, 0),
      tall: (scatter.userData.tallSpots || []).length
    };
  }
  /* 下面这些是**可有可无的视觉装饰**：水洼反射要开渲染目标（手机 GPU 最吃力）、
     云、飞尘、雨雪、星星。任何一个失败都不该拖垮"走进世界"这条主线 ——
     所以逐个护起来，失败就跳过并在控制台留一行，不弹给用户看。
     水洼是这一组里最可疑的：Reflector 每帧要多渲染一遍场景，且依赖浮点纹理。 */
  const optional = (name, fn) => {
    try { return fn(); }
    catch (err) { console.warn('[world] 可选系统「' + name + '」初始化失败，已跳过：', err); return null; }
  };

  // 反射器每套天色重建一次，旧的渲染目标必须显式释放，否则换几次天色就漏几个
  if (puddles) {
    optional('释放旧水洼', () => {
      puddles.geometry.dispose();
      puddles.material.dispose();
      puddles.getRenderTarget?.()?.dispose?.();
    });
  }
  puddles = optional('水洼反射', () => W.createPuddles(sky, PUDDLE_TEX));
  if (puddles) worldGroup.add(puddles);
  worldGroup.add(W.createRidges(sky));           // 远山剪影：让世界像"大世界里的一角"
  clouds = optional('云层', () => W.createClouds(sky, DOT_TEX));
  if (clouds) worldGroup.add(clouds);
  if (sky.stars) optional('星空', () => worldGroup.add(W.createStars(state.t + 1)));

  motes = optional('飞尘光点', () => W.createMotes(sky, DOT_TEX));
  if (motes) worldGroup.add(motes);

  // 雨用竖直细条、雪用柔圆点 —— 两者形态不同，贴图不能共用
  weather = optional('雨雪', () => W.createWeather(sky.weather || null, sky.weather === 'rain' ? RAIN_TEX : DOT_TEX));
  if (weather) worldGroup.add(weather);

  /* 调色与曝光都要跟着天色走：天色是用户可选的，星夜与正午的画面明度差十倍以上，
     一个固定增益不可能同时服务两头（实测固定增益会把正午天空顶到 99/255）。
     这一组只在"改后期"的时候会抛，护起来 —— 抛了也不该让世界建不起来。 */
  optional('调色与曝光', () => {
    post.setSky(sky);
    if (GRADE_RAW) {
      const [ct, li, ga, gm, sa] = GRADE_RAW;
      post.grade.uniforms.uContrast.value = ct;
      post.grade.uniforms.uLift.value = li;
      post.grade.uniforms.uGain.value = ga;
      post.grade.uniforms.uGamma.value = gm;
      post.grade.uniforms.uSat.value = sa;
    } else {
      post.setSkyGrade(sky);
    }
  });

  core = W.createCore(sky);
  worldGroup.add(core);

  // 物件
  // 烘焙 AO 需要知道"周围有什么"：其它物件用各自留白半径（件越大，遮得越远），
  // 高草锚点用它们自己的散布半径。矮草不入列——它铺满全场，算进去等于全局蒙灰。
  const placedXZ = state.o.map(([id, x, z]) => {
    const def = OBJECTS.find(o => o.id === id) || OBJECTS[0];
    // 走 fromStored：存储单位→世界米的换算只应有一处（这里原先是写死的 x/10，
    // MINI=1 时结果一样，但尺度一改就会错开）
    return { x: W.fromStored(x), z: W.fromStored(z), r: W.clearingRadius(def) };
  });
  const scatterSpots = (scatter.userData.tallSpots || []).map(s => ({ x: s.x, z: s.z, r: 0.16 }));

  /* 真实加载进度。为什么值得做：世界搭好之前只有「正在准备…」三个字，
     而首屏要下 9 个 GLB（瘦身前 7.6 MB）—— 手机上等十秒且毫无反馈，等的人会直接关掉。
     数字是**真的**：数的是 createObject 真完成了几件，不是定时器估的。
     失败件数也一并数出来（资产 404 时是静默回退成占位体的，见清单第 23 条）。 */
  let loadedCount = 0, failedCount = 0;
  const totalToLoad = state.o.length;
  const progress = (ok) => {
    if (ok) loadedCount++; else failedCount++;
    const el = $('intro-enter');
    if (!el || el.disabled === false) return;      // 已经解锁就别再改它的字了
    const txt = t('loadingParts', loadedCount, totalToLoad)
      + (failedCount ? ' · ' + t('loadingFailed', failedCount) : '');
    el.textContent = txt;
  };

  const built = await Promise.all(state.o.map(([id, x, z], i) => {
    const def = OBJECTS.find(o => o.id === id) || OBJECTS[0];
    // 排除自己：否则物件会被自己的留白半径压暗一圈
    const neighbours = placedXZ.filter((_, k) => k !== i).concat(scatterSpots);
    return W.createObject(def, x, z, neighbours, sky, ageDays)
      .then((g) => { progress(g?.userData?.source === 'tripo'); return g; })
      .catch((e) => { progress(false); throw e; });
  }));  if (token !== buildToken) return; // 期间又重建了，丢弃这一批
  for (const g of built) {
    worldGroup.add(g);
    placedMeshes.set(g.userData.objectId, g);
    if (g.userData.light) glowLights.push(g.userData.light);
  }

  /* 建立"注意力"跟踪：只给**会回应**的物件建条目（灯、蜡烛这类发光物）。
     不发光的物件（石头、木桩、纸船）没有可调制的属性，
     硬加一层发光反而会变成廉价的闪烁 —— 不如不回应。
     反应半径 2 米、一次即逝，理由见 src/attention.js 的说明。 */
  attention = createAttention(
    built
      .filter(g => g.userData.light)
      .map(g => {
        const def = OBJECTS.find(o => o.id === g.userData.objectId);
        return {
          x: g.position.x, z: g.position.z, obj: g.userData.light,
          // glow 很强的当蜡烛（烛火摇曳），其余当灯（整盏亮一档）
          kind: (def?.glow ?? 0) >= 3 ? 'candle' : 'lamp',
          name: def?.name || ''
        };
      })
  );

  backToStart();
  if (mode === 'receive') {
    // 把相机**明确地**摆到入场起点。不能靠"它反正会被设对"：
    // 默认位置是原点，也就是世界的正中心 ——
    // 于是"走到中心才浮现"的判定在页面一加载就成立，
    // 那句话和「回一封信」会在薄幕后面先亮起来（实测就是这么发现的）。
    // 现在这里与 findFreeSpot() 用的是同一套判定，两边不会再各说各话。
    camera.position.set(0, W.EYE_HEIGHT, W.SPAWN_RADIUS);
    camera.rotation.set(0, 0, 0);
    yaw = 0; pitch = 0;   // 与 backToStart 同一套姿态，理由见那个函数的说明
    /* 名字那行只在**这一处**写（曾经在别处又写了一遍，改一处漏一处）。
       自动进来的样例世界要说清"这是别人收到的世界" ——
       不装成"有人给你留了一个"：评委没收到过谁的东西，装出这层关系反而假。 */
    /* ⚠️ 调试用的探针：名字这一行出过一次"页面上没有那个元素"的问题
       （验收脚本读到 null），而单看代码完全正常。留一个可读的现场记录，
       下次不用再靠推理（window.__intro 能直接说出填了几次、填成了什么）。 */
    const nameEl = $('intro-name');
    const wantName = demoFirst ? t('introNameDemo')
      : (state.n ? t('giveTo', state.n) : t('giveToYou'));
    window.__intro = (window.__intro || { runs: 0, log: [] });
    window.__intro.runs++;
    window.__intro.log.push({ want: wantName, elFound: !!nameEl, demoFirst, lang, n: state.n });
    if (!nameEl) console.error('[intro] #intro-name 不存在 —— 页面结构或注入顺序出了问题');
    else nameEl.textContent = wantName;
    $('intro-line').textContent = demoFirst ? t('introLineDemo') : t('introLine');
    /* 时间胶囊：封存多久了。**0 天不显示**（「这个世界，0 天了」是语法错误），
       所以刚留给自己、当天就打开的话，这一行不出现 —— 与分享链接长得一样。
       文案与天数在**路由那一段**已经算好（capLines / ageDays），这里只负责放进 DOM。
       ⚠️ 名字那行必须在 if 之外。它曾经被一起放进下面这个 if 里，
       于是 0 天的胶囊**连名字都不显示**（收件人只看到「给你」）——
       "天数为 0 时不显示天数"绝不等于"不显示这个世界"。 */
    if (capLines) {
      const el = $('intro-wait');
      // 文案走 i18n：天数那行是"事实"，两种语言下都得是完整句子（见 i18n.js 的 waitLine）
      if (el) { el.textContent = t('waitLine', capLines.days); el.classList.remove('hidden'); }
    }
    $('msg-text').textContent = state.m || '';
    // 中心那行天数与开场同一份文案（capLines 在路由那里算过一次）——
    // 只在这里**放进 DOM**，显不显示仍由 updateCamera 的 #msg.on 决定
    if (capLines) {
      const mw = $('msg-wait');
      if (mw) { mw.textContent = t('waitLine', capLines.days); mw.classList.remove('hidden'); }
    }
    /* 回信闭环的**另一半**（清单第 12 条）：这一页是别人回过信的世界。
       创作者打开回信链接时，原本看到的是"自己写的世界原样" —— 没有任何东西
       告诉他这里有另一个人来过。而"有人真的走进去了"正是这条主干唯一的回报。
       三件事都在状态里，一个字节都不用多花：
         · `intro-line` 说清这是"你寄出去的那个世界"（而不是又一个预览）
         · `intro-wait` 借用同一行位置，报出"他回来过"与唤醒了 N 件东西
         · 中心那行放收件人写的话（他的回信本身） */
    if (state.r) {
      const line = $('intro-line');
      if (line) line.textContent = t('replyBackCame');
      const el = $('intro-wait');
      if (el) {
        el.textContent = state.r.g > 0 ? t('replyAwoke', state.r.g) : t('replyCameOnly');
        el.classList.remove('hidden');
      }
      const mw = $('msg-wait');
      if (mw && state.r.m) { mw.textContent = state.r.m; mw.classList.remove('hidden'); }
      else if (mw && state.r.g > 0) { mw.textContent = t('replyAwoke', state.r.g); mw.classList.remove('hidden'); }
    }
  }

  syncDiagnostics();
}

/** 发光物逐帧摇曳：火苗不该是恒定的 */
function flickerLights(t) {
  for (let i = 0; i < glowLights.length; i++) {
    const l = glowLights[i];
    const base = l.userData.base || l.intensity;
    l.intensity = base * (1 + Math.sin(t * 3.1 + i * 2.1) * 0.13 + Math.sin(t * 7.3 + i * 0.7) * 0.06);
  }
}

/** 世界对移动的反应：走近灯 / 蜡烛时它们回应你。
 *  必须**在天色重建之后**调用（物件换一批，attention 也要跟着换）。
 *  顺序要紧：先让 flickerLights 写摇曳结果，再由 attention 在**结果上**叠一层反应 ——
 *  两边都从基准值算的话，后写的那次会把前一次直接覆盖掉。 */
function updateAttention(dt, t, px, pz, afterFlicker) {
  if (!attention) return 0;
  afterFlicker();                       // 摇曳先落地
  attention.update(dt, px, pz);
  for (const s of attention.state) {
    s.obj.intensity = applyAttention(s, s.obj.intensity, t);
  }
  // 第一次走近某件东西时给一声极轻的响 —— 让"它注意到我了"这件事被听见
  if (attention.consumeNewGreeting()) audio.blip();
  // 把响应度暴露出来：它和灯光摇曳叠加在一起，从 intensity 上分不出来，
  // 所以核查这个机制只能直接读它（见 tools/probe-attention.mjs）
  window.__attention = () => attention.state.map(s => ({
    name: s.name, kind: s.kind, hit: +s.hit.toFixed(3), greeted: s.greeted,
    x: +s.x.toFixed(2), z: +s.z.toFixed(2)
  }));
  return attention.greetedCount;
}

/** 把"每件物件用的是真模型还是占位体"暴露到 DOM 上——
    这样无头浏览器一个 --dump-dom 就能验收资产管线，不用人眼盯画面。 */
function syncDiagnostics() {
  const list = [...placedMeshes.values()].map(g => `${g.userData.objectId}:${g.userData.source}`);
  document.body.dataset.models = list.join(' ');
  // 归一化前的原始最大边长：用来核对 auto_size 有没有猜错比例
  document.body.dataset.fitted = [...placedMeshes.values()]
    .map(g => `${g.userData.objectId}=${g.userData.fitted ?? '?'}`).join(' ');
  document.body.dataset.ready = '1';
}

/* ---------------- 相机控制 ---------------- */
// 创作者：绕世界中心的轨道视角。
// 太远会把整块地推进雾里发灰，太近又看不全 —— 9 设计米是"站在世界边缘往里看"的位置，
// 观感与收件人视角统一。按世界尺度换算。
const orbit = { theta: Math.PI * 0.25, phi: 1.16, radius: 9 * MINI };
// 收件人：第一人称
let yaw = Math.PI, pitch = 0;
const keys = new Set();
let walking = false;

// 收件人入场动画：0 → 1，1 表示已经落地。
// 必须按**真实时间**推进，不能按帧累加：主循环把 dt 钳在 0.05 秒以内（防止切标签页后跳帧），
// 所以在低帧率机器上按帧累加会把 3.4 秒的动画拉成十几秒的慢动作——实测软件渲染下就是这样。
const DESCENT_TIME = 3.4;
let descentT = 1;
let descentStart = 0;
function resetDescent() { descentT = 0; descentStart = performance.now(); vel.set(0, 0, 0); }

/** 把相机摆回"还没进去"的起始姿态。
 *  入场起点只有这一处定义 —— 页面加载时与点「走进去」时都走它，
 *  免得两处各写一遍、其中一处漏改（这正是上一个 bug 的来源）。
 *
 *  ⚠️ yaw 必须是 **0**，不是 π。推导（与 updateCamera 里那两行必须一致）：
 *    · 视线方向 = (sin yaw, 0, cos yaw)（见 updateCamera 的 look 向量）
 *    · 前进方向 = -(sin yaw, 0, cos yaw)（见 dir 与 multiplyScalar(-fwd)）
 *    两者是**同一个 (sin yaw, cos yaw)**，所以"面朝中心"与"向前走会靠近中心"
 *    是同一个条件：站在 (0, ·, +5.3) 要面朝原点，必须 yaw = 0。
 *    写成 π 时相机背对世界、而按住 W 却在远离中心 ——
 *    只是下降动画里的 lookAt 把它翻回了 0，真实姿态才没暴露出来。
 *    （这个错误一直被入场浮层挡着，属于"看起来没问题"的那一类。） */
function backToStart() {
  camera.position.set(0, W.EYE_HEIGHT, W.SPAWN_RADIUS);
  camera.rotation.set(0, 0, 0);
  yaw = 0; pitch = 0;
  vel.set(0, 0, 0);
}

// 走路的状态：速度（做加减速）与呼吸相位（按距离累加）
const vel = new THREE.Vector3();
let bobDist = 0;
// 「那句话」浮现时的曝光呼吸（0 → 1）。全片最亮的一刻留给读到它的瞬间。
// 基准曝光不在这里 —— 它由 post.exposureOf() 统一给（含天色补偿），
// 在别处再写一个 1.15 会把天色补偿整个覆盖掉（踩过这个坑）。
let reveal = 0;

/* 那句话是**一次不可撤销的事件**，不是一个贴片。三条状态合起来保证这件事：
 *   `msgSeen`       —— 读到过就不再"没读到"。走出触发圈它不会消失（只是变淡），
 *                      chime 与曝光抬升也**只在第一次**触发。
 *   `lookedAround`  —— 他有没有主动转过视角。朝向判据只在转过之后才参与，
 *                      否则"按住向前直着走进去"会永远读不到那句话（而那正是
 *                      演示片与验收脚本走的那条路 —— 判据不能比用户更严格）。
 *   `msgGateLogged` —— 把"当帧为什么没触发"吐到 window.__msgGate，
 *                      因为这一段的失败是静默的（不报错，只是那句话不出现）。 */
let msgSeen = false;
let lookedAround = false;
let msgChimed = false;
let msgGateLogged = null;

/** 把相机状态暴露出来，供控制测试断言方向（按需调用，不占每帧开销） */
window.__cam = () => ({
  x: +camera.position.x.toFixed(4),
  y: +camera.position.y.toFixed(4),
  z: +camera.position.z.toFixed(4),
  yaw: +yaw.toFixed(4),
  pitch: +pitch.toFixed(4),
  descent: +descentT.toFixed(3)
});
// 曝露后期，方便调参与排查（辉光强弱是主观的，得能现场比）
window.__post = post;
/* 调色方向。**默认就是选定值**（post.js 的 DEFAULT_GRADE）——
   作品不该带着一个未定项交付出去。
   `?grade=…` 只是给排查与标定留的旁路：
     ?grade=plain|film|warm|postcard  换方向对照
     ?grade=1.5,0.02,1.2,1.1,1.2      直接喂数值（contrast,lift,gain,gamma,sat）
   调色要按天色亮度退火，所以这里只记下选择，真正生效在 buildWorld → setSkyGrade。 */
const GRADE = new URLSearchParams(location.search).get('grade');
if (GRADE && !GRADE.includes(',')) post.setGrade(GRADE);
const GRADE_RAW = GRADE && GRADE.includes(',') ? GRADE.split(',').map(Number) : null;
// 曝露场景：tools/verify-ao.mjs 要遍历几何体核查顶点色烘焙是否真的生效。
// 光看截图判断不了 AO —— 发光的、贴地的物件本来就明暗不一。
window.__scene = scene;
// 曝露"这个世界几岁了"：时间胶囊那条链路的每一环（天数 → 系数 → 顶点数）
// 都必须能被外部读到，否则"没生效"和"生效了但看不出来"在屏幕上分不清。
// 同时曝露状态本身（名字/那句话/胶囊字段）—— 验收脚本要能核对"页面读到的世界"
// 与"链接里写的世界"是不是同一个，这是"名字/文案被写丢了"这类问题的唯一查法。
// ⚠️ `__nav` 是**这一页**的身份标记（每次加载都不同）：浏览器跳转时旧 DOM 会多留一会儿，
// 验收脚本靠它区分"读到的是新页面"还是"上一个页面的残留"（这个坑踩过好几次）。
window.__nav = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
window.__state = () => ({
  n: state.n, m: state.m, t: state.t, k: state.k ?? null, c: state.c ?? null,
  objectCount: state.o.length, reply: state.r ? { o: state.r.o, g: state.r.g } : null
});
window.__aging = () => ({
  days: ageDays,
  capsule: state.k === CAPSULE_VERSION,
  sealed: state.c ?? null,
  growth: growthFactors(ageDays),
  autumn: autumnMix(ageDays),
  scatter: scatterStats
});
/* 「那句话为什么没出现」的现场记录。
   这一段的失败是**静默的**：不报错、不抛异常，只是走进去什么都没有。
   所以把每个判据原样吐出来，排查时不用再靠推理（与 __route / __intro 同一套路）。 */
window.__msgGate = () => msgGateLogged;
window.__reveal = () => +reveal.toFixed(4);

function updateCamera(dt) {
  if (mode === 'create') {
    const r = orbit.radius;
    camera.position.set(
      r * Math.sin(orbit.phi) * Math.sin(orbit.theta),
      Math.max(1.2, r * Math.cos(orbit.phi)),
      r * Math.sin(orbit.phi) * Math.cos(orbit.theta)
    );
    // 右侧面板占了约 1/4 画面，视线略向右偏，世界就落在可见区域的中间
    camera.lookAt(0.85 * MINI, 1.0 * MINI, 0);
    return;
  }

  // 第一人称
  // 入场：先从高处俯视，再落到人眼高度。落地前不接受移动输入。
  // 直接站在地面会让人觉得"地图很大、我离得很远"；从上方压下来这几秒
  // 反而把世界的边界交代清楚了，落地时才有"我到了"的感觉。
  if (descentT < 1) {
    descentT = Math.min(1, (performance.now() - descentStart) / (DESCENT_TIME * 1000));
    const p = descentT * descentT * descentT * (descentT * (descentT * 6 - 15) + 10); // smootherstep
    const startY = 13 * MINI, startZ = 5.0 * MINI;
    const landZ = W.SPAWN_RADIUS;
    camera.position.set(0, startY + (W.EYE_HEIGHT - startY) * p, startZ + (landZ - startZ) * p);
    camera.lookAt(0, 1.0 * MINI + (W.EYE_HEIGHT - 1.0 * MINI) * p, 0);
    yaw = 0; pitch = 0;
    return;
  }

  // 成年人步速：常走 1.0–1.4 m/s，赶路 4.6 m/s 是跑。
  // 这里取 2.7 m/s 略快于真实步行 —— 世界直径只有 13 米，
  // 按 1.2 m/s 走完一圈要半分钟，交互会拖沓。
  const maxSpeed = (keys.has('shift') ? 4.6 : 2.7) * MINI;      // 米/秒
  let fwd = 0, strafe = 0;
  if (keys.has('w') || keys.has('arrowup') || walking) fwd += 1;
  if (keys.has('s') || keys.has('arrowdown')) fwd -= 1;
  if (keys.has('a') || keys.has('arrowleft')) strafe -= 1;
  if (keys.has('d') || keys.has('arrowright')) strafe += 1;

  // 期望速度：想往哪走、走多快。真正的位置更新交给下面的速度平滑。
  const wish = new THREE.Vector3();
  if (fwd || strafe) {
    // forward = -(sin yaw, 0, cos yaw)，right = (cos yaw, 0, -sin yaw)。
    // 两个都别再加负号：dir 本身已经是"后"，所以 fwd 要乘 -1；
    // 而 side 就是右向量，strafe 直接加即可（这里原先多乘了个 -1，导致 D 往左走）。
    const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    wish.copy(dir).multiplyScalar(-fwd).addScaledVector(side, strafe).normalize().multiplyScalar(maxSpeed);
  }

  // 速度平滑：起步有加速、松手有滑行 —— 直接赋值速度会像在冰上滑行，没有重量
  const accel = wish.lengthSq() > 0 ? 9 : 11;          // 刹车比起步略快
  vel.lerp(wish, 1 - Math.exp(-dt * accel));

  camera.position.x += vel.x * dt;
  camera.position.z += vel.z * dt;
  const d = Math.hypot(camera.position.x, camera.position.z);
  const lim = W.WORLD_RADIUS - 0.5 * MINI;
  if (d > lim) {
    camera.position.x *= lim / d;
    camera.position.z *= lim / d;
    vel.multiplyScalar(0.2);                            // 撞到边界就卸掉速度
  }

  // 呼吸感：按**走过的距离**算相位，不是按时间 —— 走得快频率自然快、停下就停，
  // 而且幅度随速度升降，起步和刹停都不会有突兀的跳动。
  // 幅度按真实人走路给：1.6 米眼高下头部晃动 3 厘米是自然的。
  // ⚠️ 尊重 prefers-reduced-motion：镜头起伏与前庭不适直接相关，
  // 而它**不是**作品的内容（内容是有没有走到中心）。侧倾同理。
  bobDist += vel.length() * dt;
  const moving = reduceMotion ? 0 : Math.min(1, vel.length() / (2.7 * MINI));
  camera.position.y = W.EYE_HEIGHT
    + Math.sin(bobDist * 3.4) * 0.030 * MINI * moving
    + Math.sin(bobDist * 6.8) * 0.009 * MINI * moving;

  const look = new THREE.Vector3(
    Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)
  );
  camera.lookAt(camera.position.clone().add(look.multiplyScalar(-1)));
  // 极轻微的侧倾：走路时视线不该像三脚架一样死平
  camera.rotateZ(Math.sin(bobDist * 1.7) * 0.012 * moving);

  // 脚步声跟着移动走
  audio.update(dt, !!(fwd || strafe));

  // 走到中心 → 那句话浮出来（同时响一声）。
  // 顺带把整体曝光抬一点：全片最亮的一刻应该出现在读到那句话的时候 ——
  // 这是"交互的高潮点"，比再多加几件物件有效。
  const distC = Math.hypot(camera.position.x, camera.position.z);
  const near = distC < W.CENTER_TRIGGER;
  /* 朝向判据：要求他**大致朝着中心**才触发。
     目的是"走过去撞到一句话"，而不是"踩到一块地砖"——
     背对着世界中心站着读一句写给他的话说不过去。
     为什么加 `lookedAround` 这个前提：按住「向前」直走是作品设计好的那条动线
     （演示片与验收脚本走的都是它），那条路上他可能一次都没转过视角。
     判据只在"他主动转过"之后参与，于是两种走法都成立。 */
  const facingCenter = distC < 1e-6
    || (-(camera.position.x / distC) * -Math.sin(yaw)
      + -(camera.position.z / distC) * -Math.cos(yaw)) >= 0;
  const faceOk = !lookedAround || facingCenter;
  const inRange = near && faceOk;
  if (inRange && !msgSeen) msgSeen = true;          // 读到就留住：一次性闩锁
  const showMsg = msgSeen && !!state.m;
  const msgEl = $('msg');
  msgEl.classList.toggle('on', showMsg);
  // 走远之后不消失，只降到 0.35（CSS 的 #msg.seen）—— 读到过的事实不该被脚步撤销
  msgEl.classList.toggle('seen', showMsg && !inRange);
  /* chime 与"全片最亮的一刻"都只在**第一次读到**的那一帧发生。
     旧写法 `if (showMsg) audio.chime();` 是逐帧调用（靠 audio.js 里的
     chimePlayed 守卫兜住），而且进出触发圈会让那句话反复闪、曝光跟着脚步上下浮动。 */
  if (msgSeen && !msgChimed && !!state.m) { msgChimed = true; audio.chime(); }
  // 静默失效探针：这一段的失败不报错，只会"那句话不出现"，所以把判据吐出来
  msgGateLogged = {
    dist: +distC.toFixed(3), trigger: W.CENTER_TRIGGER, near,
    facingCenter, lookedAround, faceOk, msgSeen, hasMsg: !!state.m
  };

  /* 走到中心之后才把「回一封信」放出来。
     顺序很重要：先读到那句话，才有资格回信 ——
     按钮一开始就在的话，他会先想着"这里有个按钮要点"，而不是先读完那句话。
     另外薄幕还没摘掉（body.veiled）时也不给 —— 那时候他连世界都还没进去。

     ⚠️ **不要再加 `state.r == null` 这个条件**（旧代码有，清单第 12 条）：
     它让"这个世界已经被回过信"变成"永久不能再回信" ——
     收件人改一个字、换一件载体都做不到，而那正是回信最常见的第二次动作。
     现在改成：读到那句话就可以回信，已经回过的话按钮文案变成「再回一封」。 */
  if (showMsg && !document.body.classList.contains('veiled')) {
    const b = $('btn-reply');
    if (b) {
      b.classList.remove('hidden');
      const label = state.r ? t('replyAgain') : t('reply');
      if (b.textContent !== label) b.textContent = label;
    }
  }

  /* 曝光呼吸：**只在第一次读到那一刻拉满**，之后停在 0.35 不再跟着脚步起伏。
     旧写法 `(showMsg ? 1 : 0)` 会让曝光随进出触发圈上下浮动 ——
     全片最亮的一刻应该只发生一次，否则它就不再是"一刻"。 */
  const revealWant = !showMsg ? 0 : (msgSeen && reveal > 0.99 ? 0.35 : 1);
  reveal += (revealWant - reveal) * Math.min(1, dt * 2.4);
  // 曝光 = 基准 × 天色补偿 ×「那句话」的呼吸。
  // 天色补偿由 post.setSky 算（夜色要额外提亮，否则屏幕几乎是黑的）——
  // 这里若还写死 BASE_EXPOSURE，就会把它整个覆盖掉。
  renderer.toneMappingExposure = post.exposureOf(1 + reveal * 0.11);
}

/* ---------------- 指针：拖动看 / 点击放置 ----------------
   ⚠️ 下面这一小段看起来啰嗦，但每一条都对应一个真实会卡住的操作：
   · 不筛 button → **右键点地面也会放置物件**（右键同样触发 pointerdown/up）
   · 不记 pointerId → 第二根手指按下会覆盖 drag、任一手指抬起就清空，
     多指操作会把拖拽打断成半截
   · 不监听 pointercancel / lostpointercapture → 触摸被浏览器判成滚动手势后
     pointerup 永远不来，松手后物件还跟着指针走、相机还在转
   · pointermove 不校验 buttons → 没按键的划过也会被当成拖拽
   这些在桌面鼠标上都不容易发现，但评委很可能用手机点开。 */
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let drag = null;
let selectedObject = null;
let draggingMesh = null;

/** 结束一次拖拽。撤回指针捕获、清掉状态 —— 正常抬手、被系统取消、丢失捕获都走这里 */
function endDrag(pointerId) {
  const el = renderer.domElement;
  try { el.releasePointerCapture?.(pointerId); } catch { /* 没捕获过 */ }
  draggingMesh = null;
  drag = null;
}

function pointerNDC(ev) {
  return new THREE.Vector2((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
}

function hitGround(ev) {
  raycaster.setFromCamera(pointerNDC(ev), camera);
  const p = new THREE.Vector3();
  return raycaster.ray.intersectPlane(groundPlane, p) ? p : null;
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  // 只认主键、主指针
  if (ev.button !== undefined && ev.button !== 0) return;
  if (ev.isPrimary === false) return;
  // 合成事件（自动化测试）的 pointerId 不是活跃指针，setPointerCapture 会抛错。
  // 真实用户不会触发，但没理由让它把整个交互处理打断。
  try { renderer.domElement.setPointerCapture?.(ev.pointerId); } catch { /* 非活跃指针 */ }
  drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: 0 };
  draggingMesh = null;

  // 创作者模式下，先试着"抓住"一个已放置的物件；抓不到才转视角
  if (mode === 'create' && selectedObject === null && placedMeshes.size) {
    raycaster.setFromCamera(pointerNDC(ev), camera);
    const hits = raycaster.intersectObjects([...placedMeshes.values()], true);
    if (hits.length) {
      let o = hits[0].object;
      while (o.parent && o.userData.objectId === undefined) o = o.parent;
      if (o.userData.objectId !== undefined) draggingMesh = o;
    }
  }
});

renderer.domElement.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  if (drag.id !== undefined && ev.pointerId !== undefined && ev.pointerId !== drag.id) return;
  const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  drag.x = ev.clientX; drag.y = ev.clientY;

  if (mode === 'create') {
    if (draggingMesh) {
      const p = hitGround(ev);
      if (p) {
        const x = clampWorld(p.x), z = clampWorld(p.z);
        // 走 placeOnGround：它会把模型自身的高度偏移与地形起伏一起算上。
        // 早先这里写的是 position.set(x, 0, z)，物件会沉进地里一半。
        W.placeOnGround(draggingMesh, x, z);
        writeBack(draggingMesh.userData.objectId, x, z);
      }
    } else {
      orbit.theta -= dx * 0.006;
      orbit.phi = Math.min(1.45, Math.max(0.25, orbit.phi - dy * 0.005));
    }
  } else {
    // 水平与垂直必须同一套约定：**往哪拖就往哪看**（手机视角摇杆的通行做法）。
    // 原先水平是"移动视角"、垂直却是"抓取世界"（往上拖反而低头），两套混用手感必然别扭。
    // 推导：视线方向 y = -sin(pitch)，所以"抬头"= pitch 变小；
    //      手指往上拖时 dy < 0，故 pitch 要加上 dy。
    yaw -= dx * 0.005;
    pitch = Math.min(0.95, Math.max(-0.85, pitch + dy * 0.004));
    // 他主动转过视角 —— 从那之后，"朝向中心"才参与那句话的触发判据（见 updateCamera）
    if (Math.abs(dx) + Math.abs(dy) > 2) lookedAround = true;
  }
});

renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!drag) return;
  if (drag.id !== undefined && ev.pointerId !== undefined && ev.pointerId !== drag.id) return;
  if (drag.moved < 6 && mode === 'create' && selectedObject !== null) {
    const p = hitGround(ev);
    if (p) placeObject(selectedObject, clampWorld(p.x), clampWorld(p.z));
  }
  endDrag(ev.pointerId);
});

// 触摸被浏览器判成滚动手势、或系统抢走指针时，pointerup 不会来。
// 没有这两个监听，拖拽状态会永远留着 —— 松手之后物件继续跟着指针走。
renderer.domElement.addEventListener('pointercancel', (ev) => endDrag(ev.pointerId));
renderer.domElement.addEventListener('lostpointercapture', (ev) => endDrag(ev.pointerId));
// 右键菜单会盖住画布，而右键本身已不参与交互，直接屏蔽
renderer.domElement.addEventListener('contextmenu', (ev) => ev.preventDefault());

renderer.domElement.addEventListener('wheel', (ev) => {
  if (mode !== 'create') return;
  ev.preventDefault();
  orbit.radius = Math.min(17 * MINI, Math.max(5 * MINI, orbit.radius + ev.deltaY * 0.012 * MINI));
}, { passive: false });

window.addEventListener('keydown', e => keys.add(e.key.toLowerCase()));
window.addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
window.addEventListener('resize', () => {
  updateFov();
  fitRenderer(innerWidth, innerHeight);   // 走同一套限制，别直接 setSize
  post.setSize(innerWidth, innerHeight);
});

/* ---------------- 摆放逻辑 ---------------- */
// ⚠️ 这里有两套单位，别混：
//   · 指针射线打出来的交点、以及 group.position 都是**世界米**
//   · state.o 里存的是**设计分米**（0.1 米为单位的整数，链接要用）
// 两者差一个 MINI。以前世界尺度是 1:1 所以看不出来，改了尺度之后
// 直接把世界米写进 state 会让所有物件的位置偏差 2.7 倍。
const clampWorld = (v) => Math.max(-W.WORLD_RADIUS, Math.min(W.WORLD_RADIUS, v));

function writeBack(id, x, z) {
  const item = state.o.find(a => a[0] === id);
  if (item) {
    item[1] = Math.round(W.toStored(x));
    item[2] = Math.round(W.toStored(z));
  }
  refreshLink();
}

/* ---------------- 创作侧草稿（存在浏览器里，不上服务器） ----------------
   为什么必须有：创作者写的名字、那句话、天色、9 件坐标**只活在内存里**。
   而这条链路上有两次必然发生的整页加载：
     · 点「以收件人视角看看」→ 只改 hash（不重载）
     · 从收件人视角回创作者面板 → `?create=1` 是一次真正的导航，整页重来
   再加一次误刷新（手机上是常事），四十秒的输入就全没了。
   这是整条创作链路上**唯一一处灾难性失败**：别的错都能重来，这个不能。

   选择 localStorage 而不是 URL：草稿是"半成品"，不该被分享出去，
   也不该占链接长度（上限 1500 字符要留给那句话和物件）。
   选择整份 state 而不是几个字段：配色、天色、坐标、胶囊选择都要一起回来。
   用的是**同一个 encodeState**，所以草稿与世界是同一种东西，
   将来加字段不会出现"草稿丢字段"这种只在恢复时才暴露的错。 */
const DRAFT_KEY = 'pw.draft';

function saveDraft() {
  // 隐私模式 / 禁用存储下 localStorage 会抛，忽略即可（草稿是加分项，不是必需品）
  try { localStorage.setItem(DRAFT_KEY, encodeState(state)); } catch { /* 忽略 */ }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* 忽略 */ }
}

/** 读回草稿。**只在"空 URL 的创作者模式"下用**：
 *  带 `#w=` 的人是被送世界的人，`?create=1` 的人是明确来编辑的 ——
 *  后者若被草稿盖掉，他会以为自己点错了链接。 */
function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const s = decodeState(raw);
    // 空草稿（什么都没写、什么都没摆）不值得打断起手世界
    if (!s || (!s.n && !s.m && s.o.length === 0)) return null;
    return s;
  } catch { return null; }
}

async function placeObject(id, x, z) {
  const sx = Math.round(W.toStored(x)), sz = Math.round(W.toStored(z));
  const existing = state.o.find(a => a[0] === id);
  if (existing) {
    existing[1] = sx; existing[2] = sz;
    const g = placedMeshes.get(id);
    // 走 placeOnGround：直接写 y=0 会让物件沉进地里一半（见 world.js 的说明）
    if (g) W.placeOnGround(g, x, z);
  } else {
    // 上限必须在这里拦：state.o 超过 MAX_OBJECTS 时编码阶段会被静默截断，
    // 结果就是你屏幕上 10 件、发出去的链接里只有 9 件，而界面一声不响。
    if (state.o.length >= MAX_OBJECTS) {
      toast(t('toastLimit', MAX_OBJECTS));
      return;
    }
    state.o.push([id, sx, sz]);
    const def = OBJECTS.find(o => o.id === id) || OBJECTS[0];
    // 后放的物件照样要烘 AO —— 只把已经在场上的物件当遮蔽源
    const neighbours = [...placedMeshes.values()].map(g => ({
      x: g.position.x, z: g.position.z,
      r: W.clearingRadius(OBJECTS.find(o => o.id === g.userData.objectId))
    }));
    const g = await W.createObject(def, sx, sz, neighbours, SKIES[state.t] || SKIES[0], ageDays);
    worldGroup.add(g);
    placedMeshes.set(id, g);
  }
  syncDiagnostics();
  refreshLink();
}

/* ---------------- 创作者 UI ---------------- */
function buildCreateUI() {
  const skyBox = $('skies');
  skyBox.innerHTML = '';
  SKIES.forEach(s => {
    const b = document.createElement('button');
    // 名字走 i18n：天色与物件的**顺序**与 state.js 的 SKIES / OBJECTS 一一对应，
    // 所以用 s.id / o.id 当索引，不用遍历顺序 —— 顺序错位会把"黄昏"标成 "Rain"
    b.textContent = skyName(s.id);
    b.setAttribute('aria-pressed', String(state.t === s.id));
    b.onclick = () => { state.t = s.id; buildCreateUI(); buildWorld(); refreshLink(); };
    skyBox.appendChild(b);
  });

  const pal = $('palette');
  pal.innerHTML = '';
  OBJECTS.forEach(o => {
    const b = document.createElement('button');
    b.textContent = objectName(OBJECTS.findIndex(x => x.id === o.id));
    b.setAttribute('aria-pressed', String(selectedObject === o.id));
    b.onclick = () => { selectedObject = (selectedObject === o.id ? null : o.id); buildCreateUI(); };
    pal.appendChild(b);
  });

  $('btn-clear').onclick = () => {
    state.o = [];
    buildWorld();
    refreshLink();
  };

  /* 「留给自己」/「发给他」——这条链接的两种命运。
     为什么要让创作者在这里**明确选一次**，而不是自动判断：
     一条链接无法知道自己会被发给谁。发出去的世界应该被封存（他几时打开都是同一个世界），
     留给自己的世界才按真实天数变老。这个选择只有创作者能做出，所以他按哪个按钮，
     就是这条链接的命运（见 state.js 顶部关于 k / c 的说明）。
     两个按钮都会**复制到剪贴板**，同时把当前状态切过去 —— 于是「以收件人视角看看」
     预览到的就是他即将发出去的那一条。 */
  const keep = state.k === CAPSULE_VERSION;
  $('cap-keep').onclick = async () => {
    state.k = CAPSULE_VERSION;
    state.c = Math.floor(Date.now() / 60000);      // 单位：分钟（省链接字符）
    buildWorld();                                   // 立刻变老：草与颜色跟着走
    refreshLink();
    await copyLink(t(keep ? 'toastCopiedAlready' : 'toastCopiedCapsule'));
  };
  $('cap-share').onclick = async () => {
    state.k = null; state.c = null;
    buildWorld();
    refreshLink();
    await copyLink(t('toastCopied'));
  };
  const copyBtn = $('btn-copy-link');
  if (copyBtn) copyBtn.onclick = copyShareLink;
  refreshCapsuleUI();
}

/** 「留给自己」那一段的状态显示：几天了 / 还没封存 */
function refreshCapsuleUI() {
  const box = $('capsule');
  const live = $('capsule-live');
  const days = capsuleDays(state);
  const isCap = state.k === CAPSULE_VERSION;
  box?.classList.toggle('is-capsule', isCap);
  $('cap-keep')?.setAttribute('aria-pressed', String(isCap));
  $('cap-share')?.setAttribute('aria-pressed', String(!isCap));
  if (!live) return;
  if (isCap) {
    // 0 天时也要说清楚它已经是胶囊了（否则他会以为没生效），只是不说"0 天"
    live.textContent = days >= 1 ? t('capLiveKeep', days) : t('capLiveKeep0');
  } else {
    live.textContent = t('capLiveShare');
  }
}

/* ---------------- 可发送的链接 ----------------
   一条"能发给他"的链接只有一种正确形态，所以只在这里拼一次：
     origin + pathname + #w=<token>
   ⚠️ **必须丢掉 query**。创作者面板的地址是 `?create=1`，
   他若直接复制地址栏，那条链接会让对方**落在创作面板**而不是走进世界 ——
   对一个核心承诺是"发给他"的作品，这是最直接的一处失效。
   旧代码在两个按钮里各拼了一次，形式正确但没人拦得住"复制地址栏"这条路。
   现在把"复制给他"做成显式按钮，并且一律走 here。 */
const shareOrigin = () => location.origin + location.pathname;

function linkFor(stateObj) {
  return shareOrigin() + '#w=' + encodeState(stateObj);
}

/* 「复制给他」：语义与两个胶囊按钮**分开** ——
   那两个是"决定这条链接的命运"，这个是"把当前那条拿走"。 */
async function copyShareLink() {
  const b = budget(state);
  if (!b.ok) return toast(t('toastTooLong'));
  try {
    await navigator.clipboard.writeText(linkFor(state));
    toast(t('toastCopied'));
  } catch {
    // 剪贴板被拒（非 https / 权限）时，至少把链接选中让他手动复制
    const el = $('link-out');
    if (el) {
      el.textContent = linkFor(state);
      try {
        const r = document.createRange();
        r.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges(); sel.addRange(r);
      } catch { /* 选不中也无所谓，链接是可见的 */ }
    }
    toast(t('toastCopyFail'));
  }
}

/** 把当前链接写进剪贴板 + 提示。两个胶囊按钮共用，避免两处各写一遍复制逻辑 */
async function copyLink(okText) {
  const b = budget(state);
  if (!b.ok) return toast(t('toastTooLong'));
  const link = linkFor(state);
  $('link-out').textContent = link;    // 按钮点过之后，页面上显示的就是刚复制的那条
  try { await navigator.clipboard.writeText(link); toast(okText); }
  catch { toast(t('toastCopyFail')); }
}

function refreshLink() {
  const link = linkFor(state);
  const b = budget(state);
  $('link-out').textContent = link;
  $('budget').textContent = b.ok ? t('budgetOk', b.len, b.max) : t('budgetWarn', b.len);
  $('budget').classList.toggle('warn', !b.ok);
  refreshCapsuleUI();
  // 创作侧的每一步都顺手存一份草稿：名字、那句话、天色、坐标、胶囊选择
  // 全部在这一个 token 里（见 saveDraft 的说明）。收件人模式不存。
  if (mode === 'create') saveDraft();
}

/* ---------------- 回信 ----------------
   收件人走到中心、读到那句话之后，可以**选一件东西**替他说话。
   整条链路仍然是零后端的：他的回信就是另一份状态、另一条 URL，
   用同一个 encodeState 编出来，发回给创作者即可。
   设计取舍见 state.js 的 REPLY_CHOICES 与 src/reply.js。 */
let replyAnim = null;
let replyChoice = null;

function armReply() {
  const btn = $('btn-reply');
  if (!btn) return;
  btn.onclick = () => {
    document.body.dataset.replyStep = 'choose';
    $('reply').classList.add('on');
    // 打开面板时先停住脚步，免得他在选东西的时候还在往前走
    keys.clear(); walking = false;
  };
  // 选载体：切换 aria-pressed，并把名字写进文案，让他知道自己在选什么
  const box = $('reply-choices');
  box.innerHTML = '';
  const choices = t('replyChoices');
  const hints = t('replyHints');
  REPLY_CHOICES.forEach((c, i) => {
    const b = document.createElement('button');
    b.setAttribute('aria-pressed', 'false');
    // 载体名与提示走 i18n，下标与 state.js 的 REPLY_CHOICES 一一对应
    b.innerHTML = `<b>${choices[i] ?? c.label}</b><span>${hints[i] ?? c.hint}</span>`;
    b.onclick = () => {
      replyChoice = c;
      [...box.children].forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      document.body.dataset.replyStep = 'write';
      $('reply-text').focus();
    };
    box.appendChild(b);
  });
  // 不用 for...of：下面要用下标取 i18n 文案，索引与 REPLY_CHOICES 必须一致
  $('reply-cancel').onclick = () => {
    $('reply').classList.remove('on');
    document.body.dataset.replyStep = 'choose';
  };
  $('reply-send').onclick = sendReply;
  $('reply-close').onclick = () => $('reply').classList.remove('on');
  $('reply-copy').onclick = async () => {
    const v = $('reply-link').value;
    try { await navigator.clipboard.writeText(v); toast(t('toastReplyCopied')); }
    catch { $('reply-link').select(); toast(t('toastReplyCopyFail')); }
  };
}

/** 生成回信：把选中的载体、写的话、以及他唤醒了几件东西一起编码进 URL */
function sendReply() {
  if (!replyChoice) return;
  const text = ($('reply-text').value || '').slice(0, 90);
  const awakened = attention ? attention.greetedCount : 0;
  state.r = { o: replyChoice.id, m: text, g: awakened };

  const link = location.origin + location.pathname + '#w=' + encodeState(state);
  $('reply-link').value = link;

  // 世界里那件东西开始替他说话
  const g = placedMeshes.get(replyChoice.id);
  if (g) {
    if (!replyAnim) replyAnim = createReplyAnimation(replyChoice.anim, g, scene);
    audio.blip();
  }
  document.body.dataset.replyStep = 'done';
  refreshLink();
}

/** 他打开的是**别人回过信的世界**：那件东西已经在结束态，不再重演动画。
 *  动画是"他做的动作"，不是"这个世界的状态" —— 每次刷新都重演一遍会很怪。 */
function settleReply() {
  if (!state.r) return;
  const choice = REPLY_CHOICES.find(c => c.id === state.r.o);
  const g = placedMeshes.get(state.r.o);
  if (!choice || !g) return;
  replyAnim = createReplyAnimation(choice.anim, g, scene);
  replyAnim.settle();
}

/* ---------------- 渲染一帧（带降级） ----------------
   后期处理（EffectComposer：渲染目标 → 辉光 → 色调映射 → 输出）比直接渲染脆弱得多：
   它要多开几张浮点渲染目标，而手机 GPU 的显存与扩展支持参差不齐。
   一旦它挂了，屏幕上就是**纯黑**（UI 是 DOM，照常显示）——
   这正是"只有 UI、世界一片空白"的那种症状。

   所以这里包一层：post 抛错就**永久降级**为直出渲染。
   画面会朴素一些（没有辉光、色调映射弱一点），但**有画面**，
   而且只提示一次，不刷屏。宁可朴素，不能黑屏。 */
let postBroken = false;
function renderFrame() {
  if (!postBroken) {
    try { post.render(); return; }
    catch (err) {
      postBroken = true;
      reportFatal('后期处理失败，已降级为直接渲染 / Post-processing failed, fell back', err);
    }
  }
  try { renderer.render(scene, camera); }
  catch (err) { reportFatal('渲染失败 / Render failed', err); }
}

// 署名：这是**专有名词，不进 i18n**（"作者名"不该被翻译成另一种语言）
const CREDIT = 'Postcard World · 2026 · pawer';

/* ---------------- 明信片 ----------------
   这是作品**唯一能离开屏幕、进入现实**的产物 —— 别的都是一条链接，
   而这一张是能存下来、能发朋友圈、能打印出来的东西。
   所以它值得比"截个图加两行字"多得多的照顾。四条：

     1. **按视口比例出图，不裁切**。旧版固定 1200×820（1.46:1）配 cover 裁切，
        宽屏下左右留大片米色空白；而截图本身是视口比例 —— 两者对不上就必然浪费。
        现在画布 = 截图 + 底部文字区，比例由截图决定，一个像素都不裁。
     2. **那句话会折行、超出加省略号**。旧版 `.slice(0, 34)` 硬截 ——
        句子在中间断开且没有任何提示，读起来像坏了。按 measureText 逐字折行，
        最多三行，第三行末尾加省略号。
     3. **右下角一个二维码**，指向这条世界。这是"寄到"在现实里的动作：
        对方扫一下就走进来了。自绘（src/qr.js），不引库。
        位置刻意压在底部文字区的右侧 —— 那里本来就是空白，不占画面。
     4. **一行署名**。一件参赛作品应当有地方自报家门（清单第 25 条）。
*/
/** 按像素宽度折行（中文没有空格，只能逐字量；英文按空格断词） */
function wrapText(ctx, text, maxW, maxLines) {
  const lines = [];
  let cur = '';
  for (const ch of String(text)) {
    const test = cur + ch;
    if (ctx.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = ch;
      if (lines.length >= maxLines) break;
    } else {
      cur = test;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  // 超出：最后一行末尾加省略号（并保证加了之后仍然不超宽）
  const joined = lines.join('');
  if (joined.length < String(text).length && lines.length) {
    let last = lines[lines.length - 1];
    while (last && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
    lines[lines.length - 1] = last + '…';
  }
  return lines;
}

function makePostcard() {
  renderFrame();
  const src = renderer.domElement;
  const PAD = 46;
  const HEAD_TO_MSG = 30;    // 给谁 -> 那句话
  const MSG_TO_LINK = 26;    // 那句话 -> 那一行链接
  const LINK_TO_FOOT = 26;   // 链接 -> 页脚
  const MSG_LEAD = 38;
  const LINK_LEAD = 24;
  const MAX_LINES = 3;
  const FOOT_H = 22;
  const PAD_BOT = 28;
  const BAND_TOP = 32;       // 画面下沿 -> 给谁

  const CW = src.width + PAD * 2;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');

  /* 这条世界的地址，原样印出来。
     ---- 为什么这里是一行文字、而不是二维码 ----
     曾经印过二维码（自绘实现见 src/qr.js，矩阵结构有 _test/verify-qr.mjs 守着）。
     但两次实测都扫不出来：132px（4 px/模块）不行，放大到 198px（6 px/模块）仍不行。
     矩阵本身验过没问题，可"扫得出来"只有手机能证明，而它证明不了 ——
     **印一个扫不出来的码比不印更糟**：对方会以为是自己手机的问题。
     所以改成印地址：能读、能从电脑手动输入、打印出来也清晰。 */
  const link = location.origin + location.pathname + location.hash;
  const linkLines = wrapText(ctx, link, CW - PAD * 2, 2);

  const textW = CW - PAD * 2;
  ctx.font = '26px "Segoe UI", system-ui, "Microsoft YaHei", sans-serif';
  const lines = wrapText(ctx, state.m || '', textW, MAX_LINES);

  const bandTop = PAD + src.height;
  const headY = bandTop + BAND_TOP;
  const msgY0 = headY + HEAD_TO_MSG;
  const labelY = msgY0 + (lines.length - 1) * MSG_LEAD + MSG_TO_LINK;
  const linkY0 = labelY + 24;
  const footY = linkY0 + (linkLines.length - 1) * LINK_LEAD + LINK_TO_FOOT + FOOT_H;
  const CH = footY + PAD_BOT;
  c.width = CW;
  c.height = CH;

  ctx.fillStyle = '#f6f1e6';
  ctx.fillRect(0, 0, CW, CH);
  // 画面：比例一致，不裁切（旧版是 cover 裁切 + 米色留白）
  ctx.drawImage(src, PAD, PAD, CW - PAD * 2, src.height);

  // 抬头：给谁（明信片上的字是烧进像素的，必须跟着界面语言走）
  ctx.fillStyle = '#2a2620';
  ctx.font = '600 34px "Segoe UI", system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillText(state.n ? t('postcardTo', state.n) : t('postcardToYou'), PAD, headY);

  // 那句话：折行 + 省略号
  ctx.font = '26px "Segoe UI", system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#5a544a';
  lines.forEach((ln, i) => ctx.fillText(ln, PAD, msgY0 + i * MSG_LEAD));

  // 走进这个世界的地址：先一行说明，再一行等宽地址（可读、可手动输入）
  ctx.font = '18px "Segoe UI", system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#9a9284';
  ctx.fillText(t('postcardLink'), PAD, labelY);
  ctx.font = '17px "SFMono-Regular", Consolas, "Courier New", monospace';
  ctx.fillStyle = '#8a8276';
  linkLines.forEach((ln, i) => ctx.fillText(ln, PAD, linkY0 + i * LINK_LEAD));

  // 页脚：产品名（左）与署名（右）
  ctx.font = '18px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#9a9284';
  ctx.fillText(t('postcardFooter'), PAD, footY);
  const credit = CREDIT;
  const creditW = ctx.measureText(credit).width;
  ctx.fillText(credit, PAD + textW - creditW, footY);

  const a = document.createElement('a');
  a.download = 'postcard-' + Date.now() + '.png';
  a.href = c.toDataURL('image/png');
  a.click();

  /* 版式自检：把每个块的矩形交出去，_test/verify-postcard.mjs 据此断言互不重叠。 */
  window.__postcard = () => ({
    CW, CH, bandTop, hasQR: false, qr: null, qrModules: 0, qrPxPerModule: 0,
    qrLabelY: null,
    headY,
    msg: { x: PAD, y: msgY0, lines: lines.length, lineH: MSG_LEAD, maxW: textW, textW },
    labelY,
    link: { x: PAD, y: linkY0, lines: linkLines.length, lineH: LINK_LEAD, textW },
    footY,
    foot: { x: PAD, w: ctx.measureText(t('postcardFooter')).width, h: FOOT_H },
    credit: { x: PAD + textW - creditW, w: creditW, h: FOOT_H }
  });
}

/* ---------------- 小工具 ---------------- */
// 「正在去创作者面板」的闸门。见 toCreate() 的说明：抢在 hashchange 的 reload 之前把它挡掉。
let navigatingToCreate = false;

/** 去创作者面板（做自己的世界）。
 *  ⚠️ 两个坑都踩过，改这里之前先看完：
 *   1. **不能靠"清掉 hash 让 hashchange 去重载"**。自动进样例世界时若 URL 里没有 `#w=demo`，
 *      `location.hash = ''` 就是空操作 → 点了没反应，人停在世界里出不来。
 *   2. **显式导航也会被 hashchange 打回去**。清 hash 会派发 hashchange，
 *      而那个监听器会 `location.reload()` —— 它和这次导航抢，结果又被带回样例世界。
 *      所以用一个显式闸门 `navigatingToCreate` 把那次 reload 挡掉，导航完再放行。 */
function toCreate() {
  navigatingToCreate = true;
  location.assign(location.pathname + '?create=1');
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 1800);
}
function notice(text) {
  const n = $('notice');
  n.textContent = text;
  n.style.display = 'block';
  setTimeout(() => { n.style.display = 'none'; }, 5000);
}

/* ---------------- 启动 ---------------- */
// 世界搭好之前不给入口 —— 点了进去是一片空白，比多等两秒糟得多
function unlockIntro() {
  const b = $('intro-enter');
  if (b) { b.disabled = false; b.textContent = t('enter'); }
}

// 声音开关（两种模式都有，所以按 class 挂，不按 id）
function refreshSoundButtons() {
  document.querySelectorAll('.js-sound').forEach(b => {
    b.textContent = audio.muted ? t('soundOff') : t('soundOn');
  });
}
document.querySelectorAll('.js-sound').forEach(b => {
  b.onclick = () => { audio.resume(); audio.toggleMute(); refreshSoundButtons(); };
});
refreshSoundButtons();

/* 语言切换。按钮文字走 i18n（中文界面显示 EN，英文界面显示 中文），
   这样"按下去会变成什么"是自明的，不需要额外说明。
   三个位置：开场页右上角（最重要 —— 非中文评委第一眼就要能切）、
   接收侧 HUD、创作者面板。 */
['btn-lang-intro', 'btn-lang', 'btn-lang-create'].forEach(id => {
  const b = $(id);
  if (!b) return;
  b.textContent = t('langSwitch');
  b.title = t('langSwitchTitle');
  b.onclick = () => setLang(lang === 'zh' ? 'en' : 'zh');
});
applyI18n();

if (mode === 'receive') {
  // 入场：先把浮层淡掉，**等真的落地再彻底移除**。
  // 早先 0.95 秒就 display:none，而落地要 3.4 秒 —— 浮层在"下落中"就没了，
  // 于是下落的后半段是全屏画面、没有文字，观者不知道自己该看什么。
  // 现在让浮层跟着落地的节奏一起退场，落地那一刻画面才完全交给他。
  $('intro-enter').onclick = () => {
    const veil = $('intro');
    veil.classList.add('hide');
    // 摘掉"遮挡中"标记，HUD / 准星 / 那句话才允许出现
    document.body.classList.remove('veiled');
    resetDescent();          // 浮层一淡出就开始从高处落下
    setTimeout(() => {
      veil.style.animation = 'none';       // 停掉呼吸，免得和淡出叠加
    }, 1100);
    setTimeout(() => {
      veil.style.display = 'none';
    }, DESCENT_TIME * 1000 + 500);
  };
  const walkBtn = $('btn-walk');
  const on = (e) => { e.preventDefault(); walking = true; };
  const off = (e) => { e.preventDefault(); walking = false; };
  walkBtn.addEventListener('pointerdown', on);
  walkBtn.addEventListener('pointerup', off);
  walkBtn.addEventListener('pointercancel', off);
  walkBtn.addEventListener('pointerleave', off);
  $('btn-postcard').onclick = makePostcard;
  armReply();
  $('btn-create-new').onclick = toCreate;
  // 样例世界那个"我也做一个"：同一个去处，所以共用一处实现
  const introCreate = $('intro-create');
  if (introCreate) introCreate.onclick = toCreate;
} else {
  buildCreateUI();
  $('in-name').value = state.n || '';
  $('in-msg').value = state.m || '';
  $('in-name').oninput = (e) => { state.n = e.target.value.slice(0, 24); refreshLink(); };
  $('in-msg').oninput = (e) => { state.m = e.target.value.slice(0, 90); refreshLink(); };
  $('btn-preview').onclick = () => {
    // 同上：只改 hash
    location.hash = '#w=' + encodeState(state);
  };
  /* 「重新开始」：草稿一旦接上，创作者就再也回不到起手世界了 ——
     每次打开都是上次那半句话。必须给一个明确的出口，否则草稿会变成陷阱。
     它同时清掉草稿，所以刷新之后也不会"复活"。 */
  const again = $('btn-restart');
  if (again) {
    again.onclick = () => {
      clearDraft();
      state = starterWorld();
      $('in-name').value = '';
      $('in-msg').value = '';
      selectedObject = null;
      buildCreateUI();
      buildWorld();
      refreshLink();
      toast(t('toastRestarted'));
    };
  }
}

/* 同一标签页内换世界（粘贴链接、手动改 hash、浏览器前进/后退）时，
   hash 变化**不会**触发页面重载，作品会停在旧模式——必须在重载后重新走一遍路由。
   收件人在新标签页打开不受影响，但没理由留这个缺口。
   ⚠️ 例外：`?create=1` 的页面**不重载**。那种页面按约定是"停在创作面板"，
   它自己会处理导航（见 toCreate），这里的重载只会白跑一趟。
   注意 `browse` 是加载时算的：从样例世界切去创作面板时它还是 false，
   所以"清 hash → 重载"这一步照常发生，重载后 browse 才为真 —— 正是想要的顺序。 */
addEventListener('hashchange', () => {
  // 正在切去创作者面板时不重载：那次导航与这里抢，会把页面打回样例世界（见 toCreate）
  if (navigatingToCreate) return;
  if (!browse) location.reload();
});

/* 创作侧草稿：**必须在 buildWorld 之前**接上，否则世界先按起手世界搭好一次，
   再被草稿推翻 —— 白搭一次（9 个模型 + 9 次烘焙 AO），用户看到画面闪一下。
   只在"空 URL 的创作者模式"下恢复：带 #w= 的是收件人，
   ?create=1 是明确从别处点进来的，都不该被本地草稿盖掉（见 loadDraft 的说明）。 */
const draft = (!location.hash && !browse && mode === 'create') ? loadDraft() : null;
if (draft) {
  state = draft;
  notice(t('draftRestored'));
}

/* 建世界失败时**不能什么都不做**：入场按钮会永远停在"正在准备…"、
   而世界是黑的 —— 用户看到的正是"只有 UI、其他全空白"。
   现在把原因显示出来，并允许照样进去看看（哪怕画面是空的），
   至少人知道发生了什么，也能把那段文字复制给我们。 */
try {
  // 调试旁路：`?nobuild=1` 跳过建世界。用来判定"卡死发生在建世界之前还是之中"——
  // 顶层 await 的模块里，任何一处同步死循环都会让页面完全失去响应，
  // 而那时连 console 都读不到（渲染线程被占死）。有了这个开关就能二分。
  if (!hasQueryFlag('nobuild')) await buildWorld();
} catch (err) {
  reportFatal('世界构建失败 / Failed to build the world', err);
}
unlockIntro();
/* 立刻画第一帧 —— 不要等动画循环。
   原因：`setAnimationLoop` 是回调式的，只要它因为任何原因没跑起来
   （上下文丢失、驱动异常、标签页被判为不可见…），屏幕上就**永远是一片黑**，
   而 DOM 里的 UI 照常显示 —— 这正是"只有 UI、世界里什么都没有"的症状。
   这里是同步画一帧：哪怕动画循环之后出问题，用户至少看到一个静止的世界，
   而不是黑屏。画不出来也会走 reportFatal 把原因显示出来。 */
renderFrame();
refreshLink();
// 他打开的是"别人回过信的世界"：那件东西直接到位，不重演动画
if (mode === 'receive' && !takeMode) settleReply();

/* ---------------- 拍摄模式 ---------------- */
if (takeMode) {
  renderTakeMode();
} else {
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta());
    const t = clock.elapsedTime;
    weather?.userData.update?.(dt);
    core?.userData.update?.(dt, t);
    motes?.userData.update?.(dt, t);
    clouds?.userData.update?.(dt);
    updateAttention(dt, t, camera.position.x, camera.position.z, () => flickerLights(t));
    replyAnim?.update(dt);
    updateCamera(dt);
    renderFrame();
  });
}

function renderTakeMode() {
  const DURATION = 12;          // 秒。赛事要的是"走进这个世界的演示"，不是预告片——
                                // 10 秒装不下"从边缘走到中心、那句话浮出来"这一整条动线
  const easeInOut = x => x * x * x * (x * (x * 6 - 15) + 10);

  /* 运镜 = 一次真实的行走，而不是绕圈展示。
     世界上一次改版后，物件环在 2.5–4.1 米 —— 旧路径贴着中心绕，
     镜头正好落在空地中央往外看，拍到的是环外的空场（这就是"演示片看着空"的原因）。
     现在改成一镜到底的第一人称走进：
       0.0–1.4  站在世界边缘往里看（交代这是"一个地方"）
       1.4–8.0  匀速往中心走，边走边微微转向中心；沿途会经过灯、自行车、石头
       8.0–12.0 走到中心，那句话浮出来；最后极缓地抬头，把树冠收进画面
     全程保持人眼高度 —— 唯一一次"抬高"是最后 0.4 米，用来收进头顶的树冠。 */
  const APPROACH_END = 1.4;     // 站定期
  const WALK_END = 8.0;         // 走完
  const MSG_AT = 8.6;           // 那句话浮现（与走到中心附近的时刻对齐）

  // 起点在世界边缘外侧（半径 6.6），终点在触发圈内（1.7）
  const R0 = 6.6, R1 = 1.7;
  const A0 = 0.30, A1 = -0.12;  // 方位角：略偏，走出一点弧线而不是笔直插进去

  /** 走路时头部自然起伏：按**行进距离**取相位，跟交互模式同一套逻辑 */
  const bob = (dist) => Math.sin(dist * 3.4) * 0.018 + Math.sin(dist * 6.8) * 0.006;

  /* 逐帧推进天气/中心的固定步长，跟着拍摄帧率走（URL 里的 ?fps=，默认 30）。
     写死 1/30 的话，改成 60fps 拍摄会变成半速——成片里"雨落得很慢"。
     这条必须与 tools/shoot.mjs 的帧率参数一致，否则成片节奏是错的；
     所以把它一并写进 __takeInfo 自报出去，让拍摄脚本能核对而不必靠人记得改两处。 */
  const TAKES = {
    duration: DURATION,
    fps: Math.max(1, Number(new URLSearchParams(location.search).get('fps')) || 30)
  };
  const FIXED_DT = 1 / TAKES.fps;

  function cameraAt(t) {
    let r, theta, y, lookY, dist;
    if (t <= APPROACH_END) {
      // 站定：把世界收进画面（略高于人眼，像刚站定喘口气）
      r = R0; theta = A0; y = W.EYE_HEIGHT + 0.06; lookY = 0.9; dist = 0;
    } else if (t <= WALK_END) {
      const p = (t - APPROACH_END) / (WALK_END - APPROACH_END);   // 匀速：像真的在走
      r = R0 + (R1 - R0) * p;
      theta = A0 + (A1 - A0) * p;
      // 走动时高度落到人眼 + 起伏；p 从 0 起算，所以站定那一帧接得上
      dist = (R0 - r);
      y = W.EYE_HEIGHT + bob(dist) + 0.06 * (1 - Math.min(1, p * 6));
      lookY = 0.9 + (1.25 - 0.9) * p;
    } else {
      // 到中心：那句话已经浮出来，极缓抬头把头顶的树冠收进画面
      const p = easeInOut(Math.min(1, (t - WALK_END) / (DURATION - WALK_END)));
      r = R1 - 0.15 * p;
      theta = A1;
      y = W.EYE_HEIGHT + 0.42 * p;
      lookY = 1.25 + 2.4 * p;
    }
    camera.position.set(r * Math.sin(theta), y, r * Math.cos(theta));
    camera.lookAt(0, lookY, 0);
    return r;
  }

  // 逐帧接口：拍摄脚本按 t = 帧号 / 帧率 依次调用
  window.__seek = (t) => {
    cameraAt(t);

    // 入场浮层：**拍摄模式直接收起**。赛事要的是"走进世界的演示"，
    // 10 秒里拿 1.4 秒看一张标题卡是浪费；交互模式里它照旧存在。
    const intro = $('intro');
    if (intro) { intro.style.opacity = '0'; intro.style.display = 'none'; }

    // 那句话：和交互模式一样，读到它的那一刻曝光最亮（1.2 秒缓入，可复现）
    const shown = t >= MSG_AT && !!state.m;
    $('msg').classList.toggle('on', shown);
    const k = Math.min(1, Math.max(0, (t - (MSG_AT - 0.4)) / 1.2));
    renderer.toneMappingExposure = post.exposureOf(1 + (shown ? k : 0) * 0.11);

    // 天气与中心用固定步长推进，保证可复现。
    // 步长跟着拍摄帧率走（?fps=60）：写死 1/30 时改成 60fps 拍摄，
    // 天气与中心会以半速推进，成片里"雨落得很慢"。
    weather?.userData.update?.(FIXED_DT);
    core?.userData.update?.(FIXED_DT, t);
    motes?.userData.update?.(FIXED_DT, t);
    clouds?.userData.update?.(FIXED_DT);
    // 用 t 而不是 performance.now()：逐帧可复现。
    // 拍摄模式下 attention 也要跑 —— 否则演示片里"走过灯时灯亮一档"这个动作不会出现，
    // 而成片本来就是要展示这个交互的。
    updateAttention(FIXED_DT, t, camera.position.x, camera.position.z, () => flickerLights(t));

    renderFrame();
  };

  // 先摆好第一帧，再告诉拍摄脚本可以开始了
  window.__seek(0);
  window.__takeInfo = { duration: TAKES.duration, fps: TAKES.fps, ready: true };
}
