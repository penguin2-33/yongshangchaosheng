/* =====================================================================
 * 甬上潮声 · Tide of Yongshang
 * 手势控潮 —— 手掌高度 = 潮位，潮涨船行；左右挥手，穿越四段港城时光
 * MediaPipe Hands + Canvas 2D + Web Audio
 * 视觉与音乐全部程序化生成，零素材依赖；宣纸/淡墨/朱砂的克制版式
 * ===================================================================== */

/* ---------------- 可调参数（集中配置，便于调参） ---------------- */
const CONFIG = {
  // 潮位弹簧：比花开略慢，潮水要有分量
  spring: { k: 26, d: 8.2 },
  // 掌心（中指根）y 坐标映射区间：手在胸口高度即有明显潮位，抬到肩以上满潮
  tide: { bottomY: 0.80, topY: 0.38 },
  // 挥手换时代判定（任一只手，左右方向皆可）
  swipe: { dist: 0.22, windowMs: 750, cooldownMs: 1100 },
  hands: { swap: false },
  camera: { width: { ideal: 1280 }, height: { ideal: 720 } },
  mp: {
    bundle:    "./vendor/mediapipe/vision_bundle.mjs",
    bundleAlt: "./vendor/mediapipe/vision_bundle.js",
    wasm:      "./vendor/mediapipe/wasm",
    model:     "./vendor/models/hand_landmarker.task",
  },
  transitionDur: 1.9,   // 换时代：整幅海天一起渡过去
  handAway: { holdMs: 1200, rest: 0.25 },
  demo: { scale: 1.12 },
  musicGain: 0.9,
};

/* ---------------- 小工具 ---------------- */
const clamp01 = v => Math.min(1, Math.max(0, v));
const smooth  = v => { v = clamp01(v); return v * v * (3 - 2 * v); };
const lerp    = (a, b, k) => a + (b - a) * k;
const mix3    = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
const rgba    = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const TAU = Math.PI * 2;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const params = new URLSearchParams(location.search);
const lockTide = (() => {
  const raw = params.get("tide") != null ? params.get("tide") : params.get("bloom");
  const v = parseFloat(raw);
  return Number.isFinite(v) ? clamp01(v) : null;
})();
const lockEra = (() => {
  const v = parseInt(params.get("f"), 10);
  return Number.isFinite(v) ? v : null;
})();
const STILL = params.get("still") === "1";   // 截图/静态检查：不请求摄像头与音频
const DEMO_START = params.get("demo") === "1";

/* ---------------- 全局状态 ---------------- */
const state = {
  time: 0,
  tide: 0,
  tideVel: 0,
  manualTide: 0,
  spaceHeld: false,
  shipX: 0.5, shipXVel: 0, dragShipX: null,
  eraIndex: 0,
  transition: null,
  particles: [],
  partAcc: 0,
  burst: [],
  hands: { right: null, left: null },
  handSeen: { right: 0, left: 0 },
  handCount: 0,
  mode: "loading",
  libraryError: "",
  demo: false,
  still: STILL,
  noHandSince: 0,
  lastTideAudio: 0,
  visited: new Set(),   // 已到访时代（印章收集）
  sealPop: {},          // 每枚印章点亮时刻（弹出动画）
};

/* ---------------- DOM ---------------- */
const stage   = document.getElementById("stage");
const ctx     = stage.getContext("2d");
const video   = document.getElementById("cam");
const skel    = document.getElementById("skel");
const skelCtx = skel.getContext("2d");
const el = {
  nameZh:     document.getElementById("flowerNameZh"),
  epoch:      document.getElementById("flowerSeason"),
  quote:      document.getElementById("flowerQuote"),
  camWrap:    document.getElementById("camWrap"),
  toast:      document.getElementById("toast"),
  gate:       document.getElementById("gate"),
  startBtn:   document.getElementById("startBtn"),
  soundBtn:   document.getElementById("soundBtn"),
  muteGlyph:  document.getElementById("muteGlyph"),
  reveal:     document.getElementById("reveal"),
  blackout:   document.getElementById("blackout"),
  errDetail:  document.getElementById("errDetail"),
  tagLeft:    document.getElementById("tagLeft"),
  tagRight:   document.getElementById("tagRight"),
  shipInfo:   document.getElementById("shipInfo"),
  shipName:   document.getElementById("shipName"),
  shipEra:    document.getElementById("shipEra"),
  shipFacts:  document.getElementById("shipFacts"),
};

let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth; H = window.innerHeight;
  stage.width = W * DPR; stage.height = H * DPR;
  stage.style.width = W + "px"; stage.style.height = H + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.imageSmoothingQuality = "high";
}
window.addEventListener("resize", resize);
resize();

/* =====================================================================
 * 四时代氛围参数：晨雾青灰 / 缃黄金岸 / 暮蓝汽灯 / 钢蓝工业
 * =================================================================== */
const LOOKS = [
  { // 河姆渡 · 晨雾
    skyTop: [231, 236, 233], skyBot: [214, 224, 219],
    light: [255, 246, 226], lightA: 0.30, lightX: 0.28, lightY: 0.20, lightR: 0.82,
    seaHi: [148, 166, 158], seaLo: [92, 112, 104],
    foam: [244, 248, 244], mist: [236, 241, 237], mistA: 0.30,
    ink: [56, 66, 60], accent: [96, 116, 106], textAccent: [86, 104, 94],
    particle: "mist", partCol: [210, 220, 214], partA: 0.20,
    vignette: [50, 62, 56], vignetteA: 0.17, paperMul: 0.042, grain: 0.032,
  },
  { // 唐宋 · 缃黄金岸
    skyTop: [247, 236, 210], skyBot: [240, 219, 180],
    light: [255, 213, 140], lightA: 0.40, lightX: 0.66, lightY: 0.24, lightR: 0.84,
    seaHi: [172, 164, 128], seaLo: [104, 104, 82],
    foam: [250, 244, 224], mist: [246, 232, 200], mistA: 0.24,
    ink: [74, 58, 38], accent: [168, 120, 58], textAccent: [128, 92, 42],
    particle: "gull", partCol: [90, 74, 52], partA: 0.5,
    vignette: [78, 62, 36], vignetteA: 0.16, paperMul: 0.045, grain: 0.034,
  },
  { // 近代 · 暮蓝汽灯
    skyTop: [212, 222, 230], skyBot: [188, 203, 214],
    light: [255, 199, 148], lightA: 0.36, lightX: 0.30, lightY: 0.30, lightR: 0.80,
    seaHi: [110, 128, 142], seaLo: [58, 76, 90],
    foam: [236, 242, 246], mist: [216, 226, 234], mistA: 0.26,
    ink: [38, 50, 60], accent: [150, 104, 58], textAccent: [62, 80, 96],
    particle: "spray", partCol: [220, 230, 236], partA: 0.34,
    vignette: [40, 54, 66], vignetteA: 0.19, paperMul: 0.040, grain: 0.031,
  },
  { // 今朝 · 钢蓝工业
    skyTop: [226, 234, 238], skyBot: [206, 218, 224],
    light: [238, 244, 249], lightA: 0.34, lightX: 0.72, lightY: 0.16, lightR: 0.86,
    seaHi: [106, 128, 140], seaLo: [54, 74, 86],
    foam: [242, 248, 250], mist: [224, 232, 236], mistA: 0.22,
    ink: [44, 56, 64], accent: [186, 96, 50], textAccent: [64, 88, 104],
    particle: "spray", partCol: [224, 234, 240], partA: 0.32,
    vignette: [44, 58, 68], vignetteA: 0.18, paperMul: 0.038, grain: 0.030,
  },
];

function mixLook(a, b, k) {
  return {
    skyTop: mix3(a.skyTop, b.skyTop, k),
    skyBot: mix3(a.skyBot, b.skyBot, k),
    light: mix3(a.light, b.light, k), lightA: lerp(a.lightA, b.lightA, k),
    lightX: lerp(a.lightX, b.lightX, k), lightY: lerp(a.lightY, b.lightY, k),
    lightR: lerp(a.lightR, b.lightR, k),
    seaHi: mix3(a.seaHi, b.seaHi, k), seaLo: mix3(a.seaLo, b.seaLo, k),
    foam: mix3(a.foam, b.foam, k),
    mist: mix3(a.mist, b.mist, k), mistA: lerp(a.mistA, b.mistA, k),
    ink: mix3(a.ink, b.ink, k), accent: mix3(a.accent, b.accent, k),
    textAccent: mix3(a.textAccent, b.textAccent, k),
    particle: k < 0.5 ? a.particle : b.particle,
    partCol: mix3(a.partCol, b.partCol, k), partA: lerp(a.partA, b.partA, k),
    vignette: mix3(a.vignette, b.vignette, k), vignetteA: lerp(a.vignetteA, b.vignetteA, k),
    paperMul: lerp(a.paperMul, b.paperMul, k), grain: lerp(a.grain, b.grain, k),
  };
}

/* =====================================================================
 * 四代船（程序化剪影，坐标：y=0 为水线，x 以船宽 1 为尺度）
 * =================================================================== */
function inkFill(c, look, a) { c.fillStyle = rgba(look.ink, a); }

function drawCanoe(c, t, tide, look) {
  // 舟体：两头尖，船腹吃水
  inkFill(c, look, 0.88);
  c.beginPath();
  c.moveTo(-0.95, -0.03);
  c.quadraticCurveTo(-0.5, -0.11, 0, -0.12);
  c.quadraticCurveTo(0.5, -0.11, 0.95, -0.04);
  c.quadraticCurveTo(0.45, 0.10, 0, 0.11);
  c.quadraticCurveTo(-0.45, 0.10, -0.95, -0.03);
  c.closePath(); c.fill();
  // 舟子
  inkFill(c, look, 0.90);
  c.beginPath(); c.arc(0.04, -0.35, 0.05, 0, TAU); c.fill();
  c.beginPath();
  c.moveTo(-0.05, -0.30);
  c.quadraticCurveTo(0.03, -0.375, 0.12, -0.30);
  c.quadraticCurveTo(0.10, -0.17, 0.06, -0.11);
  c.lineTo(-0.02, -0.11);
  c.quadraticCurveTo(-0.05, -0.21, -0.05, -0.30);
  c.closePath(); c.fill();
  // 桨：随节律划水
  const pa = Math.sin(t * 2.1) * 0.20;
  c.save();
  c.translate(0.14, -0.27);
  c.rotate(0.85 + pa);
  c.fillRect(0, -0.012, 0.55, 0.024);
  c.beginPath(); c.ellipse(0.60, 0, 0.075, 0.028, 0, 0, TAU); c.fill();
  c.restore();
}

function drawJunk(c, t, tide, look) {
  // 船体：船头高翘，船尾收
  inkFill(c, look, 0.90);
  c.beginPath();
  c.moveTo(-0.95, -0.02);
  c.quadraticCurveTo(-0.2, 0.10, 0.55, 0.06);
  c.quadraticCurveTo(0.85, 0.02, 1.0, -0.28);
  c.quadraticCurveTo(0.62, -0.13, 0.2, -0.11);
  c.quadraticCurveTo(-0.4, -0.10, -0.95, -0.02);
  c.closePath(); c.fill();
  // 三桅硬篷帆
  const masts = [
    { x: -0.48, h: 0.52, w: 0.30 },
    { x: 0.04,  h: 0.68, w: 0.36 },
    { x: 0.50,  h: 0.42, w: 0.27 },
  ];
  for (let mi = 0; mi < masts.length; mi++) {
    const m = masts[mi];
    inkFill(c, look, 0.92);
    c.fillRect(m.x - 0.013, -0.10 - m.h, 0.026, m.h);
    const sway = Math.sin(t * 1.25 + mi * 2.1) * 0.012;
    const sailTop = -0.10 - m.h + 0.05;
    const sailH = m.h - 0.12;
    const rows = 5;
    for (let i = 0; i < rows; i++) {
      const y0 = sailTop + (i / rows) * sailH;
      const hh = sailH / rows;
      const inset = (i === 0 || i === rows - 1) ? 0.022 : 0.004;
      c.globalAlpha = 0.80;
      c.beginPath();
      c.moveTo(m.x - m.w / 2 + inset + sway, y0);
      c.lineTo(m.x + m.w / 2 - inset + sway, y0 + hh * 0.14);
      c.lineTo(m.x + m.w / 2 - inset + sway, y0 + hh * 0.86);
      c.lineTo(m.x - m.w / 2 + inset + sway, y0 + hh);
      c.closePath();
      inkFill(c, look, 0.80);
      c.fill();
    }
    c.globalAlpha = 1;
  }
  // 主桅顶小旗
  const fx = 0.04, fy = -0.10 - 0.68 - 0.02;
  const fw = Math.sin(t * 3.1) * 0.02;
  c.beginPath();
  c.moveTo(fx, fy);
  c.lineTo(fx + 0.16, fy + 0.03 + fw);
  c.lineTo(fx, fy + 0.06);
  c.closePath();
  c.fillStyle = rgba(look.accent, 0.85);
  c.fill();
}

function drawSteamer(c, t, tide, look) {
  // 烟（先画，压在船后面）
  for (let i = 0; i < 5; i++) {
    const ph = (t * 0.45 + i * 0.2) % 1;
    c.globalAlpha = 0.14 * (1 - ph);
    inkFill(c, look, 1);
    c.beginPath();
    c.arc(0.02 - 0.10 - ph * 0.55, -0.66 - ph * 0.36, 0.05 + ph * 0.11, 0, TAU);
    c.fill();
  }
  c.globalAlpha = 1;
  // 船体
  inkFill(c, look, 0.90);
  c.beginPath();
  c.moveTo(-1.05, 0.02);
  c.lineTo(0.72, 0.02);
  c.quadraticCurveTo(1.02, -0.02, 1.12, -0.18);
  c.quadraticCurveTo(0.88, -0.15, 0.66, -0.15);
  c.lineTo(-0.96, -0.16);
  c.quadraticCurveTo(-1.03, -0.10, -1.05, 0.02);
  c.closePath(); c.fill();
  // 舱楼
  inkFill(c, look, 0.90);
  c.fillRect(-0.56, -0.31, 1.06, 0.16);
  c.fillRect(-0.30, -0.43, 0.62, 0.13);
  // 双烟囱（后倾）
  c.save(); c.translate(0.02, -0.43); c.rotate(-0.12);
  c.fillRect(-0.036, -0.23, 0.072, 0.23); c.restore();
  c.save(); c.translate(-0.30, -0.43); c.rotate(-0.12);
  c.fillRect(-0.034, -0.21, 0.068, 0.21); c.restore();
  // 舷窗
  c.fillStyle = rgba(look.foam, 0.55);
  for (let i = 0; i < 8; i++) {
    c.beginPath(); c.arc(-0.78 + i * 0.185, -0.075, 0.015, 0, TAU); c.fill();
  }
  // 舱楼窗
  for (let i = 0; i < 6; i++) {
    c.beginPath(); c.arc(-0.50 + i * 0.155, -0.375, 0.011, 0, TAU); c.fill();
  }
  // 船首浪
  c.strokeStyle = rgba(look.foam, 0.4 + tide * 0.35);
  c.lineWidth = 0.014;
  c.beginPath();
  c.moveTo(1.02, -0.02);
  c.quadraticCurveTo(1.22, -0.06, 1.30, -0.16 - tide * 0.06);
  c.stroke();
}

function drawContainer(c, t, tide, look) {
  const boxCols = ["#8a5a44", "#5a6a72", "#7d7d6c", "#96683a", "#4e5e66", "#6a5a52", "#7c6a56"];
  // 船体
  inkFill(c, look, 0.92);
  c.beginPath();
  c.moveTo(-1.15, 0.02);
  c.lineTo(0.92, 0.02);
  c.quadraticCurveTo(1.16, -0.03, 1.24, -0.22);
  c.lineTo(1.02, -0.19);
  c.lineTo(-1.06, -0.21);
  c.quadraticCurveTo(-1.14, -0.12, -1.15, 0.02);
  c.closePath(); c.fill();
  // 集装箱堆：三层退台
  let k = 0;
  c.globalAlpha = 0.88;
  for (let row = 0; row < 3; row++) {
    const y = -0.21 - row * 0.088;
    const n = 9 - row;
    for (let i = 0; i < n; i++) {
      c.fillStyle = boxCols[(k++ * 5 + row * 3) % boxCols.length];
      c.fillRect(-0.94 + i * 0.115, y - 0.078, 0.104, 0.078);
    }
  }
  c.globalAlpha = 1;
  // 驾驶桥楼（尾部）
  inkFill(c, look, 0.94);
  c.fillRect(0.66, -0.54, 0.17, 0.34);
  c.fillStyle = rgba(look.foam, 0.55);
  c.fillRect(0.69, -0.50, 0.11, 0.028);
  c.fillRect(0.69, -0.44, 0.11, 0.028);
  inkFill(c, look, 0.94);
  c.fillRect(0.73, -0.62, 0.012, 0.08);
  // 船首浪
  c.strokeStyle = rgba(look.foam, 0.35 + tide * 0.4);
  c.lineWidth = 0.016;
  c.beginPath();
  c.moveTo(1.10, -0.02);
  c.quadraticCurveTo(1.32, -0.07, 1.42, -0.18 - tide * 0.07);
  c.stroke();
}

/* =====================================================================
 * 四个时代
 * =================================================================== */
const ERAS = [
  { epoch: "上古", zh: "独木舟", quote: "七千年前，第一支独木舟推开了水",
    draw: drawCanoe, look: LOOKS[0] },
  { epoch: "唐宋", zh: "明州港", quote: "三江口帆樯林立，遣唐使从这里出海",
    draw: drawJunk, look: LOOKS[1] },
  { epoch: "近代", zh: "三江口", quote: "江北岸汽笛响起，宁波帮从这里出发",
    draw: drawSteamer, look: LOOKS[2] },
  { epoch: "今朝", zh: "东方大港", quote: "巨轮通四海，宁波舟山港昼夜不歇",
    draw: drawContainer, look: LOOKS[3] },
];

if (lockEra != null) state.eraIndex = ((lockEra % ERAS.length) + ERAS.length) % ERAS.length;
state.visited.add(state.eraIndex);
updateEraHUD();
prewarmParticles(ERAS[state.eraIndex].look, 26);

/* =====================================================================
 * Web Audio：程序化配乐 + 潮声（零素材）
 * 海浪 = 白噪→低通，随潮位涨落；四个时代各一套生成式乐句
 * =================================================================== */
const MUSIC = [
  { bpm: 46,  beatMin: 2.0, beatMax: 3.6, root: 110.00, scale: [0, 3, 5, 7, 10], type: "flute",  gain: 0.15, dur: 4.0 }, // 埙 · 远古
  { bpm: 66,  beatMin: 0.9, beatMax: 2.0, root: 220.00, scale: [0, 2, 4, 7, 9],  type: "pluck",  gain: 0.11, dur: 1.1 }, // 筝 · 唐宋
  { bpm: 58,  beatMin: 1.1, beatMax: 2.4, root: 196.00, scale: [0, 2, 4, 7, 9],  type: "mix",    gain: 0.12, dur: 1.8 }, // 丝竹 · 近代
  { bpm: 40,  beatMin: 1.6, beatMax: 3.0, root: 130.81, scale: [0, 2, 4, 7, 9],  type: "modern", gain: 0.09, dur: 3.2 }, // 电子 · 今朝
];

const audio = {
  ok: false, ctx: null, silent: false, master: null, send: null,
  ocean: { gain: null, filter: null },
  nextTime: 0, era: 0, step: 0,
  async init() {
    if (this.ctx) { this.ok = true; return true; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const c = (this.ctx = new AC());
      this.master = c.createGain(); this.master.gain.value = CONFIG.musicGain;
      const comp = c.createDynamicsCompressor();
      this.master.connect(comp); comp.connect(c.destination);
      // 简易延迟混响，给丝竹一点水汽
      const delay = c.createDelay(1.0); delay.delayTime.value = 0.38;
      const fb = c.createGain(); fb.gain.value = 0.30;
      const wet = c.createGain(); wet.gain.value = 0.20;
      delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(this.master);
      this.send = delay;
      // 海浪：循环白噪 → 低通
      const nb = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const d = nb.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src = c.createBufferSource(); src.buffer = nb; src.loop = true;
      const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 420; lp.Q.value = 0.4;
      const og = c.createGain(); og.gain.value = 0;
      src.connect(lp); lp.connect(og); og.connect(this.master);
      src.start();
      this.ocean = { gain: og, filter: lp };
      this.ok = true;
      this.nextTime = c.currentTime + 0.3;
      setInterval(() => this.schedule(), 140);
      return true;
    } catch (e) {
      this.ok = false;
      console.warn("音频初始化失败：", e);
      return false;
    }
  },
  setTide(t) {
    if (!this.ok || this.silent || !this.ocean.gain) return;
    const now = this.ctx.currentTime;
    this.ocean.gain.gain.setTargetAtTime(0.028 + 0.075 * t, now, 0.5);
    this.ocean.filter.frequency.setTargetAtTime(320 + 820 * t, now, 0.5);
  },
  setEra(i) { this.era = ((i % MUSIC.length) + MUSIC.length) % MUSIC.length; },
  /* 换时代音效：鼓 / 钟磬 / 汽笛 / 吊机金属声，全部合成 */
  eraCue(i) {
    if (!this.ok || this.silent) return;
    const t = this.ctx.currentTime + 0.06, c = this.ctx;
    if (i === 0) {          // 河姆渡：兽皮鼓闷响
      const o = c.createOscillator(); o.type = "sine";
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.5);
      const g = c.createGain();
      g.gain.setValueAtTime(0.4, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.65);
      o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.7);
    } else if (i === 1) {   // 唐宋：钟磬两声
      this.voiceBell(523.25, t, 0.16);
      this.voiceBell(783.99, t + 0.14, 0.10);
    } else if (i === 2) {   // 近代：汽笛长鸣
      const g = c.createGain(), f = c.createBiquadFilter();
      f.type = "bandpass"; f.frequency.value = 850; f.Q.value = 1.6;
      [220, 277].forEach(fr => {
        const o = c.createOscillator(); o.type = "sawtooth";
        o.frequency.value = fr; o.connect(f); o.start(t); o.stop(t + 1.2);
      });
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.14, t + 0.18);
      g.gain.setValueAtTime(0.14, t + 0.75);
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
      f.connect(g); g.connect(this.master);
    } else {                // 今朝：吊机金属声 + 低鸣
      this.voiceBell(1174.7, t, 0.12);
      this.voiceBell(1567.98, t + 0.07, 0.09);
      const o = c.createOscillator(); o.type = "square";
      o.frequency.setValueAtTime(90, t);
      o.frequency.linearRampToValueAtTime(60, t + 0.4);
      const g = c.createGain();
      g.gain.setValueAtTime(0.12, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.5);
    }
  },
  schedule() {
    if (!this.ok || this.silent || this.ctx.state !== "running") return;
    const cfg = MUSIC[this.era];
    const lookahead = this.ctx.currentTime + 0.7;
    while (this.nextTime < lookahead) {
      this.playNote(cfg, this.nextTime);
      this.nextTime += (60 / cfg.bpm) * (cfg.beatMin + Math.random() * (cfg.beatMax - cfg.beatMin));
    }
  },
  playNote(cfg, t) {
    const sc = cfg.scale;
    const semi = sc[(Math.random() * sc.length) | 0];
    if (cfg.type === "flute") {
      const f = cfg.root * Math.pow(2, semi / 12) * (Math.random() < 0.3 ? 2 : 1);
      this.voiceFlute(f, t, cfg.gain, cfg.dur);
    } else if (cfg.type === "pluck") {
      const f = cfg.root * (Math.random() < 0.5 ? 1 : 2) * Math.pow(2, semi / 12);
      this.voicePluck(f, t, cfg.gain);
    } else if (cfg.type === "mix") {
      if (Math.random() < 0.42) this.voiceFlute(cfg.root * 0.5 * Math.pow(2, semi / 12), t, cfg.gain, 2.4);
      else this.voicePluck(cfg.root * (Math.random() < 0.5 ? 1 : 2) * Math.pow(2, semi / 12), t, cfg.gain);
    } else { // modern
      if (this.step % 4 === 0) {
        const chord = [0, 7, 12, 16].map(s => cfg.root * Math.pow(2, s / 12));
        this.voicePad(chord, t, cfg.gain * 1.2, cfg.dur);
      } else if (Math.random() < 0.6) {
        this.voiceBell(cfg.root * 2 * Math.pow(2, semi / 12), t, cfg.gain * 0.9);
      }
      this.step++;
    }
  },
  voiceFlute(f, t, g, dur) {
    const c = this.ctx;
    const o = c.createOscillator(); o.type = "sine"; o.frequency.value = f;
    const o2 = c.createOscillator(); o2.type = "sine"; o2.frequency.value = f * 2;
    const og = c.createGain(), og2 = c.createGain(); og2.gain.value = 0.10;
    const vib = c.createOscillator(); vib.frequency.value = 4.6;
    const vg = c.createGain(); vg.gain.value = f * 0.006;
    vib.connect(vg); vg.connect(o.frequency);
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1200;
    o.connect(og); o2.connect(og2); og2.connect(og);
    og.connect(lp); lp.connect(this.master);
    if (this.send) { const sg = c.createGain(); sg.gain.value = 0.5; lp.connect(sg); sg.connect(this.send); }
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(g, t + 0.6);
    og.gain.setTargetAtTime(0, t + dur * 0.55, 0.9);
    const end = t + dur + 3;
    o.start(t); o2.start(t); vib.start(t);
    o.stop(end); o2.stop(end); vib.stop(end);
  },
  voicePluck(f, t, g) {
    const c = this.ctx;
    const o = c.createOscillator(); o.type = "triangle"; o.frequency.value = f;
    const og = c.createGain();
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2400;
    o.connect(og); og.connect(lp); lp.connect(this.master);
    if (this.send) { const sg = c.createGain(); sg.gain.value = 0.35; lp.connect(sg); sg.connect(this.send); }
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(g, t + 0.008);
    og.gain.exponentialRampToValueAtTime(0.0008, t + 1.4);
    o.start(t); o.stop(t + 1.5);
  },
  voiceBell(f, t, g) {
    const c = this.ctx;
    const parts = [[1, 1], [2.76, 0.4], [5.4, 0.16]];
    for (const [m, a] of parts) {
      const o = c.createOscillator(); o.type = "sine"; o.frequency.value = f * m;
      const og = c.createGain();
      o.connect(og); og.connect(this.master);
      og.gain.setValueAtTime(0, t);
      og.gain.linearRampToValueAtTime(g * a, t + 0.01);
      og.gain.exponentialRampToValueAtTime(0.0006, t + 2.2);
      o.start(t); o.stop(t + 2.4);
    }
  },
  voicePad(fs, t, g, dur) {
    const c = this.ctx;
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 620;
    const og = c.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(g, t + 1.4);
    og.gain.setTargetAtTime(0, t + dur, 1.2);
    lp.connect(og); og.connect(this.master);
    for (const f of fs) for (const det of [-6, 6]) {
      const o = c.createOscillator(); o.type = "sawtooth";
      o.frequency.value = f; o.detune.value = det;
      const vg = c.createGain(); vg.gain.value = 0.16;
      o.connect(vg); vg.connect(lp);
      o.start(t); o.stop(t + dur + 4);
    }
  },
  setSilent(s) {
    this.silent = s;
    if (!this.ok) return;
    if (s) {
      if (this.ctx.state === "running") this.ctx.suspend();
    } else if (!document.hidden && this.ctx.state === "suspended") {
      this.ctx.resume();
      this.nextTime = this.ctx.currentTime + 0.2;
    }
  },
  stopAll() { this.setSilent(true); },
  pageSuspend() {
    if (!this.ok) return;
    if (this.ctx.state === "running") this.ctx.suspend();
  },
  pageResume() {
    if (this.ok && !this.silent && !document.hidden && this.ctx.state === "suspended") {
      this.ctx.resume();
      this.nextTime = this.ctx.currentTime + 0.2;
    }
  },
};

/* =====================================================================
 * 手势识别（MediaPipe HandLandmarker）—— 加载逻辑保持不变
 * =================================================================== */
let landmarker = null, camReady = false, lastDetect = 0, camStream = null;
let visionLib = null, visionFileset = null;

const HAND_LINKS = [
  [0,1],[1,2],[2,3],[3,4], [0,5],[5,6],[6,7],[7,8], [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16], [13,17],[17,18],[18,19],[19,20], [0,17],
];

async function loadVisionLibrary() {
  const candidates = [CONFIG.mp.bundle, CONFIG.mp.bundleAlt].filter(Boolean);
  const problems = [];
  let lib = null;

  for (const url of candidates) {
    try {
      lib = await import(/* @vite-ignore */ url);
      break;
    } catch (e) {
      const line = `import("${url}") → ${e.name}: ${e.message}`;
      problems.push(line);
      console.error("[手势库]", line, e);
    }
  }

  if (!lib) {
    visionLib = null; visionFileset = null;
    state.libraryError = problems.join(" ｜ ");
    showErrorDetail(state.libraryError);
    return false;
  }
  if (!lib.FilesetResolver) {
    visionLib = null; visionFileset = null;
    state.libraryError = `模块已加载，但缺少 FilesetResolver 导出（bundle 入口可能取错了文件）`;
    showErrorDetail(state.libraryError);
    return false;
  }

  visionLib = lib;
  try {
    visionFileset = await lib.FilesetResolver.forVisionTasks(CONFIG.mp.wasm);
  } catch (e) {
    visionLib = null; visionFileset = null;
    state.libraryError = `FilesetResolver.forVisionTasks("${CONFIG.mp.wasm}") → ${e.name}: ${e.message}`;
    console.error("[手势库 wasm]", state.libraryError, e);
    showErrorDetail(state.libraryError);
    return false;
  }

  state.libraryError = "";
  hideErrorDetail();
  return true;
}

async function loadHandModel() {
  try {
    if (!visionLib || !visionFileset) return false;
    landmarker = await visionLib.HandLandmarker.createFromOptions(visionFileset, {
      baseOptions: { modelAssetPath: CONFIG.mp.model, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 2,
    });
    hideErrorDetail();
    return true;
  } catch (e) {
    const line = `HandLandmarker.createFromOptions("${CONFIG.mp.model}") → ${e.name}: ${e.message}`;
    state.libraryError = line;
    showErrorDetail(line);
    console.error("[模型]", line, e);
    landmarker = null;
    return false;
  }
}

async function initCamera() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return "unsupported";
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: CONFIG.camera.width, height: CONFIG.camera.height, facingMode: "user" },
      audio: false,
    });
    video.srcObject = stream;
    camStream = stream;
    await video.play();
    camReady = true;
    el.camWrap.classList.remove("hidden");
    return "ok";
  } catch (e) {
    console.warn("摄像头不可用：", e);
    const n = e && e.name;
    if (n === "NotAllowedError" || n === "SecurityError") return "denied";
    if (n === "NotFoundError" || n === "OverconstrainedError") return "notfound";
    return "error";
  }
}

function stopCamera() {
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  video.srcObject = null;
  camReady = false;
  if (el.camWrap) el.camWrap.classList.add("hidden");
}

async function resumeCamera() {
  if (state.mode !== "camera" || camReady || document.hidden) return;
  showToast("正在重新请求摄像头…", 0);
  const r = await initCamera();
  if (r === "ok") showToast("左手：上下控潮、左右移船；右手：快速一挥换船", 4600);
  else showToast(camFailMessage(r).text, 5200);
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise(res => setTimeout(() => res(false), ms))]);
}

const camFailMessage = reason => ({
  denied:      { text: "摄像头不可用/被拒绝", tip: "请在 Chrome 地址栏左侧的摄像头图标里改为「允许」，然后刷新页面。" },
  notfound:    { text: "摄像头不可用 · 未找到设备", tip: "请确认摄像头已连接且未被其他程序独占，然后重试。" },
  unsupported: { text: "摄像头不可用 · 当前环境不支持", tip: "请用 localhost 或 HTTPS 访问，并换用新版 Chrome。" },
  error:       { text: "摄像头不可用 · 取流失败", tip: "请关闭占用摄像头的其他程序后按 C 重新开启。" },
}[reason] || { text: "摄像头不可用", tip: "请检查设备与浏览器权限后重试。" });

/* 掌心高度 → 潮位：用中指根（掌心）比手腕稳，不受手指开合干扰 */
function calcTide(lm) {
  const y = lm[9].y;
  return clamp01((CONFIG.tide.bottomY - y) / (CONFIG.tide.bottomY - CONFIG.tide.topY));
}

/* 挥手检测：每只手独立轨迹，返回 +1/-1/0 */
function makeSwipe() {
  return {
    points: [], cooldownUntil: 0,
    update(x, now) {
      if (now < this.cooldownUntil) { this.points.length = 0; return 0; }
      this.points.push({ x, t: now });
      while (this.points.length && now - this.points[0].t > CONFIG.swipe.windowMs) this.points.shift();
      if (this.points.length >= 3) {
        const dx = this.points[this.points.length - 1].x - this.points[0].x;
        if (Math.abs(dx) > CONFIG.swipe.dist) {
          const dir = Math.sign(dx);
          this.cooldownUntil = now + CONFIG.swipe.cooldownMs;
          this.points.length = 0;
          return dir;
        }
      }
      return 0;
    },
  };
}
const swipeR = makeSwipe();   // 只用右手挥动切换时代（左手管潮位与船位）

function drawSkeleton(lm, color) {
  const w = skel.width, h = skel.height;
  skelCtx.strokeStyle = color; skelCtx.fillStyle = color;
  skelCtx.lineWidth = 4; skelCtx.lineCap = "round"; skelCtx.globalAlpha = 0.9;
  for (const [a, b] of HAND_LINKS) {
    skelCtx.beginPath();
    skelCtx.moveTo((1 - lm[a].x) * w, lm[a].y * h);
    skelCtx.lineTo((1 - lm[b].x) * w, lm[b].y * h);
    skelCtx.stroke();
  }
  for (const p of lm) {
    skelCtx.beginPath();
    skelCtx.arc((1 - p.x) * w, p.y * h, 6, 0, TAU);
    skelCtx.fill();
  }
  skelCtx.globalAlpha = 1;
}

function detect(now) {
  if (!landmarker || !camReady || video.readyState < 2 || now - lastDetect < 16) return;
  lastDetect = now;
  let res;
  try { res = landmarker.detectForVideo(video, now); } catch (e) { return; }
  state.hands.right = null; state.hands.left = null;
  state.handCount = 0;
  skelCtx.clearRect(0, 0, skel.width, skel.height);
  const lms = res.landmarks || [], hds = res.handedness || [];
  const labelOf = i => {
    let l = hds[i] && hds[i][0] ? hds[i][0].categoryName : "Right";
    if (CONFIG.hands.swap) l = l === "Left" ? "Right" : "Left";
    return l;
  };
  for (let i = 0; i < lms.length; i++) {
    const lm = lms[i];
    const label = labelOf(i);
    const tide = calcTide(lm);
    state.handCount++;
    if (label === "Left") {
      state.hands.left = { tide, x: 1 - lm[9].x, t: now };
      state.handSeen.left = now;
      drawSkeleton(lm, "#7fb3a8");   // 左手只管潮位与船位，不触发切换
    } else {
      state.hands.right = { tide, x: 1 - lm[9].x, t: now };
      state.handSeen.right = now;
      const dir = swipeR.update(1 - lm[9].x, now);
      if (dir) switchEra(dir);
      drawSkeleton(lm, "#c8552f");
    }
  }
}

/* =====================================================================
 * 换时代：整幅海天渡过去，浪花散开
 * =================================================================== */
function switchEra(dir) {
  if (state.transition) return;
  const from = state.eraIndex;
  state.eraIndex = (state.eraIndex + dir + ERAS.length) % ERAS.length;
  state.transition = { t: 0, from };
  spawnSplash();
  prewarmParticles(ERAS[state.eraIndex].look, 20);
  audio.setEra(state.eraIndex);
  audio.eraCue(state.eraIndex);
  state.visited.add(state.eraIndex);
  state.sealPop[state.eraIndex] = state.time;
  updateEraHUD();
}

/* =====================================================================
 * 船说：当前时代这条船的具体介绍（按 I 或点画面里的船呼出）
 * =================================================================== */
const SHIP_INFO = [
  { name: "独木舟", era: "上古 · 河姆渡", facts: [
    "约七千年前，河姆渡人已在使用木桨——田螺山遗址出土的木桨，是宁波先民驭水而行的最早物证。",
    "做法是「刳木为舟」：《周易》所谓把整段木头凿空成舟，再削木为桨。",
    "用途是在湖沼与近海捕鱼渡水，宁波的舟船文化由此起航。",
  ]},
  { name: "三桅硬篷帆船", era: "唐宋 · 明州港", facts: [
    "唐代明州设州，宋时设市舶司，明州港是对日本、高丽贸易的主要口岸。",
    "帆面用竹条横向加固、分成硬篷，可逆风打戗（走「之」字）行船。",
    "遣唐使与海上丝绸之路的货物，多从三江口扬帆出海。",
  ]},
  { name: "蒸汽轮船", era: "近代 · 三江口", facts: [
    "1844 年宁波开埠，江北岸辟为外滩，轮船取代了三江口的帆樯。",
    "以煤为薪、蒸汽驱动明轮与螺旋桨，行船不再看风使舵。",
    "宁波帮正是乘着这样的轮船去上海、闯南洋，从三江口走向四海。",
  ]},
  { name: "集装箱巨轮", era: "今朝 · 宁波舟山港", facts: [
    "宁波舟山港货物吞吐量连续多年位居全球第一，航线通达世界主要港口。",
    "巨轮以 TEU 计载，一船可装两万余标准箱，桥吊昼夜不息。",
    "船身后那道拱桥，正是舟山跨海大桥的剪影——巨轮出港即见大桥。",
  ]},
];

function renderShipInfo() {
  const info = SHIP_INFO[state.eraIndex], e = ERAS[state.eraIndex];
  el.shipName.textContent = info.name;
  el.shipEra.textContent = info.era + " — " + e.quote;
  el.shipFacts.textContent = "";
  for (const f of info.facts) {
    const li = document.createElement("li");
    li.textContent = f;
    el.shipFacts.appendChild(li);
  }
}

function toggleShipInfo(force) {
  const show = force != null ? force : el.shipInfo.classList.contains("hidden");
  if (show) { renderShipInfo(); el.shipInfo.classList.remove("hidden"); }
  else el.shipInfo.classList.add("hidden");
}

function updateEraHUD() {
  const e = ERAS[state.eraIndex];
  if (el.shipInfo && !el.shipInfo.classList.contains("hidden")) renderShipInfo();
  el.epoch.textContent = e.epoch;
  el.nameZh.textContent = e.zh;
  el.quote.textContent = e.quote;
  document.documentElement.style.setProperty("--season-accent", rgba(e.look.textAccent, 0.92));
  for (const node of [el.epoch, el.nameZh, el.quote]) {
    if (node && node.animate) {
      node.animate(
        [{ opacity: 0.15 }, { opacity: 1 }],
        { duration: 900, easing: "cubic-bezier(0.4, 0, 0.2, 1)" }
      );
    }
  }
}

/* =====================================================================
 * 粒子：海雾 / 浪花 / 沙鸥；换时代时船舷溅起一阵水花
 * =================================================================== */
function HORIZON() {
  // 潮位直接决定水线高度：潮涨整条水线上涌（远山、塔、桥吊随水线起落），潮落退下
  return H * lerp(0.72, 0.44, state.tide);
}

function spawnSplash() {
  const e = ERAS[state.eraIndex];
  const horizon = HORIZON();
  const S = Math.min(W, H) * 0.30;
  const bx = W * 0.5, by = horizon + H * 0.045;
  for (let i = 0; i < 22; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
    const sp = H * (0.14 + Math.random() * 0.30);
    state.burst.push({
      x: bx + (Math.random() - 0.5) * S * 1.6,
      y: by,
      vx: Math.cos(a) * sp * 0.5,
      vy: Math.sin(a) * sp,
      r: 1.4 + Math.random() * 2.6,
      t: 0, life: 0.9 + Math.random() * 0.7,
      col: Math.random() < 0.7 ? e.look.foam : e.look.accent,
    });
  }
}

function spawnParticle(look) {
  const kind = look.particle;
  let x = 0, y = 0, vx = 0, vy = 0, r = 0.002, life = 8, sway = 0.004;
  if (kind === "mist") {
    x = Math.random();
    y = Math.random() * 0.9;
    vx = 0.006 + Math.random() * 0.008;
    vy = (Math.random() - 0.5) * 0.002;
    r = 0.010 + Math.random() * 0.016;
    life = 7 + Math.random() * 6;
    sway = 0.002;
  } else if (kind === "spray") {
    // 船首浪花：潮位高时从船头附近溅起
    const horizon = HORIZON();
    const S = Math.min(W, H) * (0.13 + 0.21 * state.tide);
    x = W * 0.5 / W + (Math.random() - 0.5) * (S * 2.2 / W);
    x = clamp01(x);
    y = (horizon + H * 0.045) / H;
    vx = (Math.random() - 0.2) * 0.030;
    vy = -0.05 - Math.random() * 0.06;
    r = 0.0012 + Math.random() * 0.0016;
    life = 0.8 + Math.random() * 0.8;
    sway = 0.001;
  } else { // gull
    const fromLeft = Math.random() < 0.5;
    x = fromLeft ? -0.05 : 1.05;
    y = 0.12 + Math.random() * 0.30;
    vx = (fromLeft ? 1 : -1) * (0.012 + Math.random() * 0.012);
    vy = (Math.random() - 0.5) * 0.003;
    r = 0.006;
    life = 12 + Math.random() * 8;
    sway = 0.001;
  }
  state.particles.push({
    kind, x, y, vx, vy, r, life, age: 0, sway,
    ph: Math.random() * TAU,
    rgb: look.partCol.map(v => Math.min(255, v * (0.9 + Math.random() * 0.2))),
    baseA: look.partA * (0.7 + Math.random() * 0.6),
  });
}

function prewarmParticles(look, count) {
  for (let i = 0; i < count && state.particles.length < 60; i++) {
    spawnParticle(look);
    const p = state.particles[state.particles.length - 1];
    p.age = Math.random() * p.life * 0.4;
    if (p.kind === "mist") {
      p.x = Math.random();
      p.y = Math.random() * 0.9;
    }
  }
}

function updateParticles(dt, look, tide) {
  const RATE = { mist: 1.1, spray: 0, gull: 0.055 };
  let rate = RATE[look.particle] || 1;
  if (look.particle === "spray") rate = tide > 0.45 ? 10 * (tide - 0.45) * 2 : 0;
  state.partAcc += dt * rate;
  while (state.partAcc >= 1) {
    state.partAcc -= 1;
    if (state.particles.length < 60) spawnParticle(look);
  }

  for (let i = state.particles.length - 1; i >= 0; i--) {
    const p = state.particles[i];
    p.age += dt;
    p.x += (p.vx + Math.sin(state.time * 0.75 + p.ph) * p.sway) * dt;
    p.y += p.vy * dt;
    if (p.kind === "spray") p.vy += 0.22 * dt;   // 浪花有重力
    if (p.age > p.life || p.x < -0.10 || p.x > 1.10 || p.y < -0.10 || p.y > 1.10) {
      state.particles.splice(i, 1);
    }
  }

  for (let i = state.burst.length - 1; i >= 0; i--) {
    const p = state.burst[i];
    p.t += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += H * 0.5 * dt;      // 水花落回
    if (p.t > p.life) state.burst.splice(i, 1);
  }
}

function drawParticles(look) {
  const m = Math.min(W, H);
  for (const p of state.particles) {
    const fadeIn = Math.min(1, p.age / 1.1);
    const fadeOut = Math.min(1, (p.life - p.age) / 1.4);
    const a = p.baseA * fadeIn * fadeOut;
    if (a <= 0.01) continue;
    const x = p.x * W, y = p.y * H;
    if (p.kind === "gull") {
      // 沙鸥：一笔 V 字
      const flap = Math.sin(state.time * 6 + p.ph) * 2.6;
      ctx.strokeStyle = rgba(look.ink, a * 0.65);
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(x - 6, y - flap);
      ctx.quadraticCurveTo(x - 2, y + 2, x, y);
      ctx.quadraticCurveTo(x + 2, y + 2, x + 6, y - flap);
      ctx.stroke();
    } else {
      const radius = Math.max(0.6, p.r * m);
      ctx.fillStyle = rgba(p.rgb, a);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, TAU);
      ctx.fill();
    }
  }
}

function drawBurst() {
  for (const p of state.burst) {
    const a = Math.max(0, 1 - p.t / p.life);
    ctx.fillStyle = rgba(p.col, a * 0.6);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, TAU);
    ctx.fill();
  }
}

/* =====================================================================
 * 纸纹与颗粒（一次生成，不每帧重算）
 * =================================================================== */
let grainPat = null, paperTex = null;
function makeNoiseTextures() {
  const g = document.createElement("canvas");
  g.width = g.height = 128;
  const gc = g.getContext("2d");
  const id = gc.createImageData(128, 128);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = 128 + (Math.random() * 70 - 35) | 0;
    id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
    id.data[i + 3] = 255;
  }
  gc.putImageData(id, 0, 0);
  grainPat = ctx.createPattern(g, "repeat");

  const p = document.createElement("canvas");
  p.width = p.height = 256;
  const pc = p.getContext("2d");
  pc.fillStyle = "#f2eee4"; pc.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 760; i++) {
    pc.fillStyle = `rgba(${180 + Math.random() * 40 | 0},${170 + Math.random() * 40 | 0},${150 + Math.random() * 40 | 0},0.045)`;
    pc.beginPath();
    pc.arc(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 7, 0, TAU);
    pc.fill();
  }
  pc.strokeStyle = "rgba(120,108,88,0.045)";
  pc.lineWidth = 0.8;
  for (let i = 0; i < 120; i++) {
    const x = Math.random() * 256, y = Math.random() * 256;
    const a = Math.random() * TAU, l = 4 + Math.random() * 14;
    pc.beginPath(); pc.moveTo(x, y); pc.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); pc.stroke();
  }
  paperTex = p;
}
makeNoiseTextures();

/* =====================================================================
 * 背景：天空、主光、时代远景剪影、海面与波浪
 * =================================================================== */
function softEllipse(cx, cy, rx, ry, color, alpha) {
  if (alpha <= 0.001) return;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(Math.max(1, rx), Math.max(1, ry));
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(0.52, rgba(color, alpha * 0.38));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
  ctx.restore();
}

/* 时代远景剪影：山影 / 塔与帆影 / 江北岸楼影 / 桥吊群 */
function drawFarSilhouette(look, eraIdx) {
  const horizon = HORIZON();
  ctx.save();
  if (eraIdx === 0 || eraIdx === 1) {
    // 远山两叠
    ctx.fillStyle = rgba(look.ink, 0.12);
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    ctx.quadraticCurveTo(W * 0.18, horizon - H * 0.16, W * 0.42, horizon);
    ctx.lineTo(0, horizon); ctx.closePath(); ctx.fill();
    ctx.fillStyle = rgba(look.ink, 0.08);
    ctx.beginPath();
    ctx.moveTo(W * 0.55, horizon);
    ctx.quadraticCurveTo(W * 0.78, horizon - H * 0.12, W * 1.02, horizon);
    ctx.lineTo(W * 0.55, horizon); ctx.closePath(); ctx.fill();
  }
  if (eraIdx === 1) {
    // 塔影 + 远处两片帆影
    const px = W * 0.16, pw = H * 0.016, base = horizon - H * 0.012;
    ctx.fillStyle = rgba(look.ink, 0.22);
    for (let i = 0; i < 5; i++) {
      const tw = pw * (1 - i * 0.15);
      const ty = base - (H * 0.022) * (i + 1);
      ctx.fillRect(px - tw, ty, tw * 2, H * 0.022);
    }
    ctx.fillStyle = rgba(look.ink, 0.16);
    for (const [sx, ss] of [[0.68, 1], [0.80, 0.7]]) {
      ctx.beginPath();
      ctx.moveTo(W * sx, horizon - H * 0.004);
      ctx.quadraticCurveTo(W * sx + H * 0.018 * ss, horizon - H * 0.035 * ss, W * sx, horizon - H * 0.055 * ss);
      ctx.quadraticCurveTo(W * sx - H * 0.012 * ss, horizon - H * 0.030 * ss, W * sx, horizon - H * 0.004);
      ctx.closePath(); ctx.fill();
    }
  }
  if (eraIdx === 2) {
    // 江北岸：仓库楼群 + 一座尖顶（老外滩天主堂意象）
    ctx.fillStyle = rgba(look.ink, 0.16);
    const blocks = [[0.06, 0.045], [0.13, 0.065], [0.22, 0.04], [0.30, 0.055], [0.70, 0.05], [0.78, 0.07], [0.88, 0.045]];
    for (const [bx, bh] of blocks) ctx.fillRect(W * bx, horizon - H * bh, W * 0.075, H * bh);
    ctx.beginPath();
    ctx.moveTo(W * 0.60, horizon - H * 0.09);
    ctx.lineTo(W * 0.615, horizon - H * 0.15);
    ctx.lineTo(W * 0.63, horizon - H * 0.09);
    ctx.closePath(); ctx.fill();
    ctx.fillRect(W * 0.612, horizon - H * 0.15, W * 0.004, H * 0.02);
  }
  if (eraIdx === 3) {
    // 跨海大桥拱 + 三台桥吊
    ctx.strokeStyle = rgba(look.ink, 0.16);
    ctx.lineWidth = Math.max(2, H * 0.006);
    ctx.beginPath();
    ctx.moveTo(W * 0.10, horizon);
    ctx.quadraticCurveTo(W * 0.50, horizon - H * 0.20, W * 0.94, horizon);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(look.ink, 0.10);
    for (let i = 1; i <= 7; i++) {
      const k = i / 8;
      const bx = lerp(W * 0.10, W * 0.94, k);
      const byTop = (1 - k) * (1 - k) * horizon + 2 * (1 - k) * k * (horizon - H * 0.20) + k * k * horizon;
      ctx.beginPath(); ctx.moveTo(bx, byTop); ctx.lineTo(bx, horizon); ctx.stroke();
    }
    ctx.fillStyle = rgba(look.ink, 0.20);
    for (const cx of [0.22, 0.50, 0.78]) {
      const bx = W * cx;
      ctx.fillRect(bx, horizon - H * 0.11, W * 0.008, H * 0.11);
      ctx.save();
      ctx.translate(bx + W * 0.004, horizon - H * 0.11);
      ctx.rotate(-0.5);
      ctx.fillRect(0, -W * 0.004, W * 0.075, W * 0.008);
      ctx.restore();
    }
  }
  ctx.restore();
}

function drawWaves(look, tide, horizon, from, to) {
  const amp = H * (0.006 + 0.020 * tide);
  for (let k = from; k < to; k++) {
    const baseY = horizon + (H - horizon) * (0.10 + k * 0.17);
    const a = (0.10 + k * 0.055) * (0.55 + tide * 0.45);
    ctx.strokeStyle = rgba(look.foam, a);
    ctx.lineWidth = 1.1 + k * 0.5;
    const spd = (0.4 + k * 0.22) * (0.7 + 0.6 * tide);
    ctx.beginPath();
    for (let x = 0; x <= W; x += 14) {
      const y = baseY + Math.sin(x / (170 - k * 18) + state.time * spd + k * 2) * amp * (1 + k * 0.5)
              + Math.sin(x / (59 + k * 9) - state.time * spd * 1.5) * amp * 0.4;
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

/* 近岸涌浪：潮涨时整片海水向屏幕上方涌来，浪脊带白沫——这才是"潮起" */
function drawNearSwell(look, tide) {
  if (tide < 0.02) return;
  const top = lerp(H * 1.02, H * 0.70, tide);
  const wob = H * 0.012 * (0.4 + tide);
  const yAt = x => top
    + Math.sin(x / 90 + state.time * 1.6) * wob
    + Math.sin(x / 47 - state.time * 2.3) * wob * 0.5;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, H + 2);
  for (let x = 0; x <= W; x += 12) x === 0 ? ctx.lineTo(0, yAt(0)) : ctx.lineTo(x, yAt(x));
  ctx.lineTo(W, H + 2);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, top - H * 0.02, 0, H);
  g.addColorStop(0, rgba(look.seaHi, 0.55));
  g.addColorStop(0.3, rgba(look.seaLo, 0.92));
  g.addColorStop(1, rgba(look.seaLo, 1));
  ctx.fillStyle = g;
  ctx.fill();
  // 浪脊白沫
  ctx.strokeStyle = rgba(look.foam, 0.32 + 0.28 * tide);
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 12) x === 0 ? ctx.moveTo(0, yAt(0)) : ctx.lineTo(x, yAt(x));
  ctx.stroke();
  // 涌浪内部的暗纹
  ctx.strokeStyle = rgba(look.foam, 0.10 + 0.08 * tide);
  ctx.lineWidth = 1;
  for (let j = 1; j <= 3; j++) {
    ctx.beginPath();
    for (let x = 0; x <= W; x += 14) {
      const y = top + j * H * 0.045 + Math.sin(x / (110 - j * 20) - state.time * (1.2 + j * 0.4)) * wob * (1 - j * 0.18);
      x === 0 ? ctx.moveTo(0, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawBackground(look, tide, eraIdx) {
  const horizon = HORIZON();
  // 天空
  const g = ctx.createLinearGradient(0, 0, 0, horizon);
  g.addColorStop(0, rgba(look.skyTop, 1));
  g.addColorStop(1, rgba(look.skyBot, 1));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, horizon + 2);
  // 主光：日/月悬在天上
  const lx = W * look.lightX, ly = H * look.lightY;
  const lr = Math.max(W, H) * look.lightR;
  const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr);
  lg.addColorStop(0, rgba(look.light, look.lightA));
  lg.addColorStop(0.52, rgba(look.light, look.lightA * 0.32));
  lg.addColorStop(1, rgba(look.light, 0));
  ctx.fillStyle = lg;
  ctx.fillRect(0, 0, W, horizon + 2);
  // 时代远景
  drawFarSilhouette(look, eraIdx);
  // 海面
  const sg = ctx.createLinearGradient(0, horizon, 0, H);
  sg.addColorStop(0, rgba(look.seaHi, 1));
  sg.addColorStop(1, rgba(look.seaLo, 1));
  ctx.fillStyle = sg;
  ctx.fillRect(0, horizon, W, H - horizon);
  // 天光在海面的反光
  softEllipse(W * look.lightX, horizon + H * 0.05, W * 0.20, H * 0.05, look.light, 0.10 + tide * 0.08);
  // 远处波浪（船后面）
  drawWaves(look, tide, horizon, 0, 3);
}

/* =====================================================================
 * 船：潮位驱动远近与大小，随浪起伏，带倒影与吃水
 * =================================================================== */
function drawShipAt(eraIdx, tide, alpha, extraScale = 1) {
  if (alpha <= 0.002) return;
  const era = ERAS[eraIdx];
  const look = era.look;
  const horizon = HORIZON();
  const S = Math.min(W, H) * (0.13 + 0.21 * tide) * extraScale;
  const bob = Math.sin(state.time * 1.05) * 3.2 * (0.35 + tide) + Math.sin(state.time * 0.47) * 2.0;
  const tilt = Math.sin(state.time * 0.72) * 0.015 * (0.4 + tide) + (tide - 0.5) * 0.02;
  const x = state.shipX * W + Math.sin(state.time * 0.3) * W * 0.006 * tide, y = horizon + H * 0.045 + bob;

  // 倒影（先画，压在船与水线之下）
  ctx.save();
  ctx.globalAlpha = alpha * 0.16;
  ctx.translate(x, y);
  ctx.scale(S, -S * 0.38);
  era.draw(ctx, state.time, tide, look);
  ctx.restore();

  // 本体
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(tilt);
  ctx.scale(S, S);
  era.draw(ctx, state.time, tide, look);
  ctx.restore();

  // 吃水：一道海水渐变把船底压进水里
  const wl = ctx.createLinearGradient(0, y - 2, 0, y + S * 0.18);
  wl.addColorStop(0, rgba(look.seaHi, 0.0));
  wl.addColorStop(0.45, rgba(look.seaHi, 0.72));
  wl.addColorStop(1, rgba(look.seaLo, 0.95));
  ctx.fillStyle = wl;
  ctx.fillRect(x - S * 1.7, y - 2, S * 3.4, S * 0.20);
  // 船底白色水线
  ctx.strokeStyle = rgba(look.foam, 0.28 * alpha * (0.4 + tide));
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x - S * 1.1, y + S * 0.02);
  ctx.quadraticCurveTo(x, y + S * 0.055, x + S * 1.1, y + S * 0.02);
  ctx.stroke();
}

function drawVignette(look) {
  const cx = W / 2, cy = H * 0.52;
  const vg = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.36, cx, cy, Math.max(W, H) * 0.84);
  vg.addColorStop(0, rgba(look.vignette, 0));
  vg.addColorStop(0.72, rgba(look.vignette, look.vignetteA * 0.28));
  vg.addColorStop(1, rgba(look.vignette, look.vignetteA));
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
}

function drawPaper(look) {
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = look.paperMul;
  ctx.drawImage(paperTex, 0, 0, W, H);
  ctx.globalCompositeOperation = "overlay";
  ctx.globalAlpha = look.grain;
  const ox = (Math.random() * 128) | 0, oy = (Math.random() * 128) | 0;
  ctx.translate(-ox, -oy);
  ctx.fillStyle = grainPat;
  ctx.fillRect(0, 0, W + 128, H + 128);
  ctx.restore();
}

/* =====================================================================
 * 渲染主循环
 * =================================================================== */
function currentLook() {
  const tr = state.transition;
  if (tr) return mixLook(ERAS[tr.from].look, ERAS[state.eraIndex].look, smooth(tr.t));
  return ERAS[state.eraIndex].look;
}

function render(dt) {
  if (state.transition) {
    state.transition.t += dt / CONFIG.transitionDur;
    if (state.transition.t >= 1) state.transition = null;
  }

  const look = currentLook();
  updateParticles(dt, look, state.tide);

  drawBackground(look, state.tide, state.eraIndex);

  const tr = state.transition;
  if (tr && tr.t < 0.52) {
    const k = smooth(tr.t / 0.52);
    drawShipAt(tr.from, state.tide * (1 - 0.3 * k), 1 - k, 1 - 0.08 * k);
  }
  if (tr && tr.t > 0.42) {
    const k = smooth((tr.t - 0.42) / 0.58);
    drawShipAt(state.eraIndex, state.tide, k, 0.92 + 0.08 * k);
  } else if (!tr) {
    drawShipAt(state.eraIndex, state.tide, 1, 1);
  }

  // 近处波浪盖过船底，把船坐进海里；涌浪再从前景压上来
  drawWaves(look, state.tide, HORIZON(), 3, 5);
  drawNearSwell(look, state.tide);

  drawParticles(look);
  drawBurst();
  drawVignette(look);
  drawPaper(look);
}

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  state.time += dt;

  detect(now);

  /* 左右手标签：检测到亮起，丢失后保持约 400ms 再变暗，防抖 */
  const HOLD = 400;
  if (el.tagLeft)  el.tagLeft.classList.toggle("on",  now - state.handSeen.left  < HOLD);
  if (el.tagRight) el.tagRight.classList.toggle("on", now - state.handSeen.right < HOLD);

  let target;
  if (state.mode === "camera") {
    // 只有左手控制潮位（右手专职切船）
    const lFresh = state.hands.left && now - state.hands.left.t < 400;
    if (lFresh) {
      target = state.hands.left.tide;
      state.noHandSince = 0;
    } else {
      if (!state.noHandSince) state.noHandSince = now;
      const gone = (now - state.noHandSince) / 1000;
      target = gone > CONFIG.handAway.holdMs / 1000
        ? (state.tide > CONFIG.handAway.rest ? CONFIG.handAway.rest : state.tide)
        : state.tide;
    }
  } else {
    target = state.manualTide;
  }
  if (state.spaceHeld) target = 1;   // 空格随时可用：按住即满潮，松手回到原控制

  if (lockTide != null) {
    state.tide = lockTide;
    state.tideVel = 0;
  } else {
    state.tideVel += (target - state.tide) * CONFIG.spring.k * dt;
    state.tideVel *= Math.exp(-CONFIG.spring.d * dt);
    state.tide = clamp01(state.tide + state.tideVel * dt);
    if (state.tide <= 0 || state.tide >= 1) state.tideVel = 0;
  }

  // 船的水平位置：跟随左手左右移动（弹簧平滑）；拖拽可接管；换时代时缓缓回中
  const lHandFresh = state.hands.left && now - state.hands.left.t < 400;
  let shipTarget = state.dragShipX;
  if (shipTarget == null && lHandFresh) shipTarget = Math.min(0.92, Math.max(0.08, state.hands.left.x));
  if (shipTarget == null && state.transition) shipTarget = 0.5;
  if (shipTarget != null) {
    state.shipXVel += (shipTarget - state.shipX) * 14 * dt;
    state.shipXVel *= Math.exp(-6.5 * dt);
    state.shipX += state.shipXVel * dt;
    if (state.shipX < 0.06) { state.shipX = 0.06; state.shipXVel = 0; }
    if (state.shipX > 0.94) { state.shipX = 0.94; state.shipXVel = 0; }
  }

  // 潮声跟随（节流）
  if (now - state.lastTideAudio > 200) {
    state.lastTideAudio = now;
    audio.setTide(state.tide);
  }

  render(dt);
  drawSeals();
  drawGauge();
  drawGuide(now);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* =====================================================================
 * 首次引导：虚手示范潮位/挥手 + 满潮参考虚线，约 12 秒后淡出
 * =================================================================== */
const guide = { start: 0, done: false };

function startGuide() {
  if (state.demo || state.still) return;
  guide.start = performance.now();
  guide.done = false;
}

function drawGhostHand(x, y, r, col) {
  ctx.fillStyle = col;
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(2, r * 0.32);
  ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  for (let i = 0; i < 4; i++) {
    const ang = -Math.PI / 2 + (i - 1.5) * 0.34;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(ang) * r * 0.9, y + Math.sin(ang) * r * 0.9);
    ctx.lineTo(x + Math.cos(ang) * r * 2.1, y + Math.sin(ang) * r * 2.1);
    ctx.stroke();
  }
}

function drawGuide(now) {
  if (guide.done || !guide.start) return;
  const t = (now - guide.start) / 1000;
  if (t > 12 || state.mode !== "camera" || state.demo) { guide.done = true; return; }
  const look = currentLook();
  const a = Math.min(1, t / 0.8) * (t > 10.5 ? (12 - t) / 1.5 : 1);
  if (a <= 0.02) return;
  ctx.save();
  ctx.textAlign = "center";
  const kai = '"Kaiti SC","STKaiti","KaiTi",serif';
  // 满潮参考虚线
  const highY = H * 0.44;
  ctx.setLineDash([3, 9]);
  ctx.strokeStyle = rgba(look.ink, 0.20 * a);
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(W * 0.06, highY); ctx.lineTo(W * 0.94, highY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = rgba(look.ink, 0.38 * a);
  ctx.font = Math.max(11, H * 0.016) + "px " + kai;
  ctx.fillText("满潮", W * 0.06 + 26, highY - 8);
  // 左侧：虚手上下示范（0–7s）
  if (t < 7) {
    const ga = a * Math.min(1, 7 - t);
    const gx = W * 0.13;
    const k = (Math.sin(t * 1.5 - Math.PI / 2) + 1) / 2;
    const gy = H * lerp(0.74, 0.30, k);
    ctx.setLineDash([2, 8]);
    ctx.strokeStyle = rgba(look.ink, 0.25 * ga);
    ctx.beginPath(); ctx.moveTo(gx, H * 0.28); ctx.lineTo(gx, H * 0.76); ctx.stroke();
    ctx.setLineDash([]);
    drawGhostHand(gx, gy, H * 0.017, rgba(look.ink, 0.55 * ga));
    ctx.fillStyle = rgba(look.ink, 0.66 * ga);
    ctx.font = Math.max(14, H * 0.022) + "px " + kai;
    ctx.fillText("左手抬高 · 潮涨", gx, H * 0.24);
    ctx.fillText("左右移动 · 船行", gx, H * 0.24 + H * 0.032);
  }
  // 右侧：虚手横扫示范（4–12s）
  if (t > 4) {
    const t2 = t - 4;
    const ga = a * Math.min(1, t2 / 0.8);
    const gy = H * 0.40;
    const sweep = Math.sin(t2 * 1.7 - Math.PI / 2);
    const gx = W * (0.87 + sweep * 0.045);
    ctx.setLineDash([2, 8]);
    ctx.strokeStyle = rgba(look.ink, 0.25 * ga);
    ctx.beginPath(); ctx.moveTo(W * 0.80, gy); ctx.lineTo(W * 0.94, gy); ctx.stroke();
    ctx.setLineDash([]);
    drawGhostHand(gx, gy, H * 0.017, rgba(look.ink, 0.55 * ga));
    ctx.fillStyle = rgba(look.ink, 0.66 * ga);
    ctx.font = Math.max(14, H * 0.022) + "px " + kai;
    ctx.fillText("右手快速一挥 · 换时代", W * 0.87, gy - H * 0.06);
  }
  ctx.restore();
}

/* =====================================================================
 * 四时代印章收集：右上角一列篆刻方印，到访即盖下；集齐泛印泥红光
 * =================================================================== */
const SEAL_CHARS = ["独", "明", "三", "东"];

function drawSeals() {
  if (state.demo || state.still) return;
  const look = currentLook();
  const s = Math.min(W, H) * 0.032;
  const x = W - s - Math.max(16, W * 0.014);
  let y = H * 0.10;
  const done = state.visited.size >= ERAS.length;
  if (done) {
    ctx.fillStyle = rgba(ERAS[3].look.accent, 0.08);
    ctx.beginPath();
    ctx.arc(x + s / 2, y + s * 2.13, s * 2.9, 0, TAU);
    ctx.fill();
  }
  for (let i = 0; i < ERAS.length; i++) {
    const on = state.visited.has(i);
    const k = state.sealPop[i] ? Math.max(0, 1 - (state.time - state.sealPop[i]) / 0.55) : 0;
    const sc = 1 + 0.9 * k * k;
    ctx.save();
    ctx.translate(x + s / 2, y + s / 2);
    ctx.scale(sc, sc);
    if (on) {
      ctx.fillStyle = rgba(ERAS[3].look.accent, 0.90);
      ctx.fillRect(-s / 2, -s / 2, s, s);
      ctx.strokeStyle = "rgba(255,248,240,0.55)";
      ctx.lineWidth = 1;
      ctx.strokeRect(-s / 2 + 2.5, -s / 2 + 2.5, s - 5, s - 5);
      ctx.fillStyle = "rgba(255,250,244,0.95)";
    } else {
      ctx.strokeStyle = rgba(look.ink, 0.22);
      ctx.lineWidth = 1.2;
      ctx.strokeRect(-s / 2, -s / 2, s, s);
      ctx.fillStyle = rgba(look.ink, 0.22);
    }
    ctx.font = Math.round(s * 0.62) + 'px "Kaiti SC","STKaiti","KaiTi",serif';
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(SEAL_CHARS[i], 0, 1);
    ctx.restore();
    y += s * 1.42;
  }
}

/* =====================================================================
 * 水墨潮位计：左侧细墨刻度尺，朱砂圆点实时指示潮位
 * =================================================================== */
function drawGauge() {
  if (state.demo || state.still) return;
  const look = currentLook();
  const x = Math.max(18, W * 0.02);
  const y0 = H * 0.16, y1 = H * 0.78;
  ctx.strokeStyle = rgba(look.ink, 0.30);
  ctx.fillStyle = rgba(look.ink, 0.30);
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
  for (let i = 0; i <= 10; i++) {
    const ty = lerp(y0, y1, i / 10);
    const len = i % 5 === 0 ? 9 : 4;
    ctx.beginPath(); ctx.moveTo(x, ty); ctx.lineTo(x + len, ty); ctx.stroke();
  }
  const my = lerp(y1, y0, state.tide);
  ctx.fillStyle = rgba(ERAS[3].look.accent, 0.85);
  ctx.beginPath(); ctx.arc(x, my, 3.2, 0, TAU); ctx.fill();
  ctx.strokeStyle = rgba(ERAS[3].look.accent, 0.5);
  ctx.beginPath(); ctx.moveTo(x + 6, my); ctx.lineTo(x + 16, my); ctx.stroke();
  ctx.fillStyle = rgba(look.ink, 0.45);
  ctx.font = Math.round(Math.max(12, H * 0.016)) + 'px "Kaiti SC","STKaiti","KaiTi",serif';
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillText("潮", x, y1 + 10);
}

/* =====================================================================
 * 船票留念：按 S 把当前画面与时代信息合成一张"船票"并自动下载
 * =================================================================== */
function saveTicket() {
  const w = 1080, hb = 150, h = 620, body = h - hb;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  // 当前画面等比 cover 裁进票面上半
  const sw = stage.width, sh = stage.height;
  const k = Math.max(w / sw, body / sh);
  const cw = w / k, chh = body / k;
  g.drawImage(stage, (sw - cw) / 2, (sh - chh) / 2, cw, chh, 0, 0, w, body);
  // 票根带
  g.fillStyle = "#f3efe6"; g.fillRect(0, body, w, hb);
  g.strokeStyle = "rgba(122,98,66,0.8)"; g.lineWidth = 2;
  g.strokeRect(10, 10, w - 20, h - 20);
  g.strokeStyle = "rgba(122,98,66,0.55)"; g.setLineDash([6, 7]);
  g.beginPath(); g.moveTo(0, body); g.lineTo(w, body); g.stroke();
  g.setLineDash([]);
  const ink = "#4a3a28";
  const kai = '"Kaiti SC","STKaiti","KaiTi",serif';
  const era = ERAS[state.eraIndex];
  g.fillStyle = ink; g.textBaseline = "middle";
  g.font = "bold 40px " + kai;
  g.textAlign = "left";
  g.fillText("甬上潮声 · 千年港 船票", 36, body + 44);
  g.font = "26px " + kai;
  g.fillText("班次：" + era.epoch + " · " + era.zh, 36, body + 92);
  g.font = "22px " + kai;
  g.fillStyle = "rgba(74,58,40,0.85)";
  g.fillText("潮位 " + Math.round(state.tide * 100) + "%　" + new Date().toLocaleDateString("zh-CN"), 36, body + 124);
  // 舵印
  g.save();
  g.translate(w - 90, body + 75);
  g.rotate(-0.12);
  g.fillStyle = "rgba(186,96,50,0.92)";
  g.fillRect(-38, -38, 76, 76);
  g.fillStyle = "#fdf6ec";
  g.font = "bold 46px " + kai;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText("甬", 0, 2);
  g.restore();
  const a = document.createElement("a");
  a.download = "甬上潮声船票-" + era.epoch + ".png";
  a.href = c.toDataURL("image/png");
  a.click();
}

/* =====================================================================
 * 提示 / 错误
 * =================================================================== */
let toastTimer = null;
function showToast(text, ms = 4200) {
  if (!el.toast || state.demo || state.still) return;
  el.toast.textContent = text;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  if (ms > 0) toastTimer = setTimeout(() => el.toast.classList.remove("show"), ms);
}

function showErrorDetail(txt) {
  if (!el.errDetail || !txt) return;
  el.errDetail.textContent = `[加载诊断] ${txt}`;
  el.errDetail.classList.remove("hidden");
}
function hideErrorDetail() {
  if (!el.errDetail) return;
  el.errDetail.classList.add("hidden");
  el.errDetail.textContent = "";
}

function enterFallback(msg, tip) {
  state.mode = "fallback";
  el.camWrap.classList.add("hidden");
  video.style.display = "none";
  skel.style.display = "none";
  showToast(msg || "手动模式 · 按住空格涨潮，方向键换时代", 7000);
  if (tip) showErrorDetail(tip);
}

/* =====================================================================
 * 降级输入：键盘 / 鼠标
 * =================================================================== */
window.addEventListener("keydown", e => {
  if (e.code === "Space") { e.preventDefault(); if (!e.repeat) { state.manualTide = 1; state.spaceHeld = true; } }
  else if (e.code === "ArrowRight") switchEra(1);
  else if (e.code === "ArrowLeft") switchEra(-1);
  else if (e.code === "KeyM") { syncSoundUI(!audio.silent); }
  else if (e.code === "KeyC") {
    if (camReady) { stopCamera(); showToast("摄像头已关闭 · 按 C 重新开启", 4200); }
    else resumeCamera();
  }
  else if (e.code === "KeyI") { toggleShipInfo(); }
  else if (e.code === "KeyS") { saveTicket(); showToast("船票已保存 · 可在浏览器下载里找到", 3600); }
  else if (e.code === "KeyD") { setDemo(!state.demo); }
  else if (e.code === "Escape" && state.demo) { setDemo(false); }
});

/* ---------------- 演示模式：只留船、标题、时代与句子 ---------------- */
let blackoutTimer = null;
function setDemo(on) {
  if (state.demo === on) return;
  el.blackout.classList.add("on");
  clearTimeout(blackoutTimer);
  blackoutTimer = setTimeout(() => {
    state.demo = on;
    document.body.classList.toggle("demo", on);
    el.blackout.classList.remove("on");
    if (on) {
      el.toast.classList.remove("show");
      hideErrorDetail();
      toggleShipInfo(false);
    }
  }, 180);
}

/* ---------------- 开场揭幕：纸褪去 ---------------- */
function playReveal() {
  const rv = el.reveal;
  if (!rv) return;
  rv.classList.remove("hidden", "play", "fade");
  void rv.offsetWidth;
  rv.classList.add("play");
  setTimeout(() => rv.classList.add("fade"), 1100);
  setTimeout(() => { rv.classList.add("hidden"); rv.classList.remove("play", "fade"); }, 1500);
}

function syncSoundUI(silent) {
  audio.setSilent(silent);
  el.muteGlyph.textContent = silent ? "静" : "♪";
  el.soundBtn.classList.toggle("muted", silent);
}
el.soundBtn.addEventListener("click", () => syncSoundUI(!audio.silent));

/* ---------------- 回看小窗：拖动 + 记住位置 ---------------- */
skel.width = 1280; skel.height = 720;
(function setupCamDrag() {
  const w = el.camWrap;
  if (!w) return;
  try {
    const saved = JSON.parse(localStorage.getItem("camPos") || "null");
    if (saved && typeof saved.x === "number") {
      w.style.right = "auto"; w.style.bottom = "auto";
      w.style.left = (saved.x * 100) + "vw";
      w.style.top = (saved.y * 100) + "vh";
    }
  } catch (e) {}
  let dragging = false, ox = 0, oy = 0;
  const onDown = e => {
    dragging = true; w.classList.add("dragging");
    const r = w.getBoundingClientRect();
    ox = e.clientX - r.left; oy = e.clientY - r.top;
    e.preventDefault();
  };
  const onMove = e => {
    if (!dragging) return;
    w.style.right = "auto"; w.style.bottom = "auto";
    const nx = Math.max(0, Math.min(window.innerWidth - w.offsetWidth, e.clientX - ox));
    const ny = Math.max(0, Math.min(window.innerHeight - w.offsetHeight, e.clientY - oy));
    w.style.left = nx + "px"; w.style.top = ny + "px";
    try { localStorage.setItem("camPos", JSON.stringify({ x: nx / window.innerWidth, y: ny / window.innerHeight })); } catch (e) {}
  };
  const onUp = () => { dragging = false; w.classList.remove("dragging"); };
  w.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
})();

/* 音频与摄像头卫生：后台/失焦挂起，回前台恢复 */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { audio.pageSuspend(); stopCamera(); }
  else { audio.pageResume(); resumeCamera(); }
});
window.addEventListener("blur",  () => { audio.pageSuspend(); stopCamera(); });
window.addEventListener("focus", () => { if (!document.hidden) { audio.pageResume(); resumeCamera(); } });
window.addEventListener("keyup", e => {
  if (e.code === "Space") { state.manualTide = 0.08; state.spaceHeld = false; }   // 松手潮缓落，不全干
});
let dragging = false;
window.addEventListener("mousedown", e => {
  if (e.target.closest("#gate") || e.target.closest("button") || e.target.closest("#shipInfo")) return;
  if (state.mode !== "loading") {
    const horizon = HORIZON();
    const S = Math.min(W, H) * (0.13 + 0.21 * state.tide);
    const sx = state.shipX * W, sy = horizon + H * 0.045;
    if (Math.abs(e.clientX - sx) < S * 1.6 && Math.abs(e.clientY - sy) < S * 1.1) {
      toggleShipInfo();
      return;
    }
  }
  dragging = true;
  state.manualTide = clamp01(1 - e.clientY / window.innerHeight);
  state.dragShipX = Math.min(0.94, Math.max(0.06, e.clientX / window.innerWidth));
});
window.addEventListener("mousemove", e => {
  if (dragging) {
    state.manualTide = clamp01(1 - e.clientY / window.innerHeight);
    state.dragShipX = Math.min(0.94, Math.max(0.06, e.clientX / window.innerWidth));
  }
});
window.addEventListener("mouseup", () => { dragging = false; state.dragShipX = null; });

/* ---------------- 入口：点击进入（解锁音频 + 启动摄像头/模型） ---------------- */
el.startBtn.addEventListener("click", async () => {
  el.gate.classList.add("hide");
  playReveal();
  audio.init();
  audio.setEra(state.eraIndex);
  if (audio.ctx && !audio.silent && !document.hidden && audio.ctx.state === "suspended") {
    audio.ctx.resume();
  }

  showToast("正在加载手势库…", 0);
  if (!(await withTimeout(loadVisionLibrary(), 15000))) {
    enterFallback("手势库加载失败 · 见下方诊断",
      "把 [加载诊断] 那行原样念给老师；也可单独打开 /tools/vendor-check.html 做一次自检。");
    return;
  }

  showToast("正在请求摄像头权限…", 0);
  const camRes = await withTimeout(initCamera(), 12000);
  if (camRes !== "ok") {
    const m = camFailMessage(camRes === false ? "error" : camRes);
    enterFallback(camRes === false ? "摄像头请求超时" : m.text,
      camRes === false ? "授权弹窗无响应，请在 Chrome 里允许摄像头后刷新页面。" : m.tip);
    return;
  }

  showToast("正在加载手势模型…", 0);
  if (!(await withTimeout(loadHandModel(), 25000))) {
    stopCamera();
    enterFallback("模型加载失败",
      "请确认 vendor/models/hand_landmarker.task 文件存在且未损坏（正常约 7.6 MB）。");
    return;
  }

  state.mode = "camera";
  hideErrorDetail();
  startGuide();
  showToast("左手：上下控潮、左右移船；右手：快速一挥换船", 5200);
});

/* ---------------- 截图/静态检查：?still=1&f=2&tide=0.85&demo=1 ---------------- */
if (STILL) {
  el.gate.style.display = "none";
  if (params.get("showcam") !== "1") el.camWrap.classList.add("hidden");
  el.reveal.classList.add("hidden");
  state.mode = "fallback";
  state.manualTide = lockTide != null ? lockTide : 0.8;
  const shipX0 = parseFloat(params.get("x"));
  if (!isNaN(shipX0)) state.shipX = Math.min(0.94, Math.max(0.06, shipX0));
  if (DEMO_START) {
    state.demo = true;
    document.body.classList.add("demo");
  }
}
