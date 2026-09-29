/* 程序化音景：雨、风、脚步，以及那句话浮现时的一声轻响。
   全部用 WebAudio 现场合成 —— 不加载任何音频文件：没有版权问题，不占体积，
   离线也能响。没有 AudioContext 的环境（无头浏览器 / 旧浏览器）自动退化成
   "静音但不报错"，绝不阻塞主流程。
*/

const TARGET_GAIN = 0.5;

export function createAudio() {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;

  // 退化对象：保证调用方不用写任何 if。
  // `muted` 必须是**活的**：无 WebAudio 时如果 toggleMute 恒返回 true，
  // 界面上的"声音：开 / 关"按钮就永远不变，用户会以为按钮坏了。
  // 环境没有声音不是用户的错，但界面得如实反映状态。
  const noop = {
    ok: false, muted: true,
    resume() {}, setScene() {}, update() {}, chime() {}, blip() {},
    setMuted(v) { noop.muted = !!v; return noop.muted; },
    toggleMute() { noop.muted = !noop.muted; return noop.muted; }
  };
  if (!Ctx) return noop;

  let ctx = null, master = null, noiseBuf = null;
  let bed = null, bedKind = null;
  let muted = false, started = false, chimePlayed = false;
  let stepClock = 0;

  function makeNoise() {
    if (noiseBuf) return noiseBuf;
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    noiseBuf = buf;
    return buf;
  }

  function noise() {
    const s = ctx.createBufferSource();
    s.buffer = makeNoise();
    s.loop = true;
    return s;
  }

  function filter(type, freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q != null) f.Q.value = q;
    return f;
  }

  function gain(v) {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  }

  /** 给某个参数挂一个缓慢起伏的 LFO —— 静态噪音听着像故障，起伏才像环境 */
  function lfo(param, rate, depth, base) {
    const osc = ctx.createOscillator();
    osc.frequency.value = rate;
    const amp = gain(depth);
    osc.connect(amp).connect(param);
    param.value = base;
    osc.start();
    return osc;
  }

  function ensureCtx() {
    if (ctx) return true;
    try {
      ctx = new Ctx();
      master = gain(0);
      master.connect(ctx.destination);
      return true;
    } catch {
      ctx = null;
      return false;
    }
  }

  /** 造当前天色的环境音床 */
  function buildBed(kind) {
    if (bed) { try { bed.stop(); } catch { /* 已经停了 */ } bed = null; }

    const nodes = [];
    const out = gain(0);
    out.connect(master);

    if (kind === 'rain') {
      // 雨：中频带通 + 缓慢起伏，"淅沥"感来自 1.2k 附近
      const n = noise(), bp = filter('bandpass', 1200, 0.6), lp = filter('lowpass', 6500), g = gain(0.34);
      n.connect(bp).connect(lp).connect(g).connect(out);
      nodes.push(n, lfo(g.gain, 0.07, 0.07, 0.30));
      n.start();
    } else if (kind === 'snow') {
      // 初雪：几乎没有声音，只有很远的一层高频"沙"
      const n = noise(), hp = filter('highpass', 3200), g = gain(0.09);
      n.connect(hp).connect(g).connect(out);
      nodes.push(n);
      const w = noise(), wl = filter('lowpass', 420), wg = gain(0.05);
      w.connect(wl).connect(wg).connect(out);
      nodes.push(w, lfo(wl.frequency, 0.045, 140, 400));
      n.start(); w.start();
    } else if (kind === 'dusk') {
      // 黄昏：风。低通频率慢速摆动 = 风声的"呜"
      const n = noise(), lp = filter('lowpass', 340), g = gain(0.20);
      n.connect(lp).connect(g).connect(out);
      nodes.push(n, lfo(lp.frequency, 0.06, 190, 330));
      n.start();
    } else {
      // 深夜：极低的一层底噪 + 55Hz 的嗡鸣
      const n = noise(), lp = filter('lowpass', 150), g = gain(0.11);
      n.connect(lp).connect(g).connect(out);
      nodes.push(n);
      const drone = ctx.createOscillator(), dg = gain(0.028);
      drone.type = 'sine';
      drone.frequency.value = 55;
      drone.connect(dg).connect(out);
      drone.start();
      nodes.push(drone);
      n.start();
    }

    out.gain.setTargetAtTime(1, ctx.currentTime, 1.2);
    bed = { out, nodes, stop() { nodes.forEach(x => { try { x.stop(); } catch { /* 振荡器已停 */ } }); } };
    bedKind = kind;
  }

  function playStep() {
    // 脚步 = 一小段噪声 + 带通 + 极快包络。音高随机，避免机械感
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = makeNoise();
    src.playbackRate.value = 1;
    const bp = filter('bandpass', 620 + Math.random() * 420, 1.1);
    const g = gain(0);
    src.connect(bp).connect(g).connect(master);
    const peak = 0.05 + Math.random() * 0.035;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.10);
    src.start(t, Math.random() * 1.5, 0.12);
    src.stop(t + 0.13);
  }

  return {
    ok: true,
    get muted() { return muted; },

    /** 必须在用户手势里调用（浏览器自动播放策略） */
    resume() {
      if (!ensureCtx()) return;
      // resume() 返回 Promise，拒绝时 try/catch 抓不到 —— 必须挂 catch，
      // 否则浏览器会在控制台留下 unhandled rejection
      try { ctx.resume()?.catch?.(() => { /* 已被挂起，下次手势再试 */ }); } catch { /* 已经是 running */ }
      if (!started) {
        started = true;
        master.gain.setTargetAtTime(muted ? 0 : TARGET_GAIN, ctx.currentTime, 1.5);
        if (bedKind) buildBed(bedKind);
      }
    },

    /** 接受天色自带的 sound 字段：'dusk' | 'night' | 'rain' | 'snow' | 'dawn' | 'noon' | 'fog' */
    setScene(kind) {
      // 天色到音床的映射：雨雪优先，其余按明暗归类
      const bed = kind === 'rain' ? 'rain'
        : kind === 'snow' ? 'snow'
        : kind === 'night' ? 'night'
        : kind === 'fog' ? 'snow'      // 雾天用那层很远的沙沙声
        : 'dusk';
      if (bed === bedKind) return;
      bedKind = bed;
      if (started && ctx) buildBed(bed);
    },

    /** 每帧调用：自己决定什么时候落下一步 */
    update(dt, walking) {
      if (!started || muted || !walking) return;
      stepClock -= dt;
      if (stepClock <= 0) { stepClock = 0.5 + Math.random() * 0.12; playStep(); }
    },

    /** 那句话浮现时响一次 */
    chime() {
      if (!started || muted || chimePlayed || !ctx) return;
      chimePlayed = true;
      const t0 = ctx.currentTime;
      [528, 660, 792].forEach((f, i) => {
        const osc = ctx.createOscillator(), g = gain(0);
        osc.type = 'sine';
        osc.frequency.value = f;
        osc.detune.value = (i - 1) * 4;
        osc.connect(g).connect(master);
        const at = t0 + i * 0.12;
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(0.075, at + 0.5);
        g.gain.exponentialRampToValueAtTime(0.0004, at + 4.2);
        osc.start(at);
        osc.stop(at + 4.4);
      });
    },

    /** 走近某件东西、它第一次回应你时的一声极轻的响。
     *  与 chime 分开写：chime 是"读到那句话"的一次性高潮，有 chimePlayed 守卫；
     *  这个会在路上响好几次，所以既不能共用守卫，音量也要低得多——
     *  它只是让"它注意到我了"这件事被听见，不该抢那句台词的戏。 */
    blip() {
      if (!started || muted || !ctx) return;
      const t0 = ctx.currentTime;
      const osc = ctx.createOscillator(), g = gain(0);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1180, t0);
      osc.frequency.exponentialRampToValueAtTime(880, t0 + 0.18);
      osc.connect(g).connect(master);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.028, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0003, t0 + 0.42);
      osc.start(t0);
      osc.stop(t0 + 0.44);
    },

    setMuted(v) {
      muted = !!v;
      if (ctx && started) master.gain.setTargetAtTime(muted ? 0 : TARGET_GAIN, ctx.currentTime, 0.25);
      return muted;
    },

    toggleMute() { return this.setMuted(!muted); }
  };
}
