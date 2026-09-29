/* 界面语言：中文 / English。
   为什么需要它：这是**世界级**比赛，非中文评委要能读懂"这是什么、我该做什么"。
   但也不做机器翻译式的全量：**接收侧（评委最先看到的）全量英文化**，
   创作侧只翻按钮与标签 —— 剩下的长句帮助文字宁可保留中文，也不给半吊子英文。

   语言怎么定（顺序即优先级）：
     1. URL 里显式指定：`?lang=en` / `?lang=zh`（也接受 `#w=…&lang=en`）
     2. 上次选的（localStorage）
     3. 浏览器语言：zh 开头 → 中文，其余 → English
   所以评委用英文浏览器打开，看到的直接就是英文。

   用法：
     import { t, lang, applyI18n } from './i18n.js';
     t('enter')                      → 'Walk in' / '走进去'
     applyI18n(root)                 → 把 DOM 上 data-i18n 的节点全部填好
   DOM 约定：
     data-i18n="key"          → textContent
     data-i18n-ph="key"       → placeholder
     data-i18n-aria="key"     → aria-label
*/

const DICT = {
  zh: {
    // —— 入场浮层 ——
    introLine: '有人给你留了一个世界',
    introLineDemo: '先看看它是什么',
    introNameDemo: '一个别人收到的世界',
    introNameGeneric: '给某人',
    giveTo: (n) => '给 ' + n,
    giveToYou: '给你',
    preparing: '正在准备…',
    enter: '走进去',
    hintKeys: '拖动看四周 · WASD 或 ↑↓ 走路 · 手机上按住"向前"',
    demoNote: '这是别人做给他、他走进去看过的一个世界 —— 你也可以做一个，送给某个人',
    demoCreate: '我也做一个 →',
    waitLine: (d) => `这个世界，${d} 天了`,

    // —— HUD ——
    walk: '按住向前',
    reply: '回一封信',
    postcard: '存一张明信片',
    soundOn: '声音：开',
    soundOff: '声音：关',
    createNew: '我也做一个世界',

    // —— 回信 ——
    replyTitle: '回一封信给他',
    replySub: '挑一件东西，让它替你说话',
    replyPlaceholder: '写一句话，跟他一起回去（可留空）',
    replySend: '把回信寄回去',
    replyCancel: '再想想',
    replyOk: '回信已经装好了',
    replyCopy: '复制回信链接',
    replyClose: '留在这里',
    replyTip: '把这条链接发回给他 —— 他会看到自己的世界被你走过之后的样子',

    // —— 创作者面板 ——
    createTitle: '寄一个世界给你',
    createSub: 'POSTCARD WORLD · 60 秒做，送一个人',
    lblWho: '送给谁',
    phWho: '比如：小时候的自己',
    lblMsg: '想对他说的一句话',
    phMsg: '这句话会藏在这个世界的中心，只有他走进去才会看见。',
    lblSky: '天色',
    lblPalette: '放点什么进去（选中后，点地面放置）',
    btnClear: '清空摆放',
    btnPreview: '以收件人视角看看',
    lblLinkHow: '这条链接怎么用',
    capShare: '发给他 · 封存这条世界',
    capKeep: '留给自己 · 让它自己变老',
    capLiveShare: '现在这条是礼物：他几时打开，都是你封存它的那一天。',
    capLiveKeep0: '已封存：从今天起，它会自己变老。过几天再打开看看。',
    capLiveKeep: (d) => `已封存 ${d} 天 —— 草比那天密了，颜色也在往秋天走。`,
    tipLine1: '拖动旋转 · 滚轮缩放 · 点地面放置或移动物件',
    tipLine2: '这个世界只有 6.5 米宽——礼物不需要很大。',
    modelLangNote: '（创作者面板的长句说明仅提供中文）',
    langSwitch: 'EN',            // 按钮上写"按下去会变成什么"
    langSwitchTitle: 'Switch to English',

    // —— 明信片（存下来的那张图，文字是烧进像素的，所以必须跟着语言走）——
    postcardTo: (n) => '给 ' + n,
    postcardToYou: '给你',
    postcardFooter: 'Postcard World · 寄一个世界给你',

    // —— 动态提示 ——
    toastCopied: '链接已复制，去发给他吧',
    toastCopiedCapsule: '封存好了 —— 它从今天起自己变老',
    toastCopiedAlready: '已经是时间胶囊了',
    toastTooLong: '链接超长，先删点东西',
    toastCopyFail: '复制失败，请手动选中上面的链接',
    toastLimit: (n) => `一个世界最多放 ${n} 件，先拿掉一件再放`,
    noticeBroken: '这个链接好像被截断了，先给你看一个样例世界。',
    toastReplyCopied: '回信链接已复制，发回给他吧',
    toastReplyCopyFail: '请手动复制上面的链接',
    budgetOk: (len, max) => `链接长度 ${len} / ${max}`,
    budgetWarn: (len) => `链接太长了（${len}），请把话或物件删一点`,

    // —— 天色 / 物件（创作面板与世界里都用到）——
    skies: ['黄昏', '深夜', '落雨', '初雪', '黎明', '正午', '雨后', '星夜'],
    objects: ['一盏旧灯', '一封没寄的信', '一把空椅子', '一株长歪的树', '一只旧钟', '一辆自行车',
      '一块石头', '一只纸船', '一支蜡烛', '一只纸灯笼', '一盏小油灯', '一朵野花', '一截木桩', '一块苔石'],
    replyChoices: ['让纸船漂回去', '把蜡烛留在这里', '把信还给他'],
    replyHints: ['那句话说的就是它', '让它替你亮着', '有些话该还回去']
  },

  en: {
    // —— Intro veil ——
    introLine: 'Someone left a world for you',
    introLineDemo: 'First, see what it is',
    introNameDemo: 'A world someone received',
    introNameGeneric: 'For someone',
    giveTo: (n) => 'For ' + n,
    giveToYou: 'For you',
    preparing: 'Preparing…',
    enter: 'Walk in',
    hintKeys: 'Drag to look · WASD or ↑↓ to walk · hold "Forward" on mobile',
    demoNote: 'This is a world someone made for another person, and they walked into it. '
      + 'You can make one too, and give it to someone.',
    demoCreate: 'Make one myself →',
    waitLine: (d) => (d === 1 ? 'This world has been waiting 1 day' : `This world has been waiting ${d} days`),

    // —— HUD ——
    walk: 'Hold to walk',
    reply: 'Write back',
    postcard: 'Save a postcard',
    soundOn: 'Sound: on',
    soundOff: 'Sound: off',
    createNew: 'Make a world too',

    // —— Reply ——
    replyTitle: 'Write a letter back',
    replySub: 'Pick one thing and let it speak for you',
    replyPlaceholder: 'Say something and travel back with them (can be empty)',
    replySend: 'Send the reply back',
    replyCancel: 'Not yet',
    replyOk: 'Your reply is ready',
    replyCopy: 'Copy reply link',
    replyClose: 'Stay here',
    replyTip: 'Send this link back to them — they will see their world after you walked through it',

    // —— Creator panel ——
    createTitle: 'Postcard World',
    createSub: 'MAKE IT IN 60 SECONDS · GIVE IT TO ONE PERSON',
    lblWho: 'For whom',
    phWho: 'e.g. my childhood self',
    lblMsg: 'One sentence for them',
    phMsg: 'It hides at the centre of this world. They only see it after walking in.',
    lblSky: 'Sky',
    lblPalette: 'Place something (pick one, then click the ground)',
    btnClear: 'Clear all',
    btnPreview: 'See it as they will',
    lblLinkHow: 'What this link does',
    capShare: 'Send it · seal this world',
    capKeep: 'Keep it · let it grow old',
    capLiveShare: 'This one is a gift: whenever they open it, it is the day you sealed it.',
    capLiveKeep0: 'Sealed. From today it starts growing old on its own — come back in a few days.',
    capLiveKeep: (d) => `Sealed ${d} day${d === 1 ? '' : 's'} ago — the grass is thicker and the colour is turning.`,
    tipLine1: 'Drag to rotate · scroll to zoom · click the ground to place or move',
    tipLine2: 'This world is only 6.5 metres wide — a gift does not need to be big.',
    modelLangNote: '(Longer explanatory notes in the creator panel are in Chinese only.)',
    langSwitch: '中文',
    langSwitchTitle: '切换到中文',

    // —— Postcard（存下来的那张图，文字烧进像素，所以必须跟着语言走）——
    postcardTo: (n) => 'For ' + n,
    postcardToYou: 'For you',
    postcardFooter: 'Postcard World',

    // —— Toasts / notices ——
    toastCopied: 'Link copied — go send it',
    toastCopiedCapsule: 'Sealed — it starts growing old today',
    toastCopiedAlready: 'Already a time capsule',
    toastTooLong: 'Link too long — remove something first',
    toastCopyFail: 'Copy failed, please select the link above',
    toastLimit: (n) => `A world holds up to ${n} things — remove one first`,
    noticeBroken: 'That link looks truncated — here is a sample world instead.',
    toastReplyCopied: 'Reply link copied — send it back to them',
    toastReplyCopyFail: 'Please copy the link above manually',
    budgetOk: (len, max) => `Link length ${len} / ${max}`,
    budgetWarn: (len) => `Link too long (${len}) — shorten the sentence or remove something`,

    // —— Skies / objects ——
    skies: ['Dusk', 'Deep night', 'Rain', 'First snow', 'Dawn', 'Noon', 'After rain', 'Star night'],
    objects: ['An old lamp', 'An unsent letter', 'An empty chair', 'A leaning tree', 'An old clock',
      'A bicycle', 'A stone', 'A paper boat', 'A candle', 'A paper lantern', 'A small oil lamp',
      'A wild flower', 'A tree stump', 'A mossy stone'],
    replyChoices: ['Send the paper boat back', 'Leave the candle here', 'Give the letter back'],
    replyHints: ['It is the thing the sentence spoke of', 'Let it keep burning for you',
      'Some words should be returned']
  }
};

/* 天色与物件的**顺序**必须与 state.js 的 SKIES / OBJECTS 一致，
   否则英文界面会把"黄昏"标成 "Rain"。tools/verify-lang.mjs 有断言守着这一点。 */

const KEY = 'pw.lang';

export function detectLang() {
  const q = new URLSearchParams(location.search).get('lang')
    || (/[?&]lang=([a-zA-Z-]+)/.exec(location.hash)?.[1] ?? null);
  if (q) return /^zh/i.test(q) ? 'zh' : 'en';
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch { /* 隐私模式下 localStorage 会抛，忽略即可 */ }
  return /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
}

export const lang = detectLang();

/** 取一条文案。缺 key 时**回落到中文**并原样返回 key —— 宁可露出中文，也不要空字符串 */
export function t(key, ...args) {
  const v = DICT[lang]?.[key] ?? DICT.zh[key];
  if (v === undefined) return key;
  return typeof v === 'function' ? v(...args) : v;
}

/** 按 state.js 的顺序取天色/物件的本地化名字。id 与下标由调用方保证对应。 */
export const skyName = (i) => t('skies')[i] ?? t('skies')[0];
export const objectName = (i) => t('objects')[i] ?? t('objects')[0];

export function setLang(next) {
  try { localStorage.setItem(KEY, next); } catch { /* 忽略 */ }
  const url = new URL(location.href);
  url.searchParams.set('lang', next);
  location.assign(url.toString());
}

/** 把 DOM 上带 data-i18n* 的节点填好。可重复调用（构建 UI 之后要再跑一次）。 */
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  document.documentElement.lang = lang === 'zh' ? 'zh' : 'en';
}
