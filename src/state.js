/* 世界状态的编码 / 解码
   核心设计：整个世界（谁、什么话、什么天色、几个物件摆在哪）压进 URL hash。
   —— 零后端、零数据库、链接永久有效，收到链接的人不需要注册任何东西。
   只允许存"够用的最小信息"：坐标量化到 0.1 米（整数存），绝不塞图片。
*/

export const STATE_VERSION = 1;
export const MAX_HASH_LEN = 1500; // 超过就截断，并在 UI 里提示
/** 一个世界最多能摆几件（UI 与测试都读这个常量，不要再各写各的）。
 *  定义必须在使用它的 normalizeState 之前 —— const 有暂时性死区，
 *  写到后面会在模块求值时就抛 ReferenceError。 */
export const MAX_OBJECTS = 9;

/* ---------- 世界尺度：全项目只在 state.js 定义，别处一律 import ----------
   定义放在这里而不是 world.js，因为 normalizeState（纯逻辑、可单测）也要用它；
   world.js 再把它转出去给渲染用，避免出现第二份数字。

   **基准是"正常人的第一视角下，模型看起来是正常大小"** —— 这条优先于一切。
   曾经试过把世界收到 2.4 米、把人缩到 0.42 米，让所有东西"高过你"。
   那是错的：第一视角下物件显得过大或过小，都会立刻暴露"这是个模型"，
   而正确做法是**眼高 1.62 米，物件按各自的真实尺寸** ——
   灯 3.5 米（要抬头）、树 4.5 米（有树冠在头顶）、椅子 0.9 米（到大腿）、
   自行车 1.8 米（约一个身长）、信 0.12 米（手上的一件东西）。
   有了真实参照，观者才知道自己站在什么地方。

   MINI = 1 设计米折合多少实际米。保留这个换算是因为
   地面/草丛的尺寸都写成"设计米 × MINI"，将来若要整体缩放只改这一个数；
   但**不要**再靠它去改"人机比例"——那个只能由真实尺寸决定。 */
export const MINI = 1.0;
export const WORLD_RADIUS = 6.5;                     // 实际米：走一圈约 40 米，是个"角落"而不是"房间"
export const EYE_HEIGHT = 1.62;                      // 实际米：成年人眼高，别动
/** 链接里存的坐标是"设计米 ×10"，换算成实际米要再乘 MINI */
export const storedToMeters = (v) => v * 0.1 * MINI;
/** 世界半径换算成"存储单位"，用于夹取坐标 */
export const STORED_LIMIT = Math.round(WORLD_RADIUS / (0.1 * MINI));

/* 天色：8 套。
   top / bottom 是天空穹顶的渐变两端：平坦的纯色天空会让世界显得像块板子。

   fogNear / fogFar 的取值由世界尺度**算出来**，不是调出来的：
   世界半径 6.5 米、地面盘到 7.1 米，站在盘缘往里看到对面边缘约 13 米。
   所以
     · 盘内（0–6 米）必须清透，否则整块地被冲淡、草色和地面分区全糊掉
     · 盘缘（5–24 米）渐浓，把圆盘硬边化进天里
   即 fogNear ≈ 4–8、fogFar ≈ 22–30。换世界尺度时**这两条线必须跟着重算**，
   历史上就是漏了这一步，把一块 6.5 米的地洗成了 L49 的灰绿。 */
export const SKIES = [
  { id: 0, name: '黄昏', sound: 'dusk',
    top: 0x201430, bottom: 0x8a4a38, fog: 0x6b4038, fogNear: 5.5, fogFar: 24,
    sun: 0xffb07a, sunI: 2.1, ambI: 0.40, ground: 0x3d2f2a },

  { id: 1, name: '深夜', sound: 'night', stars: true,
    top: 0x03040c, bottom: 0x16203c, fog: 0x0d1428, fogNear: 4.8, fogFar: 23,
    sun: 0x8fb4ff, sunI: 0.9, ambI: 0.30, ground: 0x1c2434 },

  { id: 2, name: '落雨', sound: 'rain', weather: 'rain',
    top: 0x0e1317, bottom: 0x39464f, fog: 0x2b353d, fogNear: 4.2, fogFar: 21,
    sun: 0xa9c2cc, sunI: 1.1, ambI: 0.55, ground: 0x232c31 },

  { id: 3, name: '初雪', sound: 'snow', weather: 'snow', stars: true,
    top: 0x1d2733, bottom: 0x8496a6, fog: 0x6a7c8c, fogNear: 5.5, fogFar: 24,
    sun: 0xe8f0ff, sunI: 1.5, ambI: 0.80, ground: 0x6c7c8a },

  { id: 4, name: '黎明', sound: 'dawn',
    top: 0x252548, bottom: 0xc08a68, fog: 0x8f6d6a, fogNear: 6.5, fogFar: 26,
    sun: 0xffc9a0, sunI: 2.0, ambI: 0.58, ground: 0x4a3f42 },

  { id: 5, name: '正午', sound: 'noon',
    top: 0x2f6fb0, bottom: 0xa8c0d2, fog: 0x93aec2, fogNear: 8.0, fogFar: 30,
    sun: 0xfff6e6, sunI: 2.7, ambI: 0.90, ground: 0x5e7048 },

  // 「雨后」取代了原来的「大雾」：大雾的 fogFar 只有 7 米，而世界半径 6.5 米——
  // 它几乎把整个世界藏起来，玩家走进去什么都看不见；灰调也与「初雪」重复。
  // 雨后正好相反：空气清透、湿地面、水洼反射成为主角、破云暖光。
  //
  // ⚠️ 这两套天色的天顶/地平线是**下调过**的（原来是 0xc2d8e8 / 0xc8b49a）。
  // 原因：它们原本亮到经色调映射后整片天空顶在 L99–100，
  // 屏幕上是 #fffcee → #ffffff 一整片白，渐变只剩 2–3 个明度台阶。
  // "傍晚的天在发光"这个观感全靠那条渐变，压平了天空就成了一张白纸。
  // 降下来之后渐变恢复到 6–7 档（实测见 tools/probe-sky-screen.mjs）。
  { id: 6, name: '雨后', sound: 'dusk',
    top: 0x2a3442, bottom: 0xac9a82, fog: 0x8b8f8c, fogNear: 7.0, fogFar: 28,
    sun: 0xffe2bc, sunI: 2.3, ambI: 0.55, ground: 0x3a3a34 },

  { id: 7, name: '星夜', sound: 'night', stars: true,
    top: 0x01020a, bottom: 0x0d1430, fog: 0x080e20, fogNear: 4.8, fogFar: 23,
    sun: 0x9ab0ff, sunI: 0.7, ambI: 0.26, ground: 0x18202e }
];

/* 物件图鉴：只有**确实有模型**的物件才会出现在这里。
   原则：作品里绝不出现占位体——宁可选得少，也不给评委看半成品。
   条目按"磁盘上有没有 assets/models/<id>.glb"由 tools/sync-assets.mjs 自动划分，
   不要手改归属，改完跑一次 node tools/sync-assets.mjs。

   `size` = 包围盒最大边归一到的目标值，单位是**实际米（= 设计米，MINI=1）**。
   这些数字是"现实里这件东西有多大"，不是美术参数 —— 别为了构图去改它们，
   构图的自由度应该放在**摆放位置**和**相机**上。
   参照眼高 1.62 米：需要抬头的（灯、树）、齐腰的（椅子、木桩）、
   手里的（信、纸船、蜡烛）。

   `slim` = 水平方向压扁系数（可省略，默认 1）。这是**形态修正**：
   Tripo 的模型常被归一化成宽高比接近 1，树会变成矮胖灌木。
   用 tools/glb-shape.mjs 量过顶点分布再定这个值，别凭感觉填。 */

/* 单位是"现实世界里的尺寸"，尽量贴近实物：
     信 0.12（一个信封）、纸船 0.14（折纸）、旧钟 0.32（座钟）、蜡烛 0.24、
     油灯 0.22、纸灯笼 0.5、野花 0.25、木桩 0.5、石头/苔石 0.4、椅子 0.9、
     自行车 1.8（车长）、旧灯 3.5（街灯，要抬头）、树 4.5（有树冠在头顶） */
export const OBJECTS = [
  { id: 0, name: '一盏旧灯', geo: 'lamp', size: 3.5, color: 0xffd9a0, emissive: 0xffb347, glow: 1.1,
    prompt: 'a small vintage street lamp with a warm glowing bulb, weathered dark metal, thin curved post' },
  { id: 1, name: '一封没寄的信', geo: 'letter', size: 0.12, color: 0xf2e8d5,
    prompt: 'an unopened old letter with a red wax seal, worn paper envelope, slightly crumpled' },
  { id: 2, name: '一把空椅子', geo: 'chair', size: 0.9, color: 0x8a6a4a,
    prompt: 'a simple empty wooden chair, weathered oak, slightly worn edges' },
  // slim 0.5：实测该模型满高度的水平半径 0.37（宽 0.74）而高度只有 1.0，
  // 归一化到 4.5 米后展开成 3.3 米宽的矮胖灌木。压到一半才是树的竖向比例。
  { id: 3, name: '一株长歪的树', geo: 'tree', size: 4.5, slim: 0.5, color: 0x4a7a52,
    prompt: 'a small leaning tree with a crooked trunk and sparse green leaves' },
  { id: 4, name: '一只旧钟', geo: 'clock', size: 0.32, color: 0xc9b38a, emissive: 0x2a1a00,
    prompt: 'a vintage round clock with aged brass rim and pale face, small wooden stand' },
  { id: 5, name: '一辆自行车', geo: 'bike', size: 1.8, color: 0x5a6b7a,
    prompt: 'a simple vintage bicycle with a muted blue-grey frame and thin spoked wheels' },
  { id: 6, name: '一块石头', geo: 'rock', size: 0.40, color: 0x6f6a63,
    prompt: 'a single weathered grey stone, rounded and slightly cracked' },
  { id: 7, name: '一只纸船', geo: 'boat', size: 0.14, color: 0xe8e2d0,
    prompt: 'an origami paper boat folded from white paper, crisp creases' },
  { id: 8, name: '一支蜡烛', geo: 'glow', size: 0.24, color: 0xfff0cf, emissive: 0xffb040, glow: 3.2,
    prompt: 'a single lit candle in a small brass holder, warm flickering flame' },
  { id: 10, name: '一盏小油灯', geo: 'glow', size: 0.22, color: 0xffdca0, emissive: 0xffa838, glow: 3.0,
    prompt: 'a small brass oil lamp with a gentle flame, antique' },
  { id: 9, name: '一只纸灯笼', geo: 'glow', size: 0.5, color: 0xffe3b0, emissive: 0xff9a3c, glow: 4.5,
    prompt: 'a round paper lantern hanging from a short bamboo pole, soft warm glow' },
  { id: 12, name: '一朵野花', geo: 'tuft', size: 0.25, color: 0xd98cb0,
    prompt: 'a single small wild flower with a thin green stem and pink petals' },
  { id: 13, name: '一截木桩', geo: 'stump', size: 0.5, color: 0x6b503a,
    prompt: 'a weathered cut tree stump with visible growth rings' },
  { id: 14, name: '一块苔石', geo: 'rock', size: 0.4, color: 0x5f7050,
    prompt: 'a rounded stone covered in soft green moss' }
];

/* 待生成：还没拿到模型，**不进图鉴、不出现在作品里**。
   生成成功后跑 node tools/sync-assets.mjs，会自动搬进 OBJECTS。 */
export const PENDING = [
  { id: 11, name: '一丛野草', geo: 'tuft', size: 0.34, color: 0x5f7f46,
    prompt: 'a dense tuft of wild green grass blades, low poly' },
  { id: 15, name: '一扇小木门', geo: 'door', size: 1.15, color: 0x7a5a3a,
    prompt: 'a small old wooden door standing alone in a simple frame, weathered planks' },
  { id: 16, name: '一段木栅栏', geo: 'fence', size: 0.95, color: 0x8a6f4f,
    prompt: 'a short section of weathered wooden fence, two rails and three posts' },
  { id: 17, name: '三级石阶', geo: 'steps', size: 0.5, color: 0x8a877e,
    prompt: 'three old stone steps, slightly worn and uneven' },
  { id: 18, name: '一个石墩', geo: 'bollard', size: 0.7, color: 0x9a968c,
    prompt: 'a short round stone bollard with a domed top' },
  { id: 19, name: '一把伞', geo: 'umbrella', size: 0.95, color: 0x4a5a6a,
    prompt: 'an open dark umbrella resting on the ground, slightly tilted' },
  { id: 20, name: '一台旧收音机', geo: 'radio', size: 0.32, color: 0xb08a5a,
    prompt: 'a vintage wooden radio with round dials and a fabric speaker grille' },
  { id: 21, name: '一个旧行李箱', geo: 'case', size: 0.62, color: 0x6b5544,
    prompt: 'a worn vintage leather suitcase with brass corner fittings' }
];

const OBJ_BY_ID = new Map(OBJECTS.map(o => [o.id, o]));

/* ---------- base64url（浏览器与 Node 都可跑，靠全局 btoa/atob） ---------- */

export function b64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ---------- 状态校验 / 归一化 ---------- */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 任意输入 → 一个可信的整数。
 *  为什么需要它：`clamp` 是用 Math.min/max 实现的，而这两个函数**不筛 NaN** ——
 *  `Math.trunc({})`、`Math.trunc("abc")`、`Math.trunc(undefined)` 全是 NaN，
 *  经 clamp 之后**原样透传**（Math.max(lo, NaN) 还是 NaN）。
 *  t 上早就判了 Number.isFinite，物件坐标却漏了，后果是一条坏链接能让
 *  该物件被静默剔除（NaN 坐标渲染不出来）、再编码时变成 null：
 *  收件人打开看到的是"世界正中心凭空多出一盏灯"——一个不报错的错位。
 *  所有进链接的整数都必须过这一道。 */
const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

export function makeEmptyState() {
  return { v: STATE_VERSION, n: '', m: '', t: 0, o: [], r: null, k: null, c: null };
}

/* ---------- 回信的载体：收件人从这三件里选一个 ----------
   只允许世界里已有的发光/叙事物件，理由有两条：
     1. 不新增资产（Tripo 额度已经用完，而且图鉴里的东西都已验证过）
     2. 每一件本身就带叙事负担 —— 纸船是那句话说的东西、蜡烛是"留一盏灯"、
        信是"把话还给你"。选哪一件，本身就是回信的语气。
   `anim` 指名回信动画，实现在 src/reply.js 里。 */
export const REPLY_OBJECT_IDS = [7, 8, 1];   // 纸船 / 蜡烛 / 一封没寄的信

export const REPLY_CHOICES = [
  { id: 7, anim: 'sail', label: '让纸船漂回去',
    hint: '那句话说的就是它' },
  { id: 8, anim: 'dim', label: '把蜡烛留在这里',
    hint: '让它替你亮着' },
  { id: 1, anim: 'lift', label: '把信还给他',
    hint: '有些话该还回去' }
];

/* ---------- 时间胶囊（世界会自己变老） ----------
   一条链接只有两种命运，**由创作者在复制链接时选**：

     · 分享给别人（k = null）—— 世界被**封存**。收件人第一次打开它，它就是今天的样子。
       这是礼物该有的行为：他几时打开，都是同一个世界。
     · 留给自己（k = 1）—— 世界从封存那一刻起按**真实天数**变老：
       草更密更高、叶色转秋、木桩与纸慢慢变色，开场会写「这个世界，47 天了」。
       这也是"信送不出去"时的出路：那就留给自己，它就是一枚时间胶囊。

   ⚠️ 为什么分享链接**不**变老，而不是"变老但把天数藏起来"：
   藏起来等于让画面替他撒谎 —— 他收到一个枯黄的世界，却没有任何东西解释它为什么枯黄。
   而分享的那一刻创作者并不知道他会隔多久才打开，让画面替他承担这个时间差是不诚实的。

   两个字段都是**可选**的，缺省与今天的行为完全一致，所以：
     · 线上已发出去的链接（没有这两个字段）照旧原样渲染
     · STATE_VERSION 绝不能动 —— decodeState 只认 v===1，改版本号会让所有旧链接失效
   字段名压到一个字母，因为这是要塞进 URL 的东西。 */
export const CAPSULE_VERSION = 1;

/** 超过这个天数就不再继续老下去：世界需要有一个"稳定态"，
 *  否则一年后的链接会老到认不出来（草会变成一片焦土）。 */
export const AGE_DAYS_FULL = 45;
/** 木桩年轮 / 纸张泛黄比草慢得多 —— 它们本来就该是"更久才看得出"的东西 */
export const AGE_DAYS_FULL_OBJECT = 90;
/** 时间戳合法的范围：2017-01-01 ～ 2100-01-01（单位：分钟）。
 *  比这更早的当作没写、更晚的夹到上界 —— 坏链接不能让天数变成天文数字，
 *  也不能让"等了 -39000 天"这种东西出现在画面上。 */
export const CAPSULE_TS_MIN = 24681600;
export const CAPSULE_TS_MAX = 68212800;

/** 拍摄模式用的固定"现在"。拍摄（take=1）要求逐帧可复现，
 *  不能读系统时间 —— 否则今天拍的和明天拍的不是同一个世界。
 *  但也不能简单把天数归零：那等于拍摄时把"变老"整个关掉，演示片里永远看不到它。
 *  所以给拍摄一个固定时刻，让 take 截图既确定、又真的会老。
 *  定义在这里而不是 main.js：量测工具（tools/probe-capsule.mjs）必须用**同一个**基准，
 *  否则它造的链接与页面读到的天数会差出一整段时间。 */
export const SHOT_NOW = Date.UTC(2026, 0, 1);

/** 这枚世界是不是"留给自己"的时间胶囊 */
export const isCapsule = (state) => !!state && state.k === CAPSULE_VERSION;

/** 封存时刻（毫秒）。不是胶囊、或时间戳不可信 → null */
export function capsuleSealedAt(state) {
  if (!isCapsule(state)) return null;
  const t = state.c;
  if (!Number.isFinite(t)) return null;
  if (t < CAPSULE_TS_MIN || t > CAPSULE_TS_MAX) return null;
  return Math.trunc(t) * 60000;
}

/** 已经过去多少**整天**。向下取整，所以同一天里刷新数字不会跳；
 *  未来时间（本机时钟被改到过去）一律算 0，不显示负数。 */
export function capsuleDays(state, now = Date.now()) {
  const sealed = capsuleSealedAt(state);
  if (sealed === null) return 0;
  return Math.max(0, Math.floor((now - sealed) / 86400000));
}

/** 天数 → 老化进度 0..1（0 = 今天，1 = 45 天及以后）。纯函数，可单测。 */
export const agingOf = (days) =>
  clamp((Number(days) || 0) / AGE_DAYS_FULL, 0, 1);

/** 物件级老化进度（更慢的一条轴）。 */
export const agingOfObject = (days) =>
  clamp((Number(days) || 0) / AGE_DAYS_FULL_OBJECT, 0, 1);

/** C1 连续的 smoothstep：两端斜率为 0，所以老化的开始与结束都没有"突然拐弯"的痕迹 */
export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 五次 smootherstep：两端**一阶、二阶**斜率都为 0，中段推进比三次式快。
 *  用在做"越早越该看出来"的那条轴（秋色）上。 */
export function smootherstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 按进度在两条通道间插值（纯数学，给单测用；上色在 src/age.js 里靠 THREE.Color） */
export const mixNum = (a, b, t) => a + (b - a) * clamp(Number(t) || 0, 0, 1);

/**
 * 世界随天数长大的程度（草量与草高）。只依赖天数，所以同一个链接在任何时刻
 * 都渲染出同一个世界（确定性的，截图可复现）。返回的系数**乘在原有的天色系数上**，
 * 所以天色仍然是主调，变老只是它的一个偏移。
 *
 * 幅度是量出来的，不是估的：这一条是**唯一在屏幕上一眼能看出来**的通道
 * （草簇 491 → 667 时，逐像素实测有 6.2% 的画面在变、平均变 25 级）。
 * 颜色那条通道在同一批像素上只占 6.2%，所以"前 7 天看什么"要靠草量说话 ——
 * 见 tools/probe-capsule-delta.mjs 的分区量测。
 */
export function growthFactors(days) {
  const a = agingOf(days);
  return {
    count: 1 + 0.45 * a,   // 草更密（+45%）：屏幕上最直接的"它自己长了"的证据
    scale: 1 + 0.24 * a    // 草更高（+24%）：只放大 Y，别让草叶一起变宽
  };
}

/** 秋色权重 0..1：草从绿走向黄褐。**这条轴的调参过程值得留着**：
 *
 *  初版 smoothstep(0, 75, d)：第 7 天 0.02 —— 过了一周打开，什么都没变。
 *  改成 smoothstep(0, 150, d)：更糟，第 7 天 0.006、第 30 天 0.104 ——
 *    过渡被推到 60–100 天，而**真实打开时机就是 7/14/30 天**（365 天的极少）。
 *  现在 smootherstep(0, 75, d)：第 7 天 0.058、第 30 天 0.353、第 75 天到顶。
 *    同一批天数下"黄度差"从 +0.031（30 天）提升到 +0.10 上下，
 *    而且**越靠前推进越快**，正好对上真实用例。
 *  全部数字来自 tools/probe-capsule.mjs 的复测，不是估的。 */
export const autumnMix = (days) => smootherstep(0, 75, Number(days) || 0);

/** 开场与中心那行字。**0 天不显示** ——「这个世界，0 天了」是语法错误。
 *  语气故意是中性的（"这个世界，47 天了"而不是"等了你 47 天"）：
 *  零后端**无法知道打开链接的是本人还是收件人**，URL 里只有数据没有身份。
 *  写成"等了你"，给自己留胶囊的人打开时就成了"自己等了自己 47 天"。 */
export function capsuleLines(state, now = Date.now()) {
  const days = capsuleDays(state, now);
  if (days < 1) return null;
  return { days, line: `这个世界，${days} 天了`, badge: `${days} 天` };
}

/** 任意输入 → 合法状态。宁可用默认值，也绝不让坏链接把页面搞崩。 */
export function normalizeState(raw) {
  const s = makeEmptyState();
  if (!raw || typeof raw !== 'object') return s;

  s.n = typeof raw.n === 'string' ? raw.n.slice(0, 24) : '';
  s.m = typeof raw.m === 'string' ? raw.m.slice(0, 90) : '';
  s.t = Number.isFinite(raw.t) ? clamp(Math.trunc(raw.t), 0, SKIES.length - 1) : 0;

  /* 时间胶囊。**两个字段必须同时成立**才算数：
     只有 k 没有 c（或 c 不可信）→ 退回普通世界，而不是渲染一个"第 NaN 天"的世界。
     这里刻意不做"用当前时间补一个 c"——那会让每次打开都重置成第 0 天，
     时间胶囊就永远停在今天（静默失效，比显式失败更难查）。 */
  if (raw.k === CAPSULE_VERSION && Number.isFinite(raw.c)) {
    const c = Math.trunc(raw.c);
    if (c >= CAPSULE_TS_MIN && c <= CAPSULE_TS_MAX) { s.k = CAPSULE_VERSION; s.c = c; }
  }

  if (Array.isArray(raw.o)) {
    /* ⚠️ 未知 id **直接丢弃**，绝不兜底成 0。
       曾经写成 `OBJ_BY_ID.has(id) ? id : 0`：id 0 是「一盏旧灯」—— 全场最高、
       还会发光的那一件，于是"一条坏链接"会变成"九盏街灯"，把世界彻底改掉。
       坏数据应该消失，不该被替换成另一件真实存在的东西。 */
    const kept = raw.o
      .filter(a => Array.isArray(a) && a.length >= 3 && OBJ_BY_ID.has(num(a[0])))
      .map(a => [num(a[0]), clamp(num(a[1]), -999, 999), clamp(num(a[2]), -999, 999)])
      .filter((a, i, arr) => arr.findIndex(b => b[0] === a[0]) === i) // 同类物件只留一个
      .slice(0, MAX_OBJECTS);   // 一个世界最多这么多件：够摆满，又不至于变成杂物堆

    /* 坐标必须落在世界半径内。两条路：
       · 越界不多 → 逐点夹回来
       · 整圈都越界（老链接、或世界尺度改小之前的链接）→ **整体按比例缩回来**，
         而不是各夹各的 —— 各夹各的会把一个环压成一坨，构图直接毁掉。
       世界尺度从 6.5 设计米收到 2.4 实际米那一次，老链接全靠这一步保住观感。

       ⚠️ 两个都必须成立：**收敛到界内** 且 **保住方向**。
       · 不收敛的旧写法（缩一次 + 夹一次）最坏停在 6.56 米 —— 越界一点点就永远越界
       · 只求收敛的写法（把较大轴按 √(L²−小轴²) 解出来）会把斜向的点压向轴向：
         (99999, 99999) 会变成 (64, 7)，一个环被压成一条线 —— 比越界更难看
       所以这里用**整数迭代收敛**：等比缩到边界上，再沿半径方向逐单位收回，
       两个条件同时满足，而且循环次数有界（最坏 0.71 / 每步 >0.007 → 约百次封顶）。
       整数运算保证它一定停下，不需要靠浮点运气。 */
    let maxR = 0;
    for (const [, x, z] of kept) maxR = Math.max(maxR, Math.hypot(x, z));
    if (maxR > STORED_LIMIT) {
      const k = STORED_LIMIT / maxR;
      /* 量一个轴：优先贴住边界（四舍五入），但**只有不把点推出界外时**才用四舍五入。
         纯 floor 会让"正好该落在边界上"的点退到 L−1（旧的轴向断言就是这么断的），
         纯 round 又会把 6.51 → 7 推出去。两者都要兼顾，所以分情况。 */
      const fit = (v) => {
        const r = Math.round(v);
        return Math.abs(r) <= STORED_LIMIT ? r : Math.floor(v);
      };
      for (const a of kept) {
        let x = fit(a[1] * k), z = fit(a[2] * k);
        x = clamp(x, -STORED_LIMIT, STORED_LIMIT);
        z = clamp(z, -STORED_LIMIT, STORED_LIMIT);
        /* 收敛循环：仍然 > L 就沿半径方向收回 1 个单位。
           每步都向圆心走，hypot 单调下降，必然终止。
           斜向 (99999,99999) 从 (64,64) 收到 (46,46) 约 19 步，
           方向始终保持 45°，环不会被压成一条线。 */
        let guard = 0;
        while (Math.hypot(x, z) > STORED_LIMIT && guard++ < 200) {
          const r = Math.hypot(x, z);
          x = Math.round(x * (r - 1) / r);
          z = Math.round(z * (r - 1) / r);
        }
        // 兜底：理论上到不了这里，真到了就各轴夹紧（宁可损失构图也不能越界）
        if (Math.hypot(x, z) > STORED_LIMIT) {
          x = clamp(x, -STORED_LIMIT, STORED_LIMIT);
          z = clamp(z, -STORED_LIMIT, STORED_LIMIT);
        }
        a[1] = x;
        a[2] = z;
      }
    }
    s.o = kept;
  }

  /* ---------- 回信 ----------
     收件人收到世界之后，可以**选一件东西当作回信**，再写一句话发回去。
     为什么要让收件人自己选：选什么来信本身就是一次表达 ——
     纸船是"我收到了，让它漂回来"，蜡烛是"我把光留在这儿"，信是"把话还给你"。
     固定的那一种只会变成流程，可选的那一种才像回信。

     `r` = { o: 选中的物件 id, m: 回信的话, g: 他唤醒了哪几件（走过时亮起来的） }
     编码上沿用同一套紧凑字段，所以链接长度几乎不变。 */
  if (raw.r && typeof raw.r === 'object') {
    const rid = Math.trunc(raw.r.o);
    s.r = {
      o: REPLY_OBJECT_IDS.includes(rid) ? rid : REPLY_OBJECT_IDS[0],
      m: typeof raw.r.m === 'string' ? raw.r.m.slice(0, 90) : '',
      // 唤醒记录只留个数字范围，别让坏链接塞进来一堆东西
      g: Number.isFinite(raw.r.g) ? clamp(Math.trunc(raw.r.g), 0, MAX_OBJECTS) : 0
    };
    // 选中了哪件 / 唤醒了 0 件 且没写字 —— 这种"空回信"没有意义，直接丢掉
    if (!s.r.m && !s.r.g) s.r = null;
  }
  return s;
}

/* ---------- 编解码：对象 → hash 字符串 ---------- */

export function encodeState(state) {
  const s = normalizeState(state);
  // 键名压到 1 个字母，因为这是要塞进链接的东西。
  // `r` 只在真有回信时才带上 —— 绝大多数链接不该为它多付字符。
  const payload = { v: STATE_VERSION, n: s.n, m: s.m, t: s.t, o: s.o };
  if (s.r) payload.r = s.r;
  // 同上：分享链接（不是胶囊）不为 k/c 多付一个字符。
  // 胶囊链接约多 25 个字符（`,"k":1,"c":2938xxxxx`），相对于 1500 的上限可以忽略。
  if (s.k === CAPSULE_VERSION && s.c != null) { payload.k = s.k; payload.c = s.c; }
  return b64urlEncode(JSON.stringify(payload));
}

export function decodeState(token) {
  if (!token) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(token));
    if (!parsed || parsed.v !== STATE_VERSION) return null;
    return normalizeState(parsed);
  } catch {
    return null;
  }
}

/** 从 location.hash 取世界；`#w=demo` 是给评委看的样例世界 */
export function readHash(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (!h) return { mode: 'create', state: null };

  const m = /(?:^|&)w=([^&]+)/.exec(h);
  if (!m) return { mode: 'create', state: null };
  if (m[1] === 'demo') return { mode: 'receive', state: demoWorld() };

  const state = decodeState(m[1]);
  return state ? { mode: 'receive', state } : { mode: 'receive', state: demoWorld(), broken: true };
}

export function writeHash(state) {
  return '#w=' + encodeState(state);
}

/** 一条完整可发送的链接（截断到安全长度） */
export function shareLink(originPath, state) {
  const token = encodeState(state);
  if (token.length > MAX_HASH_LEN) return null;
  return originPath + '#w=' + token;
}

/** 创作者的起手世界：预放三件物件。
    一张空白的 3D 画布很劝退——先摆好三件，用户改一改就有感觉了。 */
export function starterWorld() {
  return normalizeState({
    v: STATE_VERSION,
    n: '',
    m: '',
    t: 0,
    o: [[3, 26, -14], [7, -22, 20], [6, 6, 28]]
  });
}

/* ---------- 样例世界：链接空着进来时给人看的东西 ----------
   9 件**全部**摆上，且收在半径 2.6–4.5 米的环上（世界半径 6.5 米）——
   外圈那 2 米空着，正是入场时从边缘往里走的那段路。
   为什么要用满 9 件：第一视角下，中景有没有东西决定了"这是个地方"还是"一片空地"。
   早先只放 5 件、还散在 3–4.5 米，结果画面中间一大片空的，
   东西全在边缘各自为政 —— 观者读到的是"空地 + 杂物"。
   两条摆放原则：
     · **留出视线走廊**：入场机位在 +Z 侧，正前方要能一眼看到中心那句话
     · **成组**：灯与自行车、椅子与纸船各自成对，物件之间才有关系
   存储单位是设计分米（MINI=1 时 1 单位 = 0.1 米），所以 30 ≈ 3.0 米。 */
export function demoWorld() {
  return normalizeState({
    v: STATE_VERSION,
    n: '小时候的自己',
    m: '你当年以为弄丢的那只纸船，其实一直停在这里。',
    t: 0,
    o: [
      /* ⚠️ 这一组坐标的依据是**走路的长度**，不是构图口味 ——
         旧环在 1.84–4.10 m，而入场点到触发圈只有 3.4 m、步速 2.7 m/s ≈ 1.3 秒，
         也就是说"走进去"这个动作实际上不存在（清单第 10 条实测）。
         所以整环按约 1.45 倍外推到 **3.2–5.5 m**，把中景让出来，
         同时保证两件会回应的东西仍在行进路线上。
         行进路线：x≈0，z 从 6.9（入场）走到 1.2（触发），走廊约 |x| < 1.8。

         摆放原则不变：
           · **留出视线走廊**：入场机位在 +Z 侧，正前方一眼看到中心
           · **成组**：灯与自行车、椅子与纸船各自成对
         存储单位是设计分米（MINI=1 时 1 单位 = 0.1 米），所以 30 ≈ 3.0 米。 */
      // 纸船压在入场走廊上：它正是那句话说的东西，走到中心必经它身旁。
      // 构图上的"叙事线"就靠这一件串起来 —— 站在边缘能看见它，走近才看清。
      [7, 3, 36],      // 一只纸船（走廊上，4.6 m 远的正前方）
      /* ⚠️ 两件**会回应你**的东西（灯、蜡烛）必须摆在**行进路线上**。
         反应半径只有 2 米（attention.js 的 NEAR_R），摆在 2 米开外
         整条路走完它一次都不会亮 —— 机制是对的，但摆错了地方等于没有。
         实测：灯在 z=30 处最近距离 1.64 m，蜡烛在 z=23 处最近距离 1.80 m，都在圈内。 */
      [0, -16, 30],    // 一盏旧灯（左手边，走近会亮一档）
      [8, 17, 23],     // 一支蜡烛（右手边，火苗会被你扰动）
      [5, -29, 38],    // 一辆自行车（给出尺度感，5.0 m）
      [3, 33, -24],    // 一株长歪的树（远处的竖向标记，要抬头看，4.9 m）
      [2, 34, 20],     // 一把空椅子（3.9 m）
      [6, 24, 20],     // 一块石头（3.1 m）
      [14, -27, 27],   // 一块苔石（与石头呼应）
      [13, 27, -34]    // 一截木桩（4.3 m）
    ]
  });
}

/** 把链接长度换算成"还塞得下几个字"，用于创作者界面的余量提示 */
export function budget(state) {
  const len = encodeState(state).length;
  return { len, max: MAX_HASH_LEN, ok: len <= MAX_HASH_LEN, left: MAX_HASH_LEN - len };
}
