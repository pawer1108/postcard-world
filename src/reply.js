/* 回信动画：收件人选一件东西，让它替他说话。
   ─────────────────────────────────────────────────────────
   为什么是"选"而不是固定一种：选什么来信本身就是一次表达 ——
   纸船是"我收到了，让它漂回来"、蜡烛是"我把光留在这儿"、
   信是"把话还给你"。固定那一种会退化成流程，可选的那一种才像回信。

   三条共同的设计约束：
    1. **按真实时间推进**（`dt` 已钳在 0.05 秒内），不按帧 —— 低帧率机器上
       按帧累加会把动画拉成慢动作，而这是收件人主动触发的、他一定会盯着看。
    2. **缓动，不是匀速**：入场用 easeOutCubic、收尾用 easeInOutSine。
       匀速运动看起来像机械位移，缓动才像"有重量"。
    3. **不改物件的原始摆放数据**：动画只动 group 的 transform，
       结束态由 `settle()` 固定下来。这样它和"物件摆在哪"那份状态是两回事，
       收件人退回上一步时不会污染创作者的世界。
*/
import * as THREE from 'three';
import { findEmissiveMaterials, visualHeightOf } from './world.js';

const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
const easeInOutSine = (x) => -(Math.cos(Math.PI * x) - 1) / 2;
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/**
 * 造一个回信动画。
 * @param anim  'sail' | 'dim' | 'lift'（见 state.js 的 REPLY_CHOICES）
 * @param group 选中的那件物件的 group
 * @param scene 用来放涟漪 / 青烟这类一次性特效
 */
export function createReplyAnimation(anim, group, scene) {
  const home = group.position.clone();
  const h = visualHeightOf(group);
  const emissives = findEmissiveMaterials(group);
  // 记下初始发光强度，才能"暗下去"而不是直接关掉
  const emissiveBase = emissives.map(m => m.emissiveIntensity);

  /* 一次性特效：涟漪（纸船）与青烟（蜡烛）。
     做成极简的一圈 / 一缕，用透明度的生命周期驱动，不需要粒子系统 ——
     这一秒钟的镜头里，多一个粒子系统只是多一份开销。 */
  let fx = null;
  if (anim === 'sail') {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.05, 0.09, 48),
      new THREE.MeshBasicMaterial({ color: 0xcfe0e8, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(home.x, 0.05, home.z);
    scene.add(ring);
    fx = { ring, t: 0 };
  } else if (anim === 'dim') {
    // 青烟：一条极细的竖条，向上飘并淡出
    const smoke = new THREE.Mesh(
      new THREE.PlaneGeometry(0.05, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xbfc4c9, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })
    );
    smoke.position.set(home.x, home.y + h * 0.9, home.z);
    scene.add(smoke);
    fx = { smoke, t: 0 };
  }

  // 总时长：漂/灭/浮 三种动作的物理时间本来就不同，不该一律 3 秒
  const DUR = anim === 'sail' ? 3.4 : anim === 'dim' ? 2.6 : 3.0;
  const state = { t: 0, done: false };

  /** 世界的中心：回信都朝向那里 —— 它正是"那句话"的位置 */
  const target = new THREE.Vector3(0, 0, 0);

  return {
    duration: DUR,
    get done() { return state.done; },

    /** 按真实时间推进；返回是否还在动 */
    update(dt) {
      if (state.done) return false;
      state.t = Math.min(DUR, state.t + dt);
      const p = clamp01(state.t / DUR);
      const y0 = group.position.y;

      if (anim === 'sail') {
        // 纸船：离岸 → 漂向中心。用 easeInOutSine 让它"起步慢、中途快、靠岸慢"，
        // 像水推着走；同时绕 y 轴轻微摇摆（船在水上不会完全正）
        const e = easeInOutSine(p);
        group.position.x = home.x + (target.x + 0.35 - home.x) * e;
        group.position.z = home.z + (target.z + 0.55 - home.z) * e;
        // 漂在水上：贴着地面高度，再加一点随波起伏
        group.position.y = y0 + Math.sin(p * Math.PI * 3) * 0.012;
        group.rotation.z = Math.sin(p * Math.PI * 4) * 0.06;
        group.rotation.y += dt * 0.5;
        if (fx) {
          fx.t += dt;
          // 涟漪跟着船走，一边扩散一边淡出，循环几次
          const k = (fx.t % 1.1) / 1.1;
          fx.ring.position.set(group.position.x, 0.05, group.position.z);
          const s = 0.4 + k * 2.6;
          fx.ring.scale.set(s, s, s);
          fx.ring.material.opacity = (1 - k) * 0.5 * (1 - p * 0.35);
        }
      } else if (anim === 'dim') {
        // 蜡烛：火苗先晃两下，再收小、暗下去，最后留一缕烟
        // 前 35% 只晃不灭 —— 直接灭掉会像被掐断，晃一下才像"烧完了"
        const flick = p < 0.35 ? 1 + Math.sin(p * 40) * 0.18 : 1;
        const fade = p < 0.35 ? 1 : 1 - easeOutCubic((p - 0.35) / 0.65);
        for (let i = 0; i < emissives.length; i++) {
          emissives[i].emissiveIntensity = emissiveBase[i] * fade * flick;
        }
        if (fx) {
          fx.t += dt;
          const k = clamp01((fx.t - DUR * 0.4) / (DUR * 0.6));
          fx.smoke.position.y = home.y + h * 0.9 + k * 0.5;
          fx.smoke.material.opacity = Math.sin(k * Math.PI) * 0.30;
          fx.smoke.rotation.z = Math.sin(k * 5) * 0.12;
        }
      } else {
        // 信：从地面浮起、悬在中心附近，轻轻晃
        const e = easeOutCubic(p);
        group.position.y = y0 + (1.15 - y0) * e;
        group.position.x = home.x + (target.x - home.x) * easeInOutSine(p) * 0.35;
        group.position.z = home.z + (target.z - home.z) * easeInOutSine(p) * 0.35;
        group.rotation.y += dt * 0.35;
        group.rotation.x = Math.sin(p * Math.PI * 2) * 0.08;
      }

      if (state.t >= DUR) {
        state.done = true;
        // 收尾时把一次性特效清掉，别留在场景里
        if (fx?.ring) { scene.remove(fx.ring); fx.ring.geometry.dispose(); fx.ring.material.dispose(); }
        if (fx?.smoke) { scene.remove(fx.smoke); fx.smoke.geometry.dispose(); fx.smoke.material.dispose(); }
      }
      return true;
    },

    /** 直接跳到结束态（收件人重开链接时，回信应该已经"完成"了，
     *  而不是每次刷新都重演一遍 —— 那是动画，不是状态） */
    settle() {
      state.t = DUR; state.done = true;
      if (anim === 'sail') {
        group.position.set(target.x + 0.35, home.y, target.z + 0.55);
      } else if (anim === 'dim') {
        for (let i = 0; i < emissives.length; i++) emissives[i].emissiveIntensity = 0;
      } else {
        group.position.set(home.x, 1.15, home.z);
      }
      if (fx?.ring) { scene.remove(fx.ring); fx.ring.geometry.dispose(); fx.ring.material.dispose(); }
      if (fx?.smoke) { scene.remove(fx.smoke); fx.smoke.geometry.dispose(); fx.smoke.material.dispose(); }
    }
  };
}
