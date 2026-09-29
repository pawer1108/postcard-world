/* 世界随天数改变外观 —— 把 src/state.js 算出的**纯数学**落到具体材质上。
   为什么单独一个文件：state.js 是纯逻辑、要在 Node 里单测（不能拖进 three），
   而这里每个函数都要 THREE.Color。两边分开，天数算法才测得到。

   这个模块只做一件事：**给定天数，返回/施加一组确定的颜色与系数**。
   它不认识"现在几点"，也不知道打开链接的是谁 —— 天数从外面传进来。
   因此同一个链接、同一个时刻，渲染结果永远一致（截图可复现，可拍摄）。
*/
import * as THREE from 'three';
import { autumnMix, agingOfObject, growthFactors, mixNum } from './state.js';

/* ---------- 秋色 ----------
   草不是"变黄"，是**绿退、黄褐进**：直接用明黄色会让地面整体变亮，
   而"老"在观感上应该是变暗、变沉。所以秋色的相对明度被压到绿草之下（实测见
   tools/probe-capsule.mjs 的明度表）。

   v0.1 是青绿，v0.4 是那抹点睛的枯黄，v1 是接近土的褐。三档而不是两档，
   是因为一档插值会让所有草同时变黄 —— 看起来像换了张贴图，而不是老了。 */
const GRASS_V0 = 0x4e6134;   // 刚种下：偏青的绿
const GRASS_V04 = 0x7a6c34;   // 起秋：显黄，但还带绿意
const GRASS_V1 = 0x5d4a30;   // 老：接近土的褐（比绿草更暗、更沉）

/** 给量测工具用：这条秋色路径本身（tools/probe-capsule.mjs 会逐档量它的线性明度） */
export const AUTUMN_RAMP = [GRASS_V0, GRASS_V04, GRASS_V1];

const _v0 = new THREE.Color();
const _v04 = new THREE.Color();
const _v1 = new THREE.Color();

/** 绿 → 黄 → 褐 的三段插值。t = 0 绿，t = 0.4 最黄，t = 1 褐。
 *  为什么用三段而不是两段：两段插值会让"绿→褐"中途经过一个脏灰，
 *  而秋季真正的样子是先亮一档黄、再暗下去。
 *
 *  ⚠️ 只读模块级的三个色标，**绝不在它们身上做变换**：
 *  写成 `c.copy(_v0).lerp(_v04, …)` 的话，`lerp` 会原地改写 `_v0`，
 *  于是下一次调用的起点是被上次改过的颜色 —— 这种别名 bug 不会报错，
 *  只会让曲线悄悄走样（"参数对、画面对不上"最难查的一类）。 */
export function autumnPath(c, t) {
  const m = clamp01(t);
  if (m <= 0.4) return c.copy(_v0.setHex(GRASS_V0)).lerp(_v04.setHex(GRASS_V04), m / 0.4);
  return c.copy(_v04.setHex(GRASS_V04)).lerp(_v1.setHex(GRASS_V1), (m - 0.4) / 0.6);
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/* ---------- 草 ---------- */

/** 某一簇草要用的色相：在"绿→黄→褐"路径上取一个点，再**做明度归一**。
 *  归一的基准是**固定的原绿 L0**（不是"这一档的秋色"）：
 *  否则秋黄阶段本身比绿亮，归一乘一个 <1 的系数会把它又压回原来的明度 ——
 *  正好把"变黄"这件事抵消掉（实测过：色板从 #6b7f46 变到 #737d43，
 *  画面上却量不出黄度差）。
 *  对固定基准归一之后，色相自由变、整体亮度与原绿一致：
 *  曝光标定（post.js 那套）不会因为"世界变老了"而整体漂移。 */
let _baseL = null;          // 缓存基准明度（只依赖入参色相，与天数无关）
let _baseHue = null;
export function grassHueFor(hue, days) {
  const m = autumnMix(days);
  if (m <= 0) return new THREE.Color(hue);
  if (_baseHue !== hue || _baseL === null) {
    _baseHue = hue;
    _baseL = luminance(new THREE.Color(hue));
  }
  const aged = autumnPath(new THREE.Color(), m);
  return aged.multiplyScalar(_baseL / Math.max(1e-6, luminance(aged)));
}

/** 线性空间相对明度（Rec.709 权重）。判断"变亮还是变暗"必须用这个，
 *  不能看 sRGB 的观感 —— 这是交接文档里踩过的坑（线性/编码混用会得出相反结论）。 */
export const luminance = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** 把天数变成"这个世界今天长什么样"的一组参数。
 *  growth 乘在**原有的天色系数**上（见 world.js 的 VEG），所以天色仍是主调。 */
export function agingFor(days) {
  const g = growthFactors(days);
  return {
    days,
    grassMix: autumnMix(days),
    count: g.count,
    scale: g.scale,
    objectMix: agingOfObject(days)
  };
}

/** 落叶随秋天变多、变黄。
 *  ⚠️ `base` 必须原样保留：0 天时颜色要**逐位等于改动前**的 0xa8763f。
 *  第一版这里直接把 hue 设成秋色，于是连 0 天的落叶都被换了颜色 ——
 *  那是"新功能顺手改掉旧观感"，线上已经发出去的链接会跟着变（实测抓到过）。 */
export const LEAF_BASE = 0xa8763f;
export const leafFactors = (days) => ({
  count: mixNum(1, 1.45, autumnMix(days)),
  base: LEAF_BASE,
  hue: GRASS_V04
});

/** 地面裸土随天数略微变暖（很轻的一档：地面是画面的底，动多了会脏） */
export const groundWarmth = (days) => 0.06 * agingOfObject(days);

/* ---------- 物件：木桩 / 纸 ----------
   物件不会长高，但"时间"在这两样东西上最容易读出来：
   木头的颜色会沉下去、纸会泛黄。所以给它们一条比草更慢的轴（90 天）。
   实现在这里而不是改 GLB：资产是 Tripo 出的真模型，**不该为了一个参数重新生成**，
   而材质色是 three 里的乘法通道（baseColorFactor），改它不动任何文件。 */

/** 木头（木桩、椅子、栅栏）随天数变沉：往深褐偏，并压暗一点 */
export function woodTint(days, out = new THREE.Color(1, 1, 1)) {
  const t = agingOfObject(days);
  return out.setRGB(1, 1, 1).lerp(_woodMul.setRGB(0.78, 0.66, 0.52), t * 0.8);
}
const _woodMul = new THREE.Color();

/** 纸（那封信、纸船）随天数泛黄。**不能压太暗**：纸上还有字要读 */
export function paperTint(days, out = new THREE.Color(1, 1, 1)) {
  const t = agingOfObject(days);
  return out.setRGB(1, 1, 1).lerp(_paperMul.setRGB(0.94, 0.86, 0.68), t * 0.85);
}
const _paperMul = new THREE.Color();

/** 哪些物件吃木色、哪些吃纸色（按 objectId）—— 表只有这一份，别处不要再判 id */
export const WOOD_IDS = [2, 4, 13, 16];   // 空椅子 / 旧钟 / 木桩 / 栅栏
export const PAPER_IDS = [1, 7];          // 一封没寄的信 / 纸船

/** 把色偏乘进一棵物件子树里所有材质的 color。
 *  用乘法而不是赋值：材质自带的基础色是它的"本色"，乘一个接近 1 的系数
 *  只是给它加一层时间，不会把模型本来的颜色抹掉。
 *  **只对没有 map 的通道也会生效**——three 最终颜色 = color × map，两者相乘。 */
export function tintSubtree(root, mul) {
  if (!root || (mul.r === 1 && mul.g === 1 && mul.b === 1)) return 0;
  let n = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || !m.color) continue;
      if (m.userData._agedBase === undefined) {
        m.userData._agedBase = m.color.clone();   // 记下本色，重复调用不会越乘越深
      }
      m.color.copy(m.userData._agedBase).multiply(mul);
      n++;
    }
  });
  return n;
}

/** 一键把"天数"应用到整个已建好的世界（草用参数、物件用色偏） */
export function applyObjectAging(group, objectId, days) {
  if (days < 1) return 0;
  if (WOOD_IDS.includes(objectId)) return tintSubtree(group, woodTint(days));
  if (PAPER_IDS.includes(objectId)) return tintSubtree(group, paperTint(days));
  return 0;
}
