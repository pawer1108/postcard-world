/* 后期处理：辉光（bloom）+ 输出转换（OutputPass）。

   ⚠️ OutputPass 不是可选项，是**修 bug**：
   three 只在渲染到画布时应用色调映射（源码里判断 `currentRenderTarget === null`）。
   用了 EffectComposer 之后整个场景渲进 RenderTarget，于是——
     · 色调映射根本没生效
     · 最后那个 CopyShader 也不做 sRGB 转换
   结果就是画面发灰发平，怎么调灯都像蒙了一层。OutputPass 补上这两件事。

   辉光门槛看 threshold 而不是 strength：阈值低一点草地就一起发光，整片糊掉。
*/
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/* ---------- 统一调色（全片一层）----------
   为什么需要它：8 套天色各自有一组数值（天顶/地平线/雾/主光/环境光/地面），
   逐条看都对，合起来却**没有统一意图** —— 对比度偏低、暗部发灰，
   读起来是"参数凑得不难看"，而不是"有人决定过它该长什么样"。
   一层贯穿全片的调色就是那个"决定"。

   放在 OutputPass **之后**：OutputPass 做完色调映射与 sRGB 转换，
   之后的像素就是观者真正看到的显示空间颜色，在这里调与在 Photoshop 里拉曲线是一回事。

   ⚠️ 这个 pass 的第一版有两个**实测测出来的**错误，都跟"想当然"有关：
   1. **对比度以 0.5 为轴**是照片调色的惯例，但本作的画面整体在 0.06–0.20 之间
      （黄昏天色下的地面就在那儿）。轴远高于画面，任何 contrast>1 都等于**压暗**：
      实测 contrast 1.20 把地面从 L15 压到 L8。所以轴必须跟着画面走 ——
      用 uPivot，默认 0.18（实测出的画面中位亮度），而不是 0.5。
   2. **gamma 的方向反了**。着色器里写的是 pow(c, 1/uGamma)，所以 uGamma<1 是**压暗**。
      我把它当成了"提亮"来填。现在统一改成 pow(c, 1/uGamma) 且注释写明方向。
*/
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uLift: { value: 0 },
    uGamma: { value: 1 },
    uGain: { value: 1 },
    uContrast: { value: 1 },
    uSat: { value: 1 },
    uPivot: { value: 0.18 },
    uTint: { value: new THREE.Vector3(0, 0, 0) }
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uLift, uGamma, uGain, uContrast, uSat, uPivot;
    uniform vec3 uTint;
    varying vec2 vUv;
    void main() {
      vec4 tex = texture2D( tDiffuse, vUv );
      vec3 c = tex.rgb;

      // 对比：绕 uPivot 拉伸（不是 0.5 —— 见上面的说明）
      c = ( c - uPivot ) * uContrast + uPivot;
      // 曝光 / 增益
      c *= uGain;
      // 暗部抬升 + 阴影染色
      // ⚠️ 只在**很暗**的地方生效（阈值 0.25，不是 0.55）。
      // 实测：阈值 0.55 时，像"雨后"这种地平线本来就亮的天空（L92 ≈ 0.36）
      // 仍然吃到阴影染色与 lift，叠加增益之后整片天空被推到 #ffffff ——
      // 实测天空明度只剩 10 个台阶，渐变全糊掉。阴影处理就该只管阴影。
      float luma0 = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
      float shadowWeight = 1.0 - smoothstep( 0.0, 0.25, luma0 );
      c += uLift * (0.35 + 0.65 * shadowWeight) + uTint * shadowWeight;
      // 中间调：uGamma < 1 压暗、> 1 提亮（pow 指数是 1/uGamma）
      c = pow( max( c, vec3( 0.0 ) ), vec3( 1.0 / uGamma ) );
      // 饱和度
      float luma = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
      c = mix( vec3( luma ), c, uSat );

      /* 高光收肩，而不是硬 clamp。
         硬 clamp 会把所有 ≥1 的像素压成同一个白 —— 实测"雨后"那张图的天空
         整片 #ffffff、只剩 2 个明度台阶，渐变彻底消失。
         而渐变恰恰是"傍晚的天在发光"这个观感的全部来源。
         收肩是条 C1 连续的曲线（在 0.85 处与原斜率相接），
         把 [0.85, ∞) 映射进 [0.85, 1)，于是再亮也保留层次。 */
      const float KNEE = 0.85;
      c = max( c, vec3( 0.0 ) );
      vec3 over = max( c - KNEE, vec3( 0.0 ) );
      c = min( c, vec3( KNEE ) ) + over / ( 1.0 + over );

      gl_FragColor = vec4( c, tex.a );
    }`
};

/** 三个视觉方向。都是以"收到链接的人"为受众做的取舍：
 *  他只会打开一次、多半在手机上、二十秒内要觉得"这是个东西"。
 *  ⚠️ 所有数值都是**实测标定过的**，改动前先跑 tools/probe-grade.mjs 看效果，
 *  别凭"应该会变亮"去填 —— 上面那两条错误就是这么来的。 */
export const GRADES = {
  // 现在的样子（不做任何事）
  plain: {},

  // A·模型感 —— **已选定为默认**（DEFAULT_GRADE）。
  // 出发点：黄昏天色下天空是暖红、地面却偏绿，两个色系各说各话 ——
  // 这是"不像成品"里最容易被感觉到、却最难说清的一条。
  // 所以把阴影染成暖金把两边拉到一起，但**不收掉绿色**（sat 保持 >1）：
  // 草是这个世界唯一"活着"的东西，收掉它画面就死了。
  // 力度（对比 1.48 / 增益）负责"有力"，色相（暖金 tint）负责"统一"。
  model: {
    uPivot: 0.18, uContrast: 1.48, uLift: 0.014, uGain: 1.16, uGamma: 1.08, uSat: 1.12,
    uTint: new THREE.Vector3(0.026, 0.011, -0.006)   // 暖金阴影（折中：既统一又不杀绿）
  },

  // B·黄昏电影：中间调压暗、整体偏暖红、对比更硬。
  // 情绪最强，但会把"可读性"让给氛围 —— 与"哪套天色"耦合最紧。
  film: {
    uPivot: 0.18, uContrast: 1.45, uLift: 0.018, uGain: 1.12, uGamma: 0.96, uSat: 1.04,
    uTint: new THREE.Vector3(0.030, 0.010, -0.004)  // 阴影偏暖
  },

  // C·明信片：亮部抬起、整体更亮更干净、对比适中。
  // 手机小屏上最清楚，最接近"一张可以寄出去的卡片"。
  postcard: {
    uPivot: 0.18, uContrast: 1.26, uLift: 0.026, uGain: 1.24, uGamma: 1.14, uSat: 1.08,
    uTint: new THREE.Vector3(0.008, 0.010, 0.020)
  },

  // D·暖金：把画面统一到落日那一档色调上。
  // 出发点：黄昏天色下天空是暖红、地面却偏绿，两个色系各说各话 ——
  // 这是"不像成品"里最容易被感觉到、却最难说清的一条。
  // 统一到暖金之后画面立刻"有主意"了，代价是牺牲草地的绿。
  warm: {
    uPivot: 0.18, uContrast: 1.46, uLift: 0.020, uGain: 1.10, uGamma: 1.10, uSat: 0.96,
    uTint: new THREE.Vector3(0.030, 0.012, -0.010)
  }
};

/** 全片默认的调色方向。选定之后**它就是作品的一部分**，不是可选项 ——
 *  留一个未定的默认值，等于交付一件"还没决定长什么样"的东西。 */
export const DEFAULT_GRADE = 'model';

export function createPost(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());

  // 电影级色调映射：高光滚降而不是硬切
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const composer = new EffectComposer(renderer);
  // 后期在 1 倍像素比下算：在 2 倍屏上按原生分辨率做 bloom 纯属浪费
  composer.setPixelRatio(1);

  composer.addPass(new RenderPass(scene, camera));

  // strength, radius, threshold
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.42, 0.62, 0.86);
  composer.addPass(bloom);

  // 必须紧跟场景：色调映射 + sRGB 转换都在这一步
  composer.addPass(new OutputPass());

  // 调色放在最后（显示空间）
  const grade = new ShaderPass(GradeShader);
  grade.renderToScreen = true;
  composer.addPass(grade);

  return {
    composer,
    bloom,
    grade,
    /** 换调色方向。传 'plain' 就是不做任何调色。
     *  `brightness` 是当前天色的亮度（0 = 最暗、1 = 正午）。
     *  为什么要它：一个固定的 gain 不可能同时服务星夜和正午 ——
     *  画面明度跨度从 5 到 53（十倍以上），给夜色提亮的增益加到正午头上就是过曝。
     *  实测：model 的 gain 1.16 让正午与雨后的天空顶到 99–100（满值 255 里的 99 已经贴顶）。
     *  所以增益随天色退火：暗天色给满，亮天色几乎不给。 */
    setGrade(name, brightness = 0) {
      const g = GRADES[name] || {};
      for (const k of ['uLift', 'uGamma', 'uGain', 'uContrast', 'uSat', 'uPivot']) {
        grade.uniforms[k].value = g[k] ?? GradeShader.uniforms[k].value;
      }
      // 增益与对比随天色退火（暗天色 1.0，亮天色收到 0.15）
      const t = Math.min(1, Math.max(0, brightness));
      const ease = t * t * (3 - 2 * t);                 // smoothstep
      const gainK = 1 - 0.85 * ease;
      grade.uniforms.uGain.value = 1 + (grade.uniforms.uGain.value - 1) * gainK;
      grade.uniforms.uContrast.value = 1 + (grade.uniforms.uContrast.value - 1) * (1 - 0.45 * ease);
      // 亮天色下也别再加 lift，否则黑位被抬起来发灰
      grade.uniforms.uLift.value *= (1 - 0.8 * ease);
      grade.uniforms.uTint.value.copy(g.uTint || new THREE.Vector3(0, 0, 0));
      this._gradeName = name in GRADES ? name : 'plain';
      this._gradeBrightness = t;
      return this._gradeName;
    },

    /** 天色变了：重算曝光与调色退火。天色是用户可选的，两者都必须跟着走。 */
    setSkyGrade(sky) {
      const amb = sky.ambI ?? 0.5;
      // 0 = 最暗（星夜 0.26）、1 = 最亮（正午 0.90）
      this.setGrade(this._gradeName || 'plain', Math.min(1, Math.max(0, (amb - 0.26) / 0.64)));
    },
    /** 字面量：别在别处再写一遍 1.15 */
    BASE_EXPOSURE: 1.15,

    /** 按天色给曝光。**必须**做这一步：两套夜色（深夜 / 星夜）实测平均明度只有
     *  5.5 与 7.0（满值 255）—— 屏幕基本是黑的，而作品的前提是"走到中心去读一句话"，
     *  黑到看不见路这个前提就不成立。
     *  数值本身照着参考稿给（环境光 0.26–0.30、月光 0.7–0.9），并没有写错；
     *  是 ACES 色调映射把这些很暗的线性值又压了一档，于是落到 8bit 只有个位数。
     *  正确的工具是**曝光**（不改颜色关系，只整体提亮），而不是去动天色配色 ——
     *  压高光/提暗部要用曝光，这条参考稿里也写了。
     *  dark = 1 表示最暗的天色；正午那种亮天色不额外提曝光，免得过曝。 */
    setSky(sky) {
      const amb = sky.ambI ?? 0.5;
      const dark = Math.max(0, 1 - amb / 0.9);
      bloom.strength = 0.22 + dark * 0.36;
      /* 夜色补偿要**很强**才够：ACES 的暗部压缩很猛，实测 +85% 曝光只把星夜从
         L5.5 抬到 L8.3 —— 杯水车薪。因为问题不在"少一点点光"，
         而在于这套配色（地色 0x18202e）本来就落在 ACES 最陡的压缩区。
         这里取到 +260%，并且只对很暗的天色生效（dark² 让中间天色基本不受影响）。
         这不是"物理正确的夜景"，是**可读的夜景** —— 作品要求看得见路。 */
      const skyExposure = 1 + dark * dark * 2.6;
      this._skyExposure = skyExposure;
      renderer.toneMappingExposure = this.exposureOf();
      return skyExposure;
    },

    /** 当前该用的曝光 = 基准 × 天色补偿 × 调用方给的系数。
     *  统一从这里取，别在别处写死 1.15 —— 写死就会把天色补偿覆盖掉（踩过）。 */
    exposureOf(mul = 1) {
      return 1.15 * (this._skyExposure ?? 1) * mul;
    },

    setSize(w, h) {
      composer.setSize(w, h);
      bloom.setSize(w, h);
    },
    render() {
      composer.render();
    }
  };
}

/**
 * 水洼遮罩：黑底上画几团柔边的白斑，白色处才出现水面。
 * 程序生成 + 固定种子 —— 同一条链接在任何机器上水洼都在同一处。
 *
 * ⚠️ **落点必须与"地面平不平"同源**：水洼是一整块平面反射器（曲面做不了），
 * 所以它只能出现在 groundHeight 的平地圈内。早先遮罩把水洼撒满整个 14.2 米平面
 * （uv 0.14–0.86），而着色器里又按半径裁掉了外圈 —— 两边各自为政的结果是
 * 实测只有 **1.47% 的面积**剩下水面，"雨后水洼当主角"这条设计整个没了。
 * 现在把撒点半径收到 `PUDDLE_SPREAD`（对应世界的平地圈），着色器只做柔边过渡。
 */
export const PUDDLE_FLAT_UV = 0.30;   // 平地圈半径占纹理半宽的比例（与 world.js 的 GROUND_FLAT_R 对应）

export function puddleMaskTexture(size = 512, seed = 20261009) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };

  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);

  // 每处水洼由 3~5 个交叠的软圆构成，边缘自然不规则。
  // 撒点用极坐标、半径限制在平地圈内（而不是铺满整张贴图）
  const puddles = 9;
  for (let p = 0; p < puddles; p++) {
    const a0 = rnd() * Math.PI * 2;
    const r0 = Math.sqrt(rnd()) * PUDDLE_FLAT_UV * size * 0.92;   // sqrt：面积均匀，不然会挤在圆心
    const cx = size * 0.5 + Math.cos(a0) * r0;
    const cy = size * 0.5 + Math.sin(a0) * r0;
    const base = size * (0.022 + rnd() * 0.030);                  // 水洼也比原来小一档
    const blobs = 3 + Math.floor(rnd() * 3);
    for (let b = 0; b < blobs; b++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * base * 0.9;
      const R = base * (0.55 + rnd() * 0.6);
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      const grd = g.createRadialGradient(x, y, R * 0.25, x, y, R);
      grd.addColorStop(0, 'rgba(255,255,255,0.95)');
      grd.addColorStop(0.55, 'rgba(255,255,255,0.7)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(x, y, R, 0, Math.PI * 2);
      g.fill();
    }
  }

  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;   // 这是遮罩，不是颜色
  return t;
}

/**
 * 柔光圆点贴图：程序生成，不依赖任何图片文件。
 * Points 默认画的是方块，有了它才是"光点"而不是"像素点"。
 */
export function softDotTexture(size = 64) {  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0.0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * 雨丝贴图：竖直的细长柔条。
 * 雨点用圆点会读成"下雪"，必须拉成竖直的条 —— 这是"雨"这个形态的全部信息。
 * 同样程序生成，不加载任何图片。
 */
export function rainStreakTexture(w = 32, h = 128) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  // 横向一条高斯状的亮带、纵向两头淡出：于是它是一条雨丝，而不是一根白棍
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0.00, 'rgba(255,255,255,0)');
  grd.addColorStop(0.22, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.95)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  // 中间 1/3 宽度，两侧留白 → 采样时就是一条细丝
  g.fillRect(w * 0.34, 0, w * 0.32, h);
  // 横向再做一次柔化，避免边缘是硬切
  const side = g.createLinearGradient(0, 0, w, 0);
  side.addColorStop(0.00, 'rgba(0,0,0,1)');
  side.addColorStop(0.34, 'rgba(0,0,0,0)');
  side.addColorStop(0.66, 'rgba(0,0,0,0)');
  side.addColorStop(1.00, 'rgba(0,0,0,1)');
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = side;
  g.fillRect(0, 0, w, h);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
