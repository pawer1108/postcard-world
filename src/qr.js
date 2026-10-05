/* 二维码：把一条链接画到明信片上。
   ─────────────────────────────────────────────────────────
   为什么值得为它写 200 行：明信片是这件作品**唯一能离开屏幕、进入现实**的产物
   （见 makePostcard 的说明）。而"寄到"这件事，在现实里的动作就是让对方扫一下。
   引第三方库不行：本项目零构建、零依赖，vendor/ 里只有 three。

   实现范围刻意压到最小：**字节模式 + 纠错等级 M + 版本 1–15**。
   为什么不支持字母数字模式：链接里大小写、`/`、`:`、`-`、`_` 都有，
   字节模式是唯一通用的，而字母数字模式并不会让码变小到值得多写一套编码表。

   ⚠️ 这个文件里每一处都对应标准里的一个具体条款，改动前先看清注释：
     · 版本选择要按**实际位数**算（模式 4 位 + 长度 8 位 + 数据 + 终止符），
       用"字节数 + 2"近似会在边界上选大一号的版本 —— 码体变大、明信片上更难印清
     · 掩码罚分**四条都要**（尤其规则 3：1:1:3:1:1 那条）。缺一条不影响"能不能扫"，
       但会选出一个更容易误读的掩码，属于"看起来对、其实更差"的那类错
     · 数据放置是**两列一组、右列先、方向逐组翻转**（从右下角往上走）
     · 格式信息第 0–5 位在左上竖列上是**自下而上**排的
   这三条我都写错过一次，而它们的症状都是"矩阵出来了、扫不出来"。
*/

/* 纠错等级 M 的数据容量表：[每块纠错码字数, 组1块数, 组1数据码字, 组2块数, 组2数据码字]
   版本 → 数据字节上限约 = (b1*d1 + b2*d2) - 2。只到 v15（77×77）：再大就印不清了。 */
const EC_BLOCKS = {
  1: [10, 1, 19, 0, 0], 2: [16, 1, 34, 0, 0], 3: [26, 1, 55, 0, 0],
  4: [18, 2, 40, 0, 0], 5: [24, 2, 54, 0, 0], 6: [16, 4, 68, 0, 0],
  7: [18, 4, 78, 0, 0], 8: [22, 2, 97, 2, 98], 9: [22, 3, 116, 2, 117],
  10: [26, 4, 145, 1, 146], 11: [30, 1, 175, 4, 175], 12: [22, 6, 212, 2, 213],
  13: [22, 8, 246, 1, 247], 14: [24, 4, 252, 5, 253], 15: [24, 5, 285, 5, 286]
};

/* 对齐图形中心坐标（版本 → 坐标表） */
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
  15: [6, 26, 48, 70]
};

/* ---------- GF(256)：纠错码用，本原多项式 0x11d ---------- */
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1; if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

function rsGenerator(deg) {
  let g = [1];
  for (let i = 0; i < deg; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= gfMul(g[j], 1);
      next[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function rsEncode(data, ecLen) {
  const g = rsGenerator(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ res[0];
    res.shift(); res.push(0);
    for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(g[i + 1], factor);
  }
  return res;
}

/* ---------- 位流 ---------- */
function bitsNeeded(nBytes) { return 4 + 8 + nBytes * 8; }   // 模式 4 位 + 长度 8 位 + 数据

function bestVersion(nBytes) {
  const need = bitsNeeded(nBytes) + 4;                       // 留 4 位终止符
  for (let v = 1; v <= 15; v++) {
    const blk = EC_BLOCKS[v];
    const dataCw = blk[1] * blk[2] + blk[3] * blk[4];
    if (dataCw * 8 >= need) return v;
  }
  return null;
}

function buildCodewords(bytes, ver) {
  const [ecLen, b1, d1, b2, d2] = EC_BLOCKS[ver];
  const totalData = b1 * d1 + b2 * d2;
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4);                       // 模式指示符：0100 = 字节模式
  put(bytes.length, 8);            // 字符计数（版本 < 10 时为 8 位，本项目只用到 < 10 才够小）
  for (const b of bytes) put(b, 8);
  const cap = totalData * 8;
  put(0, Math.min(4, Math.max(0, cap - bits.length)));        // 终止符（最多 4 位）
  while (bits.length % 8) bits.push(0);                       // 补到字节边界
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | (bits[i + k] || 0);
    cw.push(b);
  }
  const PAD = [0xEC, 0x11];                                   // 标准规定的填充字节
  for (let i = 0; cw.length < totalData; i++) cw.push(PAD[i % 2]);

  // 分块 + 纠错 + 交织
  const blocks = [];
  let off = 0;
  for (let i = 0; i < b1; i++) { const d = cw.slice(off, off + d1); off += d1; blocks.push({ d, e: rsEncode(d, ecLen) }); }
  for (let i = 0; i < b2; i++) { const d = cw.slice(off, off + d2); off += d2; blocks.push({ d, e: rsEncode(d, ecLen) }); }
  const out = [];
  const maxD = Math.max(...blocks.map(b => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

/* ---------- 矩阵 ---------- */
function buildMatrix(ver, cw) {
  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(0));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, v) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    m[r][c] = v; fixed[r][c] = true;
  };

  // 三个定位图形（含分隔符）
  const finder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const r = r0 + dr, c = c0 + dc;
      if (r < 0 || r >= size || c < 0 || c >= size) continue;
      const ring = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) || (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
      const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      set(r, c, (ring || core) ? 1 : 0);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  /* 定时图形：第 6 行与第 6 列上的黑白交替线。
     标准定义是"模块 (6,i) 与 (i,6) 在 **i 为偶数**时为深色"。
     定位图形占 0–6 列、第 7 列是分隔符，所以可见的定时线从第 8 格开始、为**深色**，
     之后逐格交替。⚠️ 相位不要凭直觉写：我一度以为"第 8 格应当是浅色"，
     差点把这里改反 —— 反相之后矩阵结构完全合法、但整张码扫不出来。 */
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    set(6, i, v);
    set(i, 6, v);
  }

  // 对齐图形（跳过与定位图形重叠的位置）
  for (const r of (ALIGN[ver] || [])) for (const c of (ALIGN[ver] || [])) {
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0);
    }
  }

  set(size - 8, 8, 1);      // 固定暗模块

  /* 预留格式信息区（先占位，稍后用真实格式位覆盖）。
     ⚠️ **只占第 8 行与第 8 列**，绝不能"整行整列清一遍" ——
     第一版写成 `for (i=0..8) set(8,i,0); set(i,8,0)`，
     于是 (6,8) 与 (8,6) 这两格**定时线**被清成 0：
     矩阵结构依旧合法、定位图形完好，但定时线断了 —— 正是"扫不出来"的典型形态。
     格式信息的实际坐标是下面这 15 对（左侧竖列 + 右侧横列，
     以及底部横列 + 右上竖列，两处冗余）。 */
  const reserve = (r, c) => { if (!fixed[r][c]) { m[r][c] = 0; fixed[r][c] = true; } };
  // 第一份：竖列 (5-i, 8) / (6,8)? 不 —— 是 (i,8) 去掉第 6 行（定时线），加 (7,8)(8,8)(8,7)
  for (let i = 0; i <= 5; i++) reserve(i, 8);
  reserve(7, 8); reserve(8, 8); reserve(8, 7);
  for (let i = 9; i <= 14; i++) reserve(8, 14 - i);
  // 第二份（冗余，供残缺读取）
  for (let i = 0; i <= 7; i++) reserve(size - 1 - i, 8);
  for (let i = 8; i <= 14; i++) reserve(8, size - 15 + i);

  /* 数据放置：从右下角起，两列一组，**右列先、向上走，方向逐组翻转**。
     ⚠️ 方向是"跨组翻转"的（col 递减 2 时切一次），不是按列号算出来的 ——
     第一版按 `((size-1-col)/2) % 2` 推，写出了完全错乱的矩阵。 */
  let bi = 0;
  const total = cw.length * 8;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;                       // 第 6 列是定时图形，跳过（列对会整体左移）
    for (let row = 0; row < size; row++) {
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        const r = up ? size - 1 - row : row;
        if (fixed[r][c]) continue;
        const bit = bi < total ? (cw[bi >> 3] >>> (7 - (bi & 7))) & 1 : 0;
        m[r][c] = bit; fixed[r][c] = true;
        bi++;
      }
    }
    up = !up;
  }
  return { m, size, fixed };
}

/* ---------- 掩码 ---------- */
function maskFn(id) {
  switch (id) {
    case 0: return (r, c) => (r + c) % 2 === 0;
    case 1: return (r) => r % 2 === 0;
    case 2: return (r, c) => c % 3 === 0;
    case 3: return (r, c) => (r + c) % 3 === 0;
    case 4: return (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

function applyMask(m, size, fixed, id) {
  const f = maskFn(id);
  return m.map((row, r) => row.map((v, c) => fixed[r][c] ? v : (v ^ (f(r, c) ? 1 : 0))));
}

/* 掩码罚分：四条规则都要。
   ⚠️ 规则 3（1:1:3:1:1 且前后有 4 个浅色）不能省 —— 那是定位图形的签名，
   数据区出现它会干扰识读，规范专门给最高罚分好让掩码避开。缺了它不影响能不能扫，
   但会选出一个更容易误读的掩码：属于"参数看着对、结果更差"的那一类。 */
function penalty(m, size) {
  let p = 0;
  const runScore = (get) => {
    let run = 1;
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) run++;
      else { if (run >= 5) p += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) p += 3 + (run - 5);
  };
  for (let r = 0; r < size; r++) runScore(i => m[r][i]);
  for (let c = 0; c < size; c++) runScore(i => m[i][c]);

  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
  }

  const PAT = [1, 0, 1, 1, 1, 0, 1];
  const check = (get) => {
    for (let i = 0; i + 6 < size; i++) {
      let hit = true;
      for (let k = 0; k < 7; k++) if (get(i + k) !== PAT[k]) { hit = false; break; }
      if (!hit) continue;
      let light = 0;
      for (let k = 1; k <= 4; k++) { const j = i + 6 + k; if (j >= size) break; if (get(j) === 0) light++; }
      let light2 = 0;
      for (let k = 1; k <= 4; k++) { const j = i - k; if (j < 0) break; if (get(j) === 0) light2++; }
      if (light === 4 || light2 === 4) p += 40;
    }
  };
  for (let r = 0; r < size; r++) check(i => m[r][i]);
  for (let c = 0; c < size; c++) check(i => m[i][c]);

  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  p += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return p;
}

/* 格式信息：纠错等级 M(00) + 掩码号，BCH(15,5) + 固定掩码 0x5412 */
function formatBits(maskId) {
  const data = (0 << 3) | maskId;                 // 等级 M 的指示位是 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function placeFormat(m, size, maskId) {
  const bits = formatBits(maskId);
  const b = (i) => (bits >>> i) & 1;
  /* ⚠️ 第 0–5 位在左上竖列上是**自下而上**的（位 0 在 (5,8)、位 5 在 (0,8)）。
     按"从上往下"写会得到一份格式位全错、但结构完全合法的矩阵 —— 扫不出来。 */
  for (let i = 0; i <= 5; i++) m[5 - i][8] = b(i);
  m[7][8] = b(6); m[8][8] = b(7); m[8][7] = b(8);
  for (let i = 9; i <= 14; i++) m[8][14 - i] = b(i);
  // 第二份（供冗余读取）
  for (let i = 0; i <= 7; i++) m[size - 1 - i][8] = b(i);
  for (let i = 8; i <= 14; i++) m[8][size - 15 + i] = b(i);
  m[size - 8][8] = 1;
  return m;
}

/**
 * 文本 → 二维码点阵。
 * @returns {{size:number, m:number[][]}|null} 太长（超出 v15）时返回 null，
 *          调用方据此**优雅降级**成印一行文字链接，而不是印一个扫不出来的码。
 */
export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text));
  const ver = bestVersion(bytes.length);
  if (!ver) return null;
  const cw = buildCodewords(bytes, ver);
  const { m, size, fixed } = buildMatrix(ver, cw);
  let best = null, bestP = Infinity;
  for (let id = 0; id < 8; id++) {
    const cand = placeFormat(applyMask(m, size, fixed, id), size, id);
    const p = penalty(cand, size);
    if (p < bestP) { bestP = p; best = cand; }
  }
  return { size, m: best };
}
