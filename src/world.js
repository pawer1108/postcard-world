/* 世界的搭建：天色、地面、物件、天气、中心的"那句话"
   占位几何体只是脚手架——Tripo 产出的 GLB 一旦落到 assets/models/<id>.glb，
   同名物件会自动换成真模型，代码不用改。
*/
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { OBJECTS, MINI, WORLD_RADIUS, EYE_HEIGHT, STORED_LIMIT, autumnMix, growthFactors } from './state.js';
import { grassHueFor, leafFactors, groundWarmth, applyObjectAging } from './age.js';
export { WORLD_RADIUS, EYE_HEIGHT };

/* ---------- 世界尺度：定义在 state.js（纯逻辑那边也要用），这里只做转出 ----------
   基准是"正常人的第一视角下模型看起来是正常大小"：眼高 1.62 米、物件按真实尺寸。
   下面的尺寸都写成"设计米 × MINI"；MINI=1 时两者等同，
   保留这层乘法只是为了将来若要整体缩放只改一个数。
   ⚠️ 但**不要**用 MINI 去改"人机比例" —— 那个只能由真实尺寸决定：
   把人缩小、让所有东西高过你，只会让观者立刻看出"这是模型"。 */

/* 入场落点与"那句话"的触发半径 —— **只在这里定义**，别处一律 import。
   为什么必须收在一处：这两个数一起决定"走进去"这段路有多长，
   而它们曾经散在三个地方（`backToStart`、`buildWorld`、门口判定），
   改一处另外两处不跟着动，路长就悄悄变了（这类错不报错，只表现为"感觉不对"）。

   数值的依据是**走路的时间**，不是构图口味：
   · 落点 6.9 m（世界半径 6.5，移动钳制线 6.0）—— 落地时站在边界外沿，
     先看见整个世界的轮廓，再往里走。钳制线是 6.0，所以第一帧会被拉回来，
     这是**有意的**：它保证"从外面走近"这个观感成立，同时不越出可走区域。
   · 触发 1.2 m —— 必须真的走到中心附近，而不是一进场就踩着圈边。
   · 于是路程 = 6.0 − 1.2 = 4.8 m，按 2.7 m/s 约 **1.8 秒**。
     改前是 3.4 m / 1.3 秒 —— 那 1.3 秒里"走进去"这个动作基本不存在。 */
export const SPAWN_RADIUS = 6.9 * MINI;      // 入场落点（世界米，从中心算起）
export const CENTER_TRIGGER = 1.2 * MINI;    // 走到多近，那句话才浮出来
export { MINI, STORED_LIMIT };

/** 链接里存的 0.1 米 → 世界米。全项目只此一处换算，别再各写各的 */
export const fromStored = (v) => v * 0.1 * MINI;
/** 世界米 → 链接里存的 0.1 米（摆放交互要用：指针算出来的是世界米，存的是设计分米） */
export const toStored = (m) => m / (0.1 * MINI);

/* ---------- 地面的大色块分区（微缩沙盘的"底"）----------
   一块匀色的地面读起来是"塑料板"：没有大小对比，也没有"哪里是草地、哪里是土"。
   这里用一层低频噪声把世界切成三块**相邻色相**的地面——
   苔绿（暗、发青，草长密的低洼）、干土（暖、发黄，草稀的裸地）、浅土（亮，中间调）。
   三块的明度差拉得比色相差大得多，所以读起来是"同一块地踩得深浅不一"，
   而不是"贴了三张色纸"。分区同时决定草的密度：草地密、裸地稀 —— 地色和草量同源，
   两件事才不会各自为政。

   噪声频率要**按世界尺度**给：它决定的是斑块的物理尺寸，
   世界缩了而频率不缩，斑块就会大得占满整个世界。 */
const ZONE_NOISE = (x, z) => (
  Math.sin(x * 0.47 / MINI + 1.3) * Math.cos(z * 0.39 / MINI - 0.7)
  + 0.55 * Math.sin((x + z) * 0.23 / MINI + 2.1)
);
const ZONE_MIX = (x, z) => Math.min(1, Math.max(0, ZONE_NOISE(x, z) * 0.45 + 0.5));

/** 返回 [苔绿, 干土, 浅土] 三个权重，和为 1。
 *  干土只占 ~18%（它的色相离草色最远，多了就把"最多 5 个色相"吃满），
 *  而且**只在外圈出现**：中心要留给那句话和踩踏区，那里必须干净。 */
function zoneAt(x, z, out = [0, 0, 0]) {
  const r = Math.hypot(x, z) / WORLD_RADIUS;
  const m = ZONE_MIX(x, z);
  const edge = Math.min(1, Math.max(0, (r - 0.22) / 0.45));
  out[0] = Math.min(1, Math.max(0, (m - 0.34) / 0.42));            // 苔绿：低洼
  out[1] = Math.min(1, Math.max(0, (0.26 - m) / 0.30)) * edge;     // 干土：只在外圈
  out[2] = Math.max(0, 1 - out[0] - out[1]);                       // 浅土：兜底
  return out;
}

const ZONE_TINT = [
  new THREE.Color(0x4c5638),   // 苔绿：暗、发青
  new THREE.Color(0x6d5836),   // 干土：暖、发黄
  new THREE.Color(0x6d5c48)    // 浅土：中间调
];

/* ---------- 地面起伏 ----------
   完全平的地面是第一视角下最伤"像不像一个地方"的一件事：
   平地上所有点的法线都朝上，光照处处相同，于是地面退化成一整块匀色，
   连"远近"都读不出来（只剩雾在做纵深）。实测过：中景一大片 L17 的匀色，
   占总画面四成，什么都读不到。

   幅度取 ±5.5 cm —— 目的不是造地形，是**让法线有变化**，光才能在地面上擦出明暗。
   波长 5.2 / 3.0 / 1.7 米（世界半径 6.5 米），是"几步一个坡"的尺度。

   ⚠️ 两个约束：
   1. **中心必须是平的** —— 水洼是一整块平面反射器（不可能做成曲面），
      地面若有起伏就会穿出水面。所以用 `ramp` 把中心 1.4 米以内的起伏压到 0，
      外围才放开。
   2. **幅度要小于草高**，否则草会浮在坡上或陷进坡里。

   这是**纯函数**：地面、草、物件落点都读它，否则物件会浮在坡上方。 */
const GROUND_FLAT_R = 1.4;      // 这个半径以内不起伏（水洼在这里）
const GROUND_RAMP = 0.5;        // 从平到满幅的过渡带宽

export function groundHeight(x, z) {
  const r = Math.hypot(x, z);
  const ramp = Math.min(1, Math.max(0, (r - GROUND_FLAT_R) / GROUND_RAMP));
  if (ramp <= 0) return 0;
  const h = 0.032 * Math.sin(x * 0.38 + 1.1) * Math.cos(z * 0.33 - 0.6)
    + 0.020 * Math.sin((x + z) * 0.21 + 2.3)
    + 0.010 * Math.sin(x * 0.84 - 0.4) * Math.cos(z * 0.77 + 0.9);
  return h * ramp;
}

/** 地形的法线：解析求导。低频缓坡用解析法比 computeVertexNormals 好 ——
 *  顶点密度不够时逐面法线会把缓坡画成一格一格的 */
function groundNormal(x, z, out = new THREE.Vector3()) {
  const e = 0.03;
  const hx = (groundHeight(x + e, z) - groundHeight(x - e, z)) / (2 * e);
  const hz = (groundHeight(x, z + e) - groundHeight(x, z - e)) / (2 * e);
  return out.set(-hx, 1, -hz).normalize();
}

/* ---------- 天色 ---------- */
/** 天空穹顶：竖直渐变。纯色天空会让世界显得像块贴了色卡的板子。
 *
 *  ⚠️ 关键在**渐变的形状**，不在两端取什么色。
 *  穹顶用 `t = 0.5 + y/(2R)` 映射：天顶 t=1、地平线 t=0.5、天底 t=0。
 *  而站在地面上的人只能看见仰角 0°–30° 那一条带 —— 换算过去只覆盖 t 的
 *  0.5→0.75，也就是**整段渐变里最靠地平线的一小块**。
 *  剩下的 t（0.75→1，整个头顶）几乎没人看，却被分走了一半的渐变。
 *  于是：明明两端色差很大（实测黄昏天顶 L25 → 地平线 L86，ΔL 62），
 *  画面里的天空却读起来接近一块平色 —— 光晕全挤在贴着地平线的一条细带上。
 *
 *  解法是把渐变**重新分配**：让可见的那条带拿走进度的大部分。
 *  指数 > 1 会把过渡推向天际线一侧（指数越大越集中在低空）。
 *  实测 0.85 → 2.6 之后，仰角 10° 处的亮度从天顶/horizon 插值的约 1/3 处
 *  提到约 2/3 处，抬头就是"天在发光"。
 *  同时地平线往冷里偏一点：真实黄昏天地交界处是冷的（瑞利散射），
 *  而那圈暖光交给雾色去承接（fogColorOf 从 bottom 派生）。 */
const HORIZON_COOL = 0.22;      // 地平线往冷色偏多少
const SKY_CURVE = 2.3;          // 渐变分配指数（>1 把亮部压向地平线）

export function createSkyDome(sky) {
  const R = 70;
  const geo = new THREE.SphereGeometry(R, 32, 48);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  /* 天空单独压一档曝光：它不吃光照（MeshBasicMaterial），完全由顶点色决定，
     所以在最亮的那几套天色下会直接顶到纯白 —— 实测"雨后"整片天空是 #ffffff，
     只剩 2 个明度台阶，渐变全没了（见 tools/probe-sky-screen.mjs）。
     全局曝光不能动（那会把地面一起压暗），所以只给天空一个**只减不增**的系数：
     比中性天色亮的往回收，比它暗的不动。 */
  const amb = sky.ambI ?? 0.5;
  const NEUTRAL = 0.52;                      // 到这个亮度为止天空都没问题
  const skyScale = amb > NEUTRAL ? Math.max(0.68, 1 - (amb - NEUTRAL) * 1.85) : 1;
  const top = new THREE.Color(sky.top).multiplyScalar(skyScale);
  // 地平线：原色往冷里拉一点。两侧都留，免得变成一条生硬的蓝线
  const bottomRaw = new THREE.Color(sky.bottom).multiplyScalar(skyScale);
  const bottom = bottomRaw.clone().lerp(
    new THREE.Color(bottomRaw.r * 0.82, bottomRaw.g * 0.90, bottomRaw.b * 1.18), HORIZON_COOL);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.pow(THREE.MathUtils.clamp(pos.getY(i) / R * 0.5 + 0.5, 0, 1), SKY_CURVE);
    c.copy(bottom).lerp(top, t);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
    // 渐变在 8bit 下必出条带；three 自带抖动开关，一行消掉那种廉价感
    dithering: true
  }));
  mesh.renderOrder = -1;
  mesh.name = 'skyDome';
  return mesh;
}

/** 雾色与远山色都从天空地平线派生。
    以前雾色是另外调的，结果远景像"被一层灰雾切了一刀"，而不是"融进天里"。
    ⚠️ 但派生出来的颜色对**亮天色**来说太亮：实测"雨后"的雾色经色调映射后
    顶到纯白，整条地平线糊成一片、只剩 2–3 个明度台阶（见 tools/probe-sky-screen.mjs）。
    雾本来是要"把圆盘边缘化掉"，结果自己变成一条白带。
    所以地平线很亮时把雾压一档 —— 仍然与天同源，只是比天略沉，
    这也更接近真实：近地的空气总比天空脏一点、暗一点。 */
export function fogColorOf(sky) {
  const c = new THREE.Color(sky.bottom).lerp(new THREE.Color(sky.top), 0.18).multiplyScalar(0.92);
  const amb = sky.ambI ?? 0.5;
  const NEUTRAL = 0.52;
  if (amb > NEUTRAL) c.multiplyScalar(Math.max(0.66, 1 - (amb - NEUTRAL) * 1.7));
  return c;
}

export function applySky(scene, sky) {
  // 换天色时把上一个穹顶清掉，免得叠着
  const old = scene.getObjectByName('skyDome');
  if (old) { scene.remove(old); old.geometry.dispose(); old.material.dispose(); }

  scene.add(createSkyDome(sky));
  scene.background = new THREE.Color(sky.top);   // 兜底：穹顶万一被剔除也不至于穿帮
  // 雾收得近，圆盘边缘才会化掉——看得见边它就是个盘子，看不见边它才像个世界
  scene.fog = new THREE.Fog(fogColorOf(sky), sky.fogNear ?? 5, sky.fogFar ?? 18);
  return { sky, ground: sky.ground };
}

/* ---------- 地面 ---------- */
export function createGround(sky) {
  const g = new THREE.Group();
  const R = WORLD_RADIUS + 0.6 * MINI;

  // 用 RingGeometry 而不是 CircleGeometry：它带径向细分，才有足够顶点做明暗变化。
  // 细分从 96×14 提到 128×22：加了起伏之后 0.5 米的顶点间距太粗，
  // 坡会变成一格一格的折线（顶点数从 ~1400 到 ~2900，对性能无影响）
  const geo = new THREE.RingGeometry(0.02, R, 128, 22);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal.array;      // RingGeometry 自带 normal，直接改写
  const colors = new Float32Array(pos.count * 3);
  const base = new THREE.Color(sky.ground);
  const fogCol = fogColorOf(sky);
  // 踩踏处露出的浅色土 —— 地面本身也要变浅，草少下去才不像"草飘在地上"
  const wornCol = base.clone().lerp(new THREE.Color(0xb9a487), 0.5).multiplyScalar(1.12);
  const c = new THREE.Color();
  const zc = new THREE.Color();
  const zw = [0, 0, 0];
  let seed = 7;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    // 起伏：把顶点抬到高度场上，并写解析法线（低频坡用逐面法线会成一格一格）
    pos.setY(i, groundHeight(x, z));
    const n = groundNormal(x, z);
    nrm[i * 3] = n.x; nrm[i * 3 + 1] = n.y; nrm[i * 3 + 2] = n.z;
    const r = Math.hypot(x, z) / R;
    // 中心略亮、边缘压暗，再叠一点噪声 —— 免得地面像一块塑料板
    const v = (0.9 + rnd() * 0.16 - r * 0.2);
    c.copy(base).multiplyScalar(Math.max(0.3, v));
    // 大色块分区：先按权重把地色拉到该区的色，再往下叠踩踏 / 小径 / 边缘融雾。
    // 顺序不能反 —— 踩秃的土色和小径必须压在分区之上，否则"人走过的痕迹"会被地色盖掉。
    zoneAt(x, z, zw);
    zc.setRGB(0, 0, 0);
    for (let k = 0; k < 3; k++) zc.r += ZONE_TINT[k].r * zw[k], zc.g += ZONE_TINT[k].g * zw[k], zc.b += ZONE_TINT[k].b * zw[k];
    // 分区是**低频色相**，明暗还是交给 base 的 v —— 直接覆盖会丢掉地面的明暗起伏
    c.lerp(zc, 0.55 * (1 - Math.max(0, (r - 0.18) / 0.7)) + 0.18);
    // 踩秃的中心与小径：由同一套判定驱动，和草丛的稀疏完全对齐
    if (isWorn(x, z)) c.lerp(wornCol, 0.30);
    else if (onPath(x, z)) c.lerp(wornCol, 0.22);
    // 最外圈融进雾色：远视角下整块地面都在雾程以内，只靠雾吃不掉硬边，
    // 必须主动把边缘染成雾的颜色。但**带宽要窄**——从 0.68 就开始融会把
    // 大半个地面洗成雾色，画面发灰。只融最外 14%。
    const edge = THREE.MathUtils.smoothstep(r, 0.86, 1.0);
    c.lerp(fogCol, edge * 0.92);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.attributes.normal.needsUpdate = true;
  // 顶点被抬高过，包围球必须重算，否则视锥剔除会按旧范围裁掉这块地
  geo.computeBoundingSphere();

  const disc = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, color: 0xffffff, roughness: 0.96, metalness: 0.0
  }));
  disc.receiveShadow = true;
  g.add(disc);

  // 一道很淡的边缘圈：让"世界是有边界的"这件事被看见。
  // 它是平的一圈，而地面在 r=6.5 处起伏到 4 cm —— 固定 y 会让 13% 的周长被地形埋掉、
  // 看起来时隐时现。抬到最高起伏之上，问题就没了。
  const ringHeight = 0.06;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(WORLD_RADIUS - 0.06 * MINI, WORLD_RADIUS + 0.14 * MINI, 128),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = ringHeight;
  g.add(ring);

  return g;
}

/* ---------- 地面点缀：草簇 / 石子 / 落叶 ----------
   这是让世界"不空"最有效也最便宜的手段：程序生成，不花 credits，可以铺几百个。
   用 InstancedMesh，几百个实例只有一次绘制调用。
   全部由种子决定 —— 同一条链接在任何机器上看到的草地一模一样。 */

/** 确定性随机：同一种子必然产生同一片草地 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 风的方向：所有草朝同一侧倒。
   全随机朝向的草读起来是"噪点"，风向一致才读得出"这是被风吹过的一片草地"。
   注意：**风不能靠"朝向全随机"来体现体积** —— 体积由叶片的方位角分布给，
   风只是在那个基础上整体斜一档。这两件事以前被混成了一件。 */
const WIND = Math.PI * 0.22;

/**
 * 一片草叶：一条**渐细的带子**，从根部斜着长出去，带一点自然的弯。
 *
 * 为什么不再用"一个薄三角"：三角叶的正投影在侧视时趋近于零，
 * 于是整簇草是**共面**的 —— 转个角度草就消失，横看就是一条纸线。
 * 这是"草像片面"的根因，不是密度不够。
 *
 * 三个细节都是有意的：
 *  1. **每片叶各自绕根随机方位角** → 一簇草在 360° 都有占位，从任何角度看都是立体的
 *  2. **法线全部固定朝上** → 背面不再因为 DoubleSide 反法线而发黑（纸片感的第二个来源），
 *     代价是放弃逐叶的受光差异，换来的是低多边形该有的干净剪影
 *  3. **顶点色从根部到梢部变亮** → 假接触阴影。草自己暗在根部，"插进土里"才成立
 */
function pushBlade(pos, col, { az, lean, h, w, bend, seg, base, tip, jitter }) {
  const ca = Math.cos(az), sa = Math.sin(az);
  const rows = [];
  for (let k = 0; k <= seg; k++) {
    const t = k / seg;
    // 侧向位移：线性倾斜 + 二次弯曲（重力把梢部压得更低）
    const off = lean * t + bend * t * t;
    // 渐细，但不收到 0 —— 收到 0 会变成针。
    // 乘 0.5：下面顶点是 ±wid 对称推的，所以**实际叶宽 = 2×w**（实测踩过这个坑，
    // 声明 18 mm 实际出 36 mm，一片叶比手指宽）
    const wid = w * 0.5 * (1 - t * 0.82);
    // 垂直风向的横向抖动：同簇叶片不要挤在一个平面上
    const sw = jitter * Math.sin(t * 2.1 + az * 3.0) * 0.5;
    rows.push([ca * off - sa * sw, h * t, sa * off + ca * sw, wid]);
  }
  const shade = (t) => base + (tip - base) * t;
  for (let k = 0; k < seg; k++) {
    const [x0, y0, z0, w0] = rows[k];
    const [x1, y1, z1, w1] = rows[k + 1];
    const s0 = shade(k / seg), s1 = shade((k + 1) / seg);
    /* 两个三角拼成一段带子。
       ⚠️ **绕序必须是逆时针（从上方看）**，否则面法线朝下：
       three 在 DOUBLE_SIDED 下会执行 `normal *= faceDirection`，
       背面就把我们特意写死的"朝上法线"翻成 (0,-1,0)，平行光贡献直接归零 ——
       草只剩环境光，而且相机一动就在正/背面之间跳变，成片忽明忽暗地闪。
       实测过第一版：48 个三角形里 48 个法线 y<0、83% 是背面。 */
    pos.push(
      x0 - sa * w0, y0, z0 + ca * w0,
      x1 + sa * w1, y1, z1 - ca * w1,
      x0 + sa * w0, y0, z0 - ca * w0,
      x0 - sa * w0, y0, z0 + ca * w0,
      x1 - sa * w1, y1, z1 + ca * w1,
      x1 + sa * w1, y1, z1 - ca * w1
    );
    col.push(s0, s0, s0, s1, s1, s1, s0, s0, s0, s0, s0, s0, s1, s1, s1, s1, s1, s1);
  }
}

/* 草叶的排布参数（全部程序生成，不用任何贴图 —— 与本作"零贴图文件"的约束一致）。
   `width` 是**叶片的实际米数**，不是相对系数：真实草叶宽 3–15 mm，
   视觉上要略夸张一点才看得见，所以取 11 mm。

   早先这里是三套排布（star/dense/brush）的对照表 + `?gv=` 开关，用来挑方案。
   选定之后**只保留选中的这一套** —— 留着对照表会有一个很隐蔽的风险：
   默认值与"拍摄演示片/看板时实际用的值"可能不一致，
   于是交付出去的作品和交付的视频长得不一样（这个坑真踩过：
   视频用 dense 拍的，线上默认却是 star）。 */
const GRASS = {
  blades: 11,          // 一簇的叶片数：多一点更密，像草丛而不是几根草
  seg: 4,              // 每片叶的段数（决定弯曲是否顺滑）
  width: 0.011 * MINI, // 叶宽（实际米数）；顶点是 ±width/2 对称推的
  leanK: 0.90,         // 倾斜系数
  bendK: 1.15,         // 弯曲系数（梢部下垂）
  jitter: 0.03 * MINI  // 丛内叶片不要挤在一个平面上
};

/** 一簇草：按 GRASS 的参数生成。
 *  叶片宽度**只由 GRASS.width 决定**（实际米数），调用方给的 `w` 不再参与 ——
 *  两处都能改宽度就会互相乘出 2–4 cm 的"龙舌兰叶"。 */
function makeTuftGeometry({
  blades = GRASS.blades, h = 0.085 * MINI, hStep = 0.026 * MINI,
  lean = 0.15 * MINI, leanStep = 0.045 * MINI, bend = 0.05 * MINI
} = {}) {
  const V = GRASS;
  const pos = [], col = [];
  const n = blades;
  const GA = 2.39996;                      // 黄金角：让方位角铺得开又不结块
  for (let i = 0; i < n; i++) {
    // 方位角：均匀铺开 + 一点散列抖动，保证 360° 都有叶（这是"立体"的来源）
    const az = (i / n) * Math.PI * 2 + ((i * GA) % 1) * 0.45 + WIND;
    const t = n > 1 ? i / (n - 1) : 0.5;
    // 高度与倾斜：中间几片高、两侧低，读起来才像一丛而不是一排
    const hh = (h + (i % 4) * hStep) * (0.80 + 0.30 * Math.sin(Math.PI * t));
    const ln = (lean + (i % 3) * leanStep) * V.leanK * (0.7 + 0.6 * (((i * 7) % 5) / 4));
    pushBlade(pos, col, {
      az, lean: ln, h: hh, w: V.width,
      bend: bend * V.bendK, seg: V.seg, base: 0.62, tip: 1.0, jitter: V.jitter
    });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) { nrm[i] = 0; nrm[i + 1] = 1; nrm[i + 2] = 0; }  // 全部朝上
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

/* 两级草：贴地的**矮草**铺底、稀疏的**高草锚点**在画面边缘立出前后景层次。
   参照眼高 1.62 米：矮草铺到脚踝（0.10–0.20 米），高草锚点到膝盖上下（0.30–0.55 米）。
   **这里不写 blades**：叶片数是草的整体风格（GRASS.blades），两级草共用；
   写了就会覆盖掉它 —— 早先这里写 6/9，把"一簇 11 片"的设定整个顶掉了。 */
const TUFT_SHORT = { h: 0.075 * MINI, hStep: 0.020 * MINI, lean: 0.10 * MINI, leanStep: 0.02 * MINI, bend: 0.024 * MINI };
const TUFT_TALL = { h: 0.230 * MINI, hStep: 0.060 * MINI, lean: 0.40 * MINI, leanStep: 0.08 * MINI, bend: 0.100 * MINI };
/** 每个天色的植被配置：草色只给 2–3 个色相（色相少、靠明度拉开），
    数量与高度也随天色变——换天色应该像换季节，而不只是换了打光。 */
const VEG = {
  dusk:      { colors: [0x6b7f46, 0x5b6f3c, 0x7c8a50], count: 1.00, scale: 1.00 },
  night:     { colors: [0x2f4232, 0x27392c, 0x3a4d38], count: 0.85, scale: 0.92 },
  dawn:      { colors: [0x6a7a48, 0x5a6a3e, 0x7f8c54], count: 1.00, scale: 1.02 },
  noon:      { colors: [0x5c8c3c, 0x4e7c34, 0x6d9c48], count: 1.15, scale: 1.14 },
  rain:      { colors: [0x40603a, 0x36522f, 0x4b6a42], count: 1.05, scale: 0.95 },
  afterrain: { colors: [0x3b6c40, 0x2f5a34, 0x468047], count: 1.10, scale: 1.06 },
  snow:      { colors: [0x8d8d70, 0x7c7c60, 0x9c9c80], count: 0.52, scale: 0.78 }
};

function vegKeyOf(sky) {
  if (sky.weather === 'snow') return 'snow';
  if (sky.weather === 'rain') return 'rain';
  if (sky.id === 6) return 'afterrain';          // 雨后
  if (sky.sound === 'night') return 'night';
  if (sky.sound === 'dawn') return 'dawn';
  if (sky.sound === 'noon') return 'noon';
  return 'dusk';
}

/* 小径与踩秃区 —— 地面和草丛共用同一套判定，视觉上才对得上 */
const PATH_HALF = 0.58 * MINI;
export const onPath = (x, z) => z > 0.2 * MINI && Math.abs(x) < PATH_HALF;
export const isWorn = (x, z) => Math.hypot(x, z) < 1.15 * MINI;

/** 一件物件脚下留出的空地半径。
 *  按物件的**平面占地**给，不按包围盒最大边 —— 树高 4.5 米但树干只占 0.2 米，
 *  照高度清出 1.8 米空地会把世界清秃（这个坑在早先版本踩过一次）。
 *  草丛留白与烘焙 AO 的邻近半径都读这一个函数：两处若各写各的，草和阴影就会对不上。 */
export const clearingRadius = (def) => Math.max(0.25 * MINI, (def?.size ?? 0.6) * MINI * 0.27);

/**
 * 地面点缀：草簇 / 石子 / 落叶。
 *
 * 三条"设计感"的来由（这决定了它像作品还是像噪点）：
 *   1. **留白**：物件脚下不长草 —— 家具周围一定是秃的，"草长到椅子腿里"是最强的没设计过信号
 *   2. **成片**：草先聚成丛，丛间留空，而不是均匀概率撒点
 *   3. **风向一致**：所有草朝同一侧倒
 */
export function createScatter(sky, placed = [], seed = 20261006, days = 0) {
  const group = new THREE.Group();
  group.name = 'scatter';
  const rnd = mulberry32(seed);
  const R = WORLD_RADIUS + 0.3 * MINI;
  const veg = VEG[vegKeyOf(sky)];

  // 每件物件脚下留出的空地半径（见 clearingRadius：草丛留白与烘焙 AO 共用同一个数）
  const clearings = placed.map(([id, x, z]) => {
    const def = OBJECTS.find(o => o.id === id);
    return { x: x / 10, z: z / 10, r: clearingRadius(def) };
  });

  /** 分区权重复用的暂存数组：weightAt 每个候选点都要算一次，
   *  每次都新建三个元素的数组就是几千次无谓分配。 */
  const ztmp = [0, 0, 0];

  /** 返回 [密度权重, 高度权重]；0 表示这里不长东西 */
  const weightAt = (x, z) => {
    for (const cl of clearings) {
      const d = Math.hypot(x - cl.x, z - cl.z);
      if (d < cl.r) return [0.06, 0.5];             // 脚下几乎是土地，但留一点点
      if (d < cl.r + 0.3 * MINI) return [0.5, 0.8];        // 边缘渐稀，不做硬边
    }
    // 地色和草量同源：苔绿区（暗、发青）草密一些，干土区（暖黄裸地）几乎不长草。
    // 区域的边界因此由"草密度的变化"读出来，而不是只靠一块色斑 —— 色斑单独存在时像贴纸。
    const zw = zoneAt(x, z, ztmp);
    const zoneDens = 0.42 + 0.58 * zw[0] + 0.10 * zw[2] - 0.36 * zw[1];
    if (isWorn(x, z)) return [0.5 * zoneDens, 0.72];   // 中心被踩得稀一些矮一些，不是秃
    if (onPath(x, z)) return [0.55 * zoneDens, 0.66];  // 小径上又稀又矮
    return [Math.max(0.1, Math.min(1, zoneDens)), 1];
  };

  /** 成片采样：先定丛心，再在丛心周围撒几簇 */
  const clustered = (count, spread = 0.42 * MINI, rMin = 0.15) => {
    const out = [];
    const clusters = Math.ceil(count / 3.4);
    for (let c = 0; c < clusters && out.length < count; c++) {
      const r = (rMin + (1 - rMin) * Math.sqrt(rnd())) * R;
      const a = rnd() * Math.PI * 2;
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
      const n = 2 + Math.floor(rnd() * 4);
      for (let k = 0; k < n && out.length < count; k++) {
        const rr = Math.sqrt(rnd()) * spread;
        const aa = rnd() * Math.PI * 2;
        out.push([cx + Math.cos(aa) * rr, cz + Math.sin(aa) * rr]);
      }
    }
    return out;
  };

  /** 均匀采样（石子/落叶用，它们不需要成片） */
  const uniform = (count, rMin = 0.15) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const r = (rMin + (1 - rMin) * Math.sqrt(rnd())) * R;
      const a = rnd() * Math.PI * 2;
      out.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return out;
  };

  /** 按权重筛选：留下的点带上高度系数 */
  const filter = (spots) => {
    const out = [];
    for (const [x, z] of spots) {
      const [dens, hk] = weightAt(x, z);
      if (dens > 0 && rnd() < dens) out.push({ x, z, hk });
    }
    return out;
  };

  /** 两级草里的**高草锚点**：不是概率撒出来的，是"种"出来的。
   *  概率撒点会让高草随机散在全场 —— 那样只有"草丛大小不一"，没有层次。
   *  这里只在两个地方立高草：**物件环的外侧**（把物件"框"在草里，
   *  同时给站在环内的你一圈近处的遮挡）和每件物件留白圈的边缘。
   *  每个锚点再散成 2–4 根：单根草茎太瘦，读不出体量。 */
  const tallAnchors = (total) => {
    const out = [];
    const bases = [];
    const nRing = Math.round(total / 3.2);
    for (let i = 0; i < nRing; i++) {
      // 角度均匀 + 抖动：纯随机会在圆环上结块
      const a = (i / nRing) * Math.PI * 2 + (rnd() - 0.5) * 0.5;
      // 物件环在 3–4.5 米，高草落在 3.8–5.2 米：正好卡在物件身后、世界边缘之前
      const r = 3.8 * MINI + rnd() * 1.4 * MINI;
      bases.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    for (const cl of clearings) {
      const a = rnd() * Math.PI * 2;
      bases.push([cl.x + Math.cos(a) * (cl.r + 0.25 * MINI), cl.z + Math.sin(a) * (cl.r + 0.25 * MINI)]);
    }
    for (const [bx, bz] of bases) {
      const n = 2 + Math.floor(rnd() * 3);
      for (let k = 0; k < n && out.length < total; k++) {
        const rr = Math.sqrt(rnd()) * 0.30 * MINI;
        const aa = rnd() * Math.PI * 2;
        out.push({ x: bx + Math.cos(aa) * rr, z: bz + Math.sin(aa) * rr, hk: 1 });
      }
    }
    return out;
  };

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();

  const build = (geo, spots, { sMin, sMax, tilt, colorOf, y = 0, yawJitter = 0.12, vertexColors = false, grow = 1 }) => {
    if (!spots.length) return null;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
      // 草的几何在根部压暗（假接触阴影）。这是**逐顶点**的，而 instanceColor 是**逐实例**的，
      // three 会把两者相乘 —— 正好是想要的：每簇自己的色相 × 丛内的根暗梢亮。
      vertexColors
    });
    const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
    mesh.receiveShadow = true;
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      // 只给很小的朝向抖动：风的一致性不能被随机朝向抹掉
      q.setFromEuler(new THREE.Euler(tilt * (rnd() - 0.5), (rnd() - 0.5) * yawJitter, tilt * (rnd() - 0.5)));
      const sc = sMin + rnd() * (sMax - sMin);
      // 高度上叠两个系数：天色自己的（veg.scale）+ 时间胶囊的（grow）。
      // 只放大 Y：XY 等比放大会让草叶一起变宽 → 变成"龙舌兰"（踩过这个坑）
      const hs = sc * (0.8 + rnd() * 0.6) * (s.hk ?? 1) * veg.scale * grow;
      // 落到高度场上：地面起伏 ±5.5 cm，而草只有 10–20 cm，
      // 按 y=0 平铺会让草浮在坡上或陷进坡里，一眼就看出是"贴"上去的
      m.compose(new THREE.Vector3(s.x, groundHeight(s.x, s.z) + y, s.z), q, new THREE.Vector3(sc, hs, sc));
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, colorOf(c, rnd));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
    return mesh;
  };

  /* 草：只从 2–3 个色相里挑，靠明度微差拉开，不再连续随机上色。
     两级草的**总量与改动前持平**（矮 520 + 高 55 ≈ 原来的 600 候选），
     所以这次改动没有把拍摄和低端机的负担推高 —— 换来的只是层次。

     ★ 时间胶囊：天数只做三件事 —— 数量、高度、色相。三样都乘在**天色原有系数**上，
     所以天色仍然是主调，变老只是它的一个偏移。草色走 age.js 的"绿→黄→褐"路径，
     并且**保住原有的逐簇色相差异**（直接给一个统一色会让整片草变成一坨同色，
     那比不变老更难看）。 */
  const growth = growthFactors(days);
  const grassMix = autumnMix(days);
  const grassCols = veg.colors.map(h =>
    grassMix > 0 ? grassHueFor(h, days) : new THREE.Color(h));
  const grassColor = (col, r) => col.copy(grassCols[Math.floor(r() * grassCols.length)])
    .multiplyScalar(0.9 + r() * 0.2);

  // 矮草：铺底那一层。数量多、体量小，负责把地面的接缝和分区边界磨掉。
  // 实例缩放只在几何体体型上做 ±，范围收窄一点，免得同一片草高低差到失真
  build(makeTuftGeometry(TUFT_SHORT), filter(clustered(Math.round(520 * veg.count * growth.count))), {
    sMin: 0.78, sMax: 1.18, tilt: 0.32, colorOf: grassColor, vertexColors: true, grow: growth.scale
  });

  // 高草锚点：只在边缘与物件留白圈边缘，负责前后景层次
  const tallSpots = tallAnchors(Math.round(55 * veg.count * growth.count));
  build(makeTuftGeometry(TUFT_TALL), tallSpots, {
    sMin: 0.80, sMax: 1.25, tilt: 0.30, vertexColors: true, grow: growth.scale,
    colorOf: (col, r) => grassColor(col, r).multiplyScalar(0.94)
  });

  // 石子：压住画面，给出尺度感。小径上多留几个（踩出来的碎石子）
  const rockGeo = new THREE.DodecahedronGeometry(0.045 * MINI, 0);
  build(rockGeo, filter(uniform(80)), {
    sMin: 0.7, sMax: 1.9, tilt: 0.9, y: 0.02 * MINI, yawJitter: Math.PI,
    colorOf: (col, r) => col.copy(new THREE.Color(0x7d7a72).lerp(new THREE.Color(sky.ground), 0.5))
      .multiplyScalar(0.8 + r() * 0.5)
  });

  // 落叶：一点暖色，打破纯绿/纯灰。风把叶子吹到下风侧，所以下风处更密。
  // 秋天落叶会更多、也会更黄 —— 但 0 天必须**逐位等于原色**（base 原样保留，
  // 只按秋色权重向 hue 插值），否则新功能会顺手改掉线上已发出的观感。
  const lf = leafFactors(days);
  const leafBase = new THREE.Color(lf.base)
    .lerp(new THREE.Color(lf.hue), autumnMix(days))
    .lerp(new THREE.Color(sky.ground), 0.45);
  const leaves = filter(uniform(Math.round(140 * lf.count))).filter(s => {
    const drift = Math.cos(WIND + Math.atan2(s.z, s.x));   // 1 = 位于下风侧
    return rnd() < 0.45 + drift * 0.45;
  });
  build(makeLeafGeometry(), leaves, {
    sMin: 0.8, sMax: 1.7, tilt: 0.6, y: 0.01 * MINI, yawJitter: Math.PI,
    colorOf: (col, r) => col.copy(leafBase).multiplyScalar(0.8 + r() * 0.55)
  });

  // 供烘焙 AO 用：物件"挨着"草丛的地方也该暗一点。
  // 只把高草交出去 —— 矮草铺满全场，把它的位置当作遮蔽源等于给整个世界蒙一层灰。
  group.userData.tallSpots = tallSpots;

  return group;
}

/** 一片落叶：朝上的小四边形，微微翘边 */
function makeLeafGeometry() {
  const g = new THREE.BufferGeometry();
  const S = MINI;
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.018 * S, 0.004 * S, -0.026 * S, 0.018 * S, 0.004 * S, -0.026 * S, 0.023 * S, 0.016 * S, 0.026 * S,
    -0.018 * S, 0.004 * S, -0.026 * S, 0.023 * S, 0.016 * S, 0.026 * S, -0.023 * S, 0.016 * S, 0.026 * S
  ], 3));
  g.computeVertexNormals();
  return g;
}

/* ---------- 远山剪影 + 云层 ----------
   只有天空渐变时，世界像浮在一张无限雾平面上的圆盘。远处叠几层山影之后，
   它才像"大世界里的一角"。层数越多越远越淡，靠颜色而不是靠细节拉开空间。 */
export function createRidges(sky) {
  const g = new THREE.Group();
  g.name = 'ridges';
  const rnd = mulberry32(20261007);

  // 远山的距离与雾程配套：世界半径 6.5 米、雾远 21–30 米，
  // 山放在 43–62 米，被雾吃掉大半 —— 读起来是"远处还有地"，而不是"世界到此为止"。
  const layers = [
    { r: 62, h: 9.5, base: 0.86, seg: 44 },   // 最远、最高、最淡
    { r: 52, h: 7.0, base: 0.70, seg: 38 },
    { r: 43, h: 4.6, base: 0.52, seg: 32 }    // 最近、最矮、最深
  ];

  for (const L of layers) {
    // 山脊线：一圈顶点，高度按角度取几层正弦噪声，避免看起来像锯齿齿轮
    const n = L.seg;
    const top = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const h = L.h * (0.42
        + 0.30 * Math.sin(a * 3.0 + L.r)
        + 0.18 * Math.sin(a * 7.0 + L.r * 0.5)
        + 0.10 * rnd());
      top.push([Math.cos(a) * L.r, Math.max(0.4, h), Math.sin(a) * L.r]);
    }

    const pos = [];
    for (let i = 0; i < n; i++) {
      const p0 = top[i], p1 = top[(i + 1) % n];
      // 每段两个三角形，底边拉到地平面以下，保证从任何机位都看不到山脚断口
      pos.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p1[0], -3, p1[2]);
      pos.push(p0[0], p0[1], p0[2], p1[0], -3, p1[2], p0[0], -3, p0[2]);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();

    // 颜色往天空底部靠，再压暗一档：远山该是"比天空沉"的一层，
    // 太亮会变成沙丘，和地面对比也不够
    const col = fogColorOf(sky).lerp(new THREE.Color(sky.bottom), 0.45 + L.base * 0.2);
    col.multiplyScalar(0.34 + (1 - L.base) * 0.3);

    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: col, side: THREE.DoubleSide, fog: false, depthWrite: false
    }));
    mesh.renderOrder = -1;
    g.add(mesh);
  }
  return g;
}

/** 云层：地平线上方薄薄一层，缓慢漂移。
    注意：柔光斑做小了会像镜头污渍，所以宁可"少而大而淡"——它是雾气的层次，不是云朵形状。 */
export function createClouds(sky, tex) {
  const g = new THREE.Group();
  g.name = 'clouds';
  const rnd = mulberry32(20261008);
  const N = 7;
  for (let i = 0; i < N; i++) {
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, fog: false,
      color: new THREE.Color(sky.bottom).lerp(new THREE.Color(0xffffff), 0.5)
    });
    const s = new THREE.Sprite(mat);
    const a = (i / N) * Math.PI * 2 + rnd() * 0.5;
    const r = 44 + rnd() * 18;
    s.position.set(Math.cos(a) * r, 9 + rnd() * 7, Math.sin(a) * r);
    const sc = 42 + rnd() * 30;                      // 很大
    s.scale.set(sc, sc * (0.16 + rnd() * 0.1), 1);   // 很扁
    s.material.opacity = 0.04 + rnd() * 0.035;       // 很淡
    g.add(s);
  }
  g.userData.update = (dt) => {
    g.rotation.y += dt * 0.004;   // 极慢地转，云在动但看不出来
  };
  return g;
}

/* ---------- 飘浮粒子：夜里的萤火虫 / 光尘，白天的飘絮 ---------- */
export function createMotes(sky, tex) {
  // 由天色派生，不必给 8 套天色各写一个字段：
  // 夜里是萤火虫，雨雪雾天不要（会和天气打架），其余是日光里的飘絮
  const kind = sky.motes || (
    sky.sound === 'fog' ? 'none'
      : sky.weather ? 'none'
        : sky.sound === 'night' ? 'firefly'
          : 'pollen'
  );
  if (kind === 'none') return null;

  const firefly = kind === 'firefly';
  // 数量要克制：粒子一多就变成"下雪"，而这是氛围，不是天气
  const count = firefly ? 46 : 38;
  const pos = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  const rnd = mulberry32(firefly ? 991 : 992);

  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * (WORLD_RADIUS - 0.4);
    pos[i * 3] = Math.cos(a) * r;
    // 贴地飘：抬得太高就会跑到天空里，从任何角度看都像雪
    pos[i * 3 + 1] = (firefly ? 0.2 + rnd() * 0.7 : 0.15 + rnd() * 1.1) * MINI;
    pos[i * 3 + 2] = Math.sin(a) * r;
    phase[i] = rnd() * Math.PI * 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

  // 粒子尺寸按世界尺度缩，但**不缩到等比** —— 等比会小到看不见。
  // 光点/萤火虫这一类是"氛围记号"，尺寸跟着世界走一档、留一点冗余。
  const points = new THREE.Points(geo, new THREE.PointsMaterial({
    map: tex,
    color: firefly ? 0xffd27a : 0xfff3dc,
    size: (firefly ? 0.14 : 0.05) * MINI * 1.3,
    sizeAttenuation: true,
    transparent: true,
    opacity: firefly ? 0.85 : 0.32,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false
  }));
  points.userData.kind = kind;

  const base = Float32Array.from(pos);
  points.userData.update = (dt, t) => {
    const a = geo.attributes.position.array;
    for (let i = 0; i < count; i++) {
      const k = i * 3, ph = phase[i];
      a[k] = base[k] + Math.sin(t * (firefly ? 0.5 : 0.18) + ph) * (firefly ? 0.35 : 0.7);
      a[k + 1] = base[k + 1] + Math.sin(t * (firefly ? 0.9 : 0.25) + ph * 1.7) * (firefly ? 0.18 : 0.5);
      a[k + 2] = base[k + 2] + Math.cos(t * (firefly ? 0.42 : 0.15) + ph * 1.3) * (firefly ? 0.35 : 0.7);
    }
    geo.attributes.position.needsUpdate = true;
    // 萤火虫整体明灭；光尘几乎恒定
    if (firefly) points.material.opacity = 0.55 + 0.45 * Math.abs(Math.sin(t * 1.3));
  };
  return points;
}

/* ---------- 水洼：真实平面反射 ----------
   用 three 的 Reflector（镜像相机渲一次场景）覆盖整块地面，
   再用一张程序生成的遮罩把"水面"裁成不规则的水洼。
   这样**一次额外渲染**就能得到任意多个水洼 —— 如果每个水洼各建一个反射器，
   5 个水洼就是 5 次额外渲染，帧率会直接崩掉。

   ⚠️ 菲涅尔不是装饰，是**修一个视觉硬伤**：
   镜面在正入射下也全反射，所以从高处看水洼是一个**纯蓝色色斑**（实测 rgb(94,152,208)
   那种饱和度），像地上泼了墨水。而真实的水只在掠射角反光 ——
   俯视该看见水底（暗色的湿泥），平视才看见天光。
   加 pow(1-N·V, 5) 之后两边同时对：俯视几乎看不见水洼，走到跟前才亮起来。
   这同时也让"反射器"这个最贵的部件只在真正看得见的角度才花钱。 */
export function createPuddles(sky, reflectTex) {
  const SIZE = (WORLD_RADIUS + 0.6 * MINI) * 2;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE);
  const refl = new Reflector(geo, {
    textureWidth: 512,          // 反射贴图不必和屏幕同分辨率，512 足够
    textureHeight: 512,
    color: fogColorOf(sky)
  });
  refl.rotateX(-Math.PI / 2);
  // 略高于地面：地面中心 0–1.4 米是平的（见 groundHeight），
  // 但过渡带仍有最高 ~4 cm 的坡，抬到 4.5 cm 保证反射面不会从坡里穿出来
  refl.position.y = 0.045;

  // 注入遮罩：把整块反射面裁成水洼；并叠上菲涅尔
  const mat = refl.material;
  mat.transparent = true;
  mat.depthWrite = false;
  mat.vertexShader = mat.vertexShader
    .replace('varying vec4 vUv;',
      'varying vec4 vUv;\nvarying vec2 vLocal;\nvarying vec3 vViewDir;\nvarying vec3 vWorldNrm;')
    .replace('vUv = textureMatrix * vec4( position, 1.0 );',
      `vUv = textureMatrix * vec4( position, 1.0 );
	vLocal = position.xy;
	vec4 wp = modelMatrix * vec4( position, 1.0 );
	// 平面在旋转前是 XY 朝向 +Z，转到世界后法线就是模型的 Z 轴
	vWorldNrm = normalize( mat3( modelMatrix[0].xyz, modelMatrix[1].xyz, modelMatrix[2].xyz ) * vec3( 0.0, 0.0, 1.0 ) );
	vViewDir = cameraPosition - wp.xyz;`);
  mat.fragmentShader = mat.fragmentShader
    .replace('varying vec4 vUv;',
      'varying vec4 vUv;\nvarying vec2 vLocal;\nvarying vec3 vViewDir;\nvarying vec3 vWorldNrm;\nuniform sampler2D tMask;\nuniform float uSize;\nuniform float uFresnel;')
    .replace('gl_FragColor = vec4( blendOverlay( base.rgb, color ), 1.0 );',
      `float mask = texture2D( tMask, vLocal / uSize + 0.5 ).r;
       // 只在中心平地上积水：反射器是一整块**平面**（曲面做不了），
       // 而地面外围有 ±4 cm 起伏，落在坡上的水会从坡里穿出来、或者浮成一张薄片。
       // 遮罩的撒点半径已收到平地圈内（见 post.js 的 PUDDLE_FLAT_UV），
       // 这里只做一道柔边过渡，别再把中心的水也裁掉 ——
       // 早先 smoothstep(0.20,0.42) 与遮罩撒点范围不匹配，实测只剩 1.47% 水面。
       // ⚠️ 变量别叫 flat：GLSL ES 3.0 里 flat 是插值限定符（保留字），
       // three 会把它编译成 GLSL3，于是着色器直接编译失败、水洼整块变成死镜面。
       float gr = length( vLocal ) / uSize * 2.0;
       float flatMask = 1.0 - smoothstep( 0.60, 0.85, gr );
       mask *= flatMask;
       if ( mask < 0.004 ) discard;     // 不是水面就别浪费混合与采样
       // 掠射角才反光：正上方看到的是水底，不是天
       float ndv = clamp( abs( dot( normalize( vWorldNrm ), normalize( vViewDir ) ) ), 0.0, 1.0 );
       float f = pow( 1.0 - ndv, uFresnel );
       vec3 wet = blendOverlay( base.rgb, color );
       // 水底：一层压暗的湿泥；反光只占其中 f 那一份
       vec3 water = mix( wet * 0.55, wet, f );
       gl_FragColor = vec4( water, clamp( mask * ( 0.34 + 0.62 * f ), 0.0, 1.0 ) );`);
  mat.uniforms.tMask = { value: reflectTex };
  mat.uniforms.uSize = { value: SIZE };
  mat.uniforms.uFresnel = { value: 5.0 };
  mat.needsUpdate = true;
  refl.renderOrder = 1;
  return refl;
}

/* ---------- 星空（深夜 / 初雪用） ---------- */
export function createStars(seed = 1) {
  const count = 420;
  const pos = new Float32Array(count * 3);
  let rnd = seed * 9301 + 49297;
  const next = () => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };

  for (let i = 0; i < count; i++) {
    const theta = next() * Math.PI * 2;
    const phi = Math.acos(next() * 0.85);          // 只铺上半球
    const r = 34;
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.cos(phi) + 2;
    pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xdfe8ff, size: 0.22, sizeAttenuation: true, transparent: true, opacity: 0.85,
    depthWrite: false, fog: false   // 星星在雾外，必须显式关雾，否则会被雾吃掉
  }));
}

/* ---------- 天气：雨 / 雪 都是同一套粒子，只改速度和形态 ----------
   落速按世界尺度缩：世界小了 3.7 倍、眼高只有 0.42 米，
   雨要是还以 16 米/秒 落，一帧就穿场而过，看着像闪烁而不是下雨。

   ⚠️ `tex` 是必须的，不是可选装饰：PointsMaterial 不给贴图时画的是**方块**，
   而且 sizeAttenuation 下近处的方块有几厘米宽 —— 实测"落雨/初雪"两套天色里
   满屏白色小方块，一眼就是没做完。雨给细长条、雪给柔圆点。 */
export function createWeather(kind, tex) {
  const MINI_S = MINI;
  const conf = kind === 'rain'
    ? { count: 900, speed: 16 * MINI_S * 0.6, size: 0.05 * MINI_S * 1.2, color: 0x9fb6c4, opacity: 0.5, drift: 0.4 * MINI_S }
    : kind === 'snow'
      ? { count: 500, speed: 1.4 * MINI_S * 0.6, size: 0.11 * MINI_S * 1.2, color: 0xffffff, opacity: 0.75, drift: 1.1 * MINI_S }
      : null;
  if (!conf) return null;

  const SPAN = WORLD_RADIUS * 3;      // 粒子场的横向范围
  const TOP = EYE_HEIGHT * 6;         // 生成高度

  /* ⚠️ 天气必须**确定性**：同一条链接在任何机器、任何时刻看到的雨雪位置都要一样，
     而且拍摄模式承诺"同一 t 两次拍摄逐像素相同"。
     所以这里不用 Math.random()，也不把相位绑在墙上时钟（performance.now）上 ——
     早先两处都犯了，结果是雪花的横向漂移每次拍摄都不同、初雪/落雨这两套天色
     连"同一条链接看起来一样"都不成立。 */
  const WSEED = kind === 'rain' ? 9001 : 9002;
  const rnd = mulberry32(WSEED);
  const pos = new Float32Array(conf.count * 3);
  for (let i = 0; i < conf.count; i++) {
    pos[i * 3] = (rnd() - 0.5) * SPAN;
    pos[i * 3 + 1] = rnd() * TOP;
    pos[i * 3 + 2] = (rnd() - 0.5) * SPAN;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({
    map: tex || null,
    color: conf.color, size: conf.size, transparent: true, opacity: conf.opacity,
    depthWrite: false, fog: false   // 雨雪就在眼前，别被雾冲淡
  }));

  // 自走的确定性时钟：只由 dt 累加，不看墙上时间
  let clock = 0;
  points.userData.update = (dt) => {
    clock += dt;
    const a = geo.attributes.position.array;
    for (let i = 0; i < conf.count; i++) {
      a[i * 3 + 1] -= conf.speed * dt;
      a[i * 3] += Math.sin(clock * 0.4 + i) * conf.drift * dt;
      if (a[i * 3 + 1] < 0) {
        // 重生位置也用确定性序列（用 i 与轮次推，而不是 Math.random）
        a[i * 3 + 1] = TOP;
        a[i * 3] = (((i * 2654435761) >>> 0) % 1000 / 1000 - 0.5) * SPAN;
        a[i * 3 + 2] = (((i * 40503) >>> 0) % 1000 / 1000 - 0.5) * SPAN;
      }
    }
    geo.attributes.position.needsUpdate = true;
  };
  return points;
}

/* ---------- 中心：那句话的容器 ---------- */
export function createCore(sky) {
  const g = new THREE.Group();
  // 刻意做小：它是"话在这里"的一个记号，不是主角。
  // 早先做成 0.34m 的球，走近到 2 米时糊满整个画面，把世界挡得严严实实。
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.13 * MINI, 1),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: sky.sun, emissiveIntensity: 1.2, roughness: 0.4 })
  );
  core.position.y = 1.15 * MINI;
  g.add(core);

  // 地面上的一圈微光：告诉人"该走到这里"。压得很淡——它是指示，不是主角，
  // 太亮会盖过物件，画面就变成"一个圈加几件杂物"。
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.5 * MINI, 0.58 * MINI, 64),
    new THREE.MeshBasicMaterial({ color: sky.sun, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.02 * MINI;
  g.add(halo);

  g.userData.update = (dt, t) => {
    core.position.y = 1.15 * MINI + Math.sin(t * 1.1) * 0.05 * MINI;
    core.rotation.y += dt * 0.5;
    halo.material.opacity = 0.12 + Math.sin(t * 2.0) * 0.05;
  };
  return g;
}

/* ---------- 物件的占位几何体 ---------- */
function placeholder(geo, color, emissive) {
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: 0.75, metalness: 0.05,
    emissive: new THREE.Color(emissive || 0x000000), emissiveIntensity: emissive ? 0.9 : 0
  });
  const g = new THREE.Group();

  switch (geo) {
    case 'lamp': {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.7, 12), mat);
      pole.position.y = 0.85; g.add(pole);
      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.3, 20, 1, true), mat);
      shade.position.y = 1.78; g.add(shade);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 12),
        new THREE.MeshStandardMaterial({ color: 0xfff3d0, emissive: 0xffc266, emissiveIntensity: 2.2 }));
      bulb.position.y = 1.66; g.add(bulb);
      break;
    }
    case 'letter': {
      const sheet = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.02, 0.24), mat);
      sheet.position.y = 0.16; sheet.rotation.y = 0.3; g.add(sheet);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.2), mat);
      box.position.y = 0.11; g.add(box);
      break;
    }
    case 'chair': {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.42), mat);
      seat.position.y = 0.45; g.add(seat);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.05), mat);
      back.position.set(0, 0.7, -0.18); g.add(back);
      for (const [dx, dz] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.45, 8), mat);
        leg.position.set(dx, 0.22, dz); g.add(leg);
      }
      break;
    }
    case 'tree': {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, 1.1, 10), mat);
      trunk.position.y = 0.55; trunk.rotation.z = 0.16; g.add(trunk);
      const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 1),
        new THREE.MeshStandardMaterial({ color, roughness: 0.9, flatShading: true }));
      crown.position.set(0.16, 1.5, 0); g.add(crown);
      break;
    }
    case 'clock': {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.12, 28), mat);
      body.rotation.x = Math.PI / 2; body.position.y = 0.5; g.add(body);
      const face = new THREE.Mesh(new THREE.CircleGeometry(0.24, 28),
        new THREE.MeshStandardMaterial({ color: 0xf6f1e6, roughness: 0.6 }));
      face.position.set(0, 0.5, 0.065); g.add(face);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 0.4, 12), mat);
      base.position.y = 0.2; g.add(base);
      break;
    }
    case 'bike': {
      for (const dx of [-0.42, 0.42]) {
        const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.035, 8, 24), mat);
        wheel.position.set(dx, 0.28, 0); g.add(wheel);
      }
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.9, 8), mat);
      bar.rotation.z = Math.PI / 2; bar.position.y = 0.52; g.add(bar);
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.08), mat);
      seat.position.set(-0.28, 0.66, 0); g.add(seat);
      break;
    }
    case 'rock': {
      const r = new THREE.Mesh(new THREE.DodecahedronGeometry(0.34, 0),
        new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true }));
      r.position.y = 0.22; r.scale.set(1, 0.72, 0.9); r.rotation.set(0.3, 0.7, 0.15); g.add(r);
      break;
    }
    case 'boat': {
      const hull = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.34, 4), mat);
      hull.rotation.set(Math.PI / 2, 0, Math.PI / 4); hull.position.y = 0.12; g.add(hull);
      const sail = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.3),
        new THREE.MeshStandardMaterial({ color, roughness: 0.8, side: THREE.DoubleSide }));
      sail.position.set(0, 0.32, 0); g.add(sail);
      break;
    }
    case 'glow': {
      // 发光物占位：一个会亮的小球 + 一点底座
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 14),
        new THREE.MeshStandardMaterial({
          color: 0xfff4d8,
          emissive: new THREE.Color(emissive || 0xffb040),
          emissiveIntensity: 2.6
        }));
      bulb.position.y = 0.2; g.add(bulb);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.14, 12), mat);
      base.position.y = 0.07; g.add(base);
      break;
    }
    case 'tuft': {
      // 草/花占位：几片叶子
      const leaves = 7;
      for (let i = 0; i < leaves; i++) {
        const a = (i / leaves) * Math.PI * 2;
        const blade = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.32, 4), mat);
        blade.position.set(Math.cos(a) * 0.05, 0.16, Math.sin(a) * 0.05);
        blade.rotation.set(Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35);
        g.add(blade);
      }
      break;
    }
    default: {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), mat);
      m.position.y = 0.15; g.add(m);
    }
  }
  return g;
}

/* ---------- 顶点色烘焙 AO（接触阴影）----------
   低多边形最露怯的地方不是面数少，是**物件底下没有变暗**——没有接触阴影，
   东西看着就是"飘"在地面上的，怎么调光都救不回来。
   真实阴影贴图能解决一部分，但低多边形的阴影边缘是硬的、还会出 shadow acne，
   而在手机上多一张 shadow map 就是实打实的开销。

   这里改烘焙：在顶点色里乘一层遮蔽系数，**零运行时开销、手机完全友好**。
   遮蔽来自两处：
     1. 自身的接触遮蔽 —— 顶点越低越暗（the classics），法线朝下再多压一档
     2. 邻近物体的遮蔽 —— 离别的物件/草丛越近越暗，物件之间因此"挨在一起"
   注意 `vertexColors` 是**乘法**：三件本身带贴图的 GLB 会被乘上一层接触阴影，
   贴图色相不变，只是暗部更沉 —— 这正是要的效果。

   除了遮蔽，这里还顺手把**天色染色**烘进同一层顶点色。
   为什么需要：八套天色只改灯和雾，物件本身恒温恒色 ——
   实测星夜里那株树的叶子依然是白天的鲜绿，初雪里像被太阳照着，
   物件于是"贴"在环境上而不是"在"环境里。全局 LUT 是另一个办法（要贴图、要一个全屏 pass），
   而这里已经有一遍逐顶点的循环，顺路乘一个由天色派生的小色偏，成本是零。
   色偏**夹在窄带里**（0.82–1.06）：这不是调色，是让物件跟着天色一起呼吸，
   压过头就变成给贴图加了一层颜色滤镜，比不做更假。 */
function skyTintOf(sky) {
  const c = new THREE.Color(sky.ground);
  const ref = 0.45;
  const t = [c.r, c.g, c.b].map(v => Math.min(1.06, Math.max(0.82, Math.sqrt((v || 0.02) / ref))));
  return { r: t[0], g: t[1], b: t[2] };
}

function bakeVertexAO(root, neighbours, tint) {
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return;
  const h = Math.max(0.02, box.max.y - box.min.y);
  const p = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const n = new THREE.Vector3();
  const T = tint || { r: 1, g: 1, b: 1 };

  root.updateWorldMatrix(true, true);
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const geo = o.geometry;
    const pos = geo.attributes.position;
    if (!pos) return;
    const nor = geo.attributes.normal;

    // 从世界空间转回本地：GLB 的节点上常带缩放，直接拿本地坐标算高度会算错
    const inv = new THREE.Matrix4().copy(o.matrixWorld).invert();
    const nm = new THREE.Matrix3().getNormalMatrix(inv);   // 法线的逆转置

    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);

      // 1) 自身：越接近底面越暗；法线朝下额外压一档
      let ao = 0.62 + 0.38 * Math.min(1, Math.max(0, (p.y - box.min.y) / (h * 0.32)));
      if (nor) {
        n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
        ao *= 1 - 0.16 * Math.max(0, -n.y);
      }

      // 2) 邻近的物件与草丛：它们脚下的地面本来就暗，贴着它们的一侧也该暗。
      // 先比**平方**距离，命中才算 sqrt —— 这段是 9 件 × ~7500 顶点 × 63 个邻居
      // ≈ 425 万次循环，直接 Math.hypot 实测 261 ms/次重建，改成这样就 21 ms。
      for (let k = 0; k < neighbours.length; k++) {
        const nb = neighbours[k];
        const dx = p.x - nb.x, dz = p.z - nb.z;
        const reach = nb.r * 2.2;
        const d2 = dx * dx + dz * dz;
        if (d2 < reach * reach) ao *= 0.70 + 0.30 * Math.min(1, Math.sqrt(d2) / reach);
      }

      ao = Math.min(1.25, Math.max(0.30, ao));
      col[i * 3] = ao * T.r;
      col[i * 3 + 1] = ao * T.g;
      col[i * 3 + 2] = ao * T.b;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (m) m.vertexColors = true;
    }
  });
}

/* ---------- 造一个物件：优先 GLB，没有就用占位 ---------- */
let GLTFLoaderCtor = null;

export async function createObject(def, x, z, neighbours = [], sky = null, days = 0) {
  const group = new THREE.Group();
  group.position.set(fromStored(x), 0, fromStored(z));
  group.userData.objectId = def.id;

  const loaded = await tryLoadGLB(def.id);
  if (loaded) {
    group.add(loaded);
    group.userData.source = 'tripo';
  } else {
    group.add(placeholder(def.geo, def.color, def.emissive));
    group.userData.source = 'placeholder';
  }

  // 按包围盒归一到目标尺寸：Tripo 的 auto_size 会猜错比例（实测"信"被判成 1.42 米），
  // 这里统一校正，让任何模型进来都自动落到合适的体量。
  // 同时把底面对齐到 y=0——不同导出器的原点位置并不一致。
  //
  // `def.slim` 是**形态修正**，不是尺寸修正：Tripo 的模型常被归一化成
  // "宽高比接近 1"，于是一棵 4.5 米的树展开成 3.3 米宽的矮胖灌木（实测该模型
  // 满高度的水平半径 0.37，而高度跨度只有 1.0 —— 冠/干半径比 1.04，等于一根柱子顶着冠）。
  // 按 (slim, 1, slim) 压扁水平方向之后，竖向关系才对：树干细、树冠高、要抬头看。
  if (def.slim && def.slim !== 1) group.scale.set(def.slim, 1, def.slim);

  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 1e-6 && def.size) {
    const k = def.size / maxDim;
    group.scale.multiplyScalar(k);
    // 缩放后重新量一次，把最低点抬到地面。
    // ⚠️ 这一步之后 group.position.y ≠ 0（等于模型原点到最低点的距离，灯是 1.75 米、
    // 树是 2.25 米）—— 因为 Tripo 导出的 GLB 原点在几何中心。
    // 任何"把物件挪到别处"的代码都必须沿用这个 y，写 0 就会让物件沉进地里一半。
    // 下面把它存进 userData.baseY 供摆放交互使用。
    const box2 = new THREE.Box3().setFromObject(group);
    group.position.y -= box2.min.y;
    group.userData.fitted = +maxDim.toFixed(3);
    group.userData.scale = +k.toFixed(4);
  }
  group.userData.baseY = group.position.y;

  // 占位体和真模型都要投影：没有影子，物件会像浮在盘子上。
  // 顺便统一成哑光：低多边形一旦出现塑料高光，立刻"像 demo"而不是"像作品"。
  group.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || m.metalness === undefined) continue;
      m.metalness = 0;
      m.roughness = Math.max(0.78, m.roughness ?? 0.8);
      m.envMapIntensity = 0;
    }
  });

  // 发光物真的照亮周围 —— 只是"自己亮"在夜里等于没有光。
  // 点光源很贵，所以只在 glow 物件上挂一盏，靠距离衰减控制范围。
  if (def.glow) {
    const light = new THREE.PointLight(def.emissive || 0xffb040, def.glow, 4.5 * MINI, 2);
    light.position.set(0, def.size * 0.55, 0);
    light.userData.base = def.glow;         // 摇曳时以它为基准
    group.add(light);
    group.userData.light = light;
  }

  // 时间胶囊：木头变沉、纸泛黄。放在这里而不是调用方，
  // 是因为**任何**造物件的路径（首次搭建、用户后放的、重建）都得走这一处，
  // 漏掉一条就会出现"同一件东西老得不一样"。0 天时它什么都不做。
  applyObjectAging(group, def.id, days);

  // 摆位的随机朝向要在烘焙 AO **之前**定下来：烘焙是按世界坐标算邻近遮蔽的，
  // 转完再烘，物件相对草丛的位置才对得上。
  group.rotation.y = ((def.id * 37) % 360) * Math.PI / 180;

  // 落到高度场上。**必须在烘焙 AO 之前**：AO 是按世界坐标算"离地多低"的，
  // 先把 y 抬到坡面，烘出来的接触阴影才贴着真正的地面。
  // 放在归一化与抬底之后，免得被那句 `position.y -= box2.min.y` 覆盖掉。
  const gy = groundHeight(group.position.x, group.position.z);
  group.position.y += gy;
  group.userData.groundY = +gy.toFixed(4);

  // 顶点色烘焙 AO + 天色染色：低多边形没有接触阴影就会"飘"。
  // 零运行时开销，手机友好。
  bakeVertexAO(group, neighbours, sky ? skyTintOf(sky) : null);

  return group;
}

/** 把一件物件摆到世界坐标 (x,z) 的地面上。
 *  ⚠️ 必须走这个函数，不要在别处写 `g.position.set(x, 0, z)`：
 *  物件的 group.position.y 承载着"模型原点到最低点"的距离（灯 1.75 米、树 2.25 米），
 *  写 0 会让它沉进地里一半。地形起伏也要一起算上。 */
export function placeOnGround(group, x, z) {
  const base = group.userData.baseY ?? 0;
  group.position.set(x, base + groundHeight(x, z), z);
  return group.position.y;
}

/** 在某个物件身上找发光的网格，返回它们的材质列表。
 *  回信动画里"让蜡烛暗下去"要改的是**发光材质**（emissiveIntensity），
 *  而不是那盏点光源 —— 光没了但灯芯还亮着会很怪。 */
export function findEmissiveMaterials(group) {
  const out = [];
  group.traverse(o => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (m && m.emissive && m.emissiveIntensity > 0.01) out.push(m);
    }
  });
  return out;
}

/** 一件物件在世界里的"视觉高度"（用来决定回信动画抬多高） */
export function visualHeightOf(group) {
  const box = new THREE.Box3().setFromObject(group);
  return box.isEmpty() ? 0.3 : Math.max(0.05, box.max.y - box.min.y);
}

async function tryLoadGLB(id) {
  try {
    if (!GLTFLoaderCtor) {
      const mod = await import('three/addons/loaders/GLTFLoader.js');
      GLTFLoaderCtor = mod.GLTFLoader;
    }
    const loader = new GLTFLoaderCtor();
    const gltf = await loader.loadAsync(`./assets/models/${id}.glb`);
    return gltf.scene;
  } catch {
    return null; // 资产还没产出：静默回退到占位体，不阻塞任何流程
  }
}
