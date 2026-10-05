/* 世界对移动的反应：走过某件东西时，它回应你。
   ─────────────────────────────────────────────────────────
   为什么加这个：原来"走进去"就是从边缘走到中心的一条直线，
   沿途的灯、蜡烛、钟、树都只是**布景** —— 它们不承认你的存在。
   而收件人（本作的主受众）只有这一次体验，二十秒里如果没有任何东西
   回应过他，这段路就只是"走过一片草地"。

   三条设计约束（决定了它会不会变成廉价的闪烁特效）：
    1. **反应要慢、要有余味** —— 快闪像 UI 反馈，慢亮像有人抬头看了你一眼。
       所以用 1.5–2 秒的缓动，而不是按帧脉冲。
    2. **只在近处发生** —— 半径约 2 米。太远就会变成"全场都在闪"，
       反而失去"它在回应我"的因果感。
    3. **每个物件只回应一次，并且记住已经回应过** —— 反复走近反复亮
       会立刻读成机械触发。一次，才像打招呼。

   实现上不是"每个物件一个状态机"，而是**按距离算一个 0→1 的响应度**，
   然后让物件用它去调制自己本来就有的东西（灯的强度、蜡烛的摇曳幅度）。
   这样不用给每种物件写专门逻辑，加新物件也自然生效。
*/
import * as THREE from 'three';

/** 反应半径（米）。取 2 米：约等于"走到它跟前"的距离 */
const NEAR_R = 2.0;
/** 响应从 0 升到 1 的时间常数（秒）。慢，才有"抬头看你一眼"的感觉 */
const RISE = 0.55;

/**
 * 造一个"注意力"跟踪器：每帧喂进相机位置，算出每件物件的响应度。
 * @param spots [{ x, z, obj, kind }] —— kind 决定怎么用这个响应度
 */
export function createAttention(spots) {
  // 每件物件一份状态：当前响应度、是否已经打过招呼
  const state = spots.map(s => ({ ...s, hit: 0, greeted: false }));
  let anyNew = false;
  const newlyGreeted = [];

  return {
    state,
    /** 已经打过招呼的件数（用于"你唤醒了 N 件东西"这类反馈） */
    get greetedCount() { return state.reduce((a, s) => a + (s.greeted ? 1 : 0), 0); },
    get total() { return state.length; },

    /** 本帧是否有新的物件第一次回应 —— 用来触发一点声音或微光 */
    consumeNewGreeting() {
      if (!newlyGreeted.length) return null;
      const r = newlyGreeted.slice();
      newlyGreeted.length = 0;
      return r;
    },

    /**
     * 每帧推进。
     * @param dt 真实时间步长（秒）—— 必须按真实时间，不能按帧，否则低帧率机器上
     *           反应会变成"瞬间全亮"，那正是要避免的廉价感。
     * @param px,pz 相机水平位置
     */
    update(dt, px, pz) {
      anyNew = false;
      for (const s of state) {
        const d = Math.hypot(px - s.x, pz - s.z);
        // 目标响应度：进半径就是 1，出了就回落到 0（但 greeted 会一直记住）
        const want = d < NEAR_R ? 1 : 0;
        if (want > 0 && !s.greeted) {
          s.greeted = true;
          newlyGreeted.push(s);
          anyNew = true;
        }
        // 指数趋近：上升用 RISE，回落更慢（余味），且**第一次回应后不再完全归零**，
        // 留一个 0.18 的底 —— 它记得你
        const k = 1 - Math.exp(-dt / (want > s.hit ? RISE : RISE * 2.2));
        s.hit += (want - s.hit) * k;
        if (s.greeted) s.hit = Math.max(s.hit, 0.18);
      }
      return anyNew;
    }
  };
}

/**
 * 一个物件怎么"用"这个响应度 —— 按 kind 分派。
 * 注意这里改的都是物件**本来就有**的属性（灯强、摇曳幅度），
 * 不是外加一层发光特效：外加的特效会显得像 UI，调制品本身的属性才像它自己的反应。
 *
 * ⚠️ `cur` 传进来的是**已经算过摇曳的当前强度**，不是基准值。
 * 原因是 flickerLights 每帧都会重写 intensity，两边都写就会互相覆盖
 * （先写的那次直接丢失）——所以这里必须在摇曳的结果上再叠一层，
 * 而不是各自从 base 算。
 */
export function applyAttention(spot, cur, t) {
  const a = spot.hit;
  if (a <= 0.001) return cur;
  switch (spot.kind) {
    case 'lamp':
      // 灯：走近时亮一档，并轻微加快摇曳
      return cur * (1 + a * 0.55) + Math.sin(t * 3.1) * 0.04 * a;
    case 'candle':
      // 蜡烛：火苗被你的靠近扰动一下（幅度随响应度增大）
      return cur * (1 + a * 0.35) + Math.sin(t * 6.7) * 0.10 * a;
    default:
      return cur;
  }
}

export { NEAR_R, RISE };
