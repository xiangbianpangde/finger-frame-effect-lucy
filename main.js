import {
  HandLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const DECART_SDK_URL = "https://esm.sh/@decartai/sdk@0.1.17";

// Demo mode (?demo): synthetic video + fake landmarks, for testing without a camera.
const DEMO = new URLSearchParams(location.search).has("demo");

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const INDEX_MCP = 5;

const video = document.getElementById("video");
const lucyVid = document.getElementById("lucy");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("status-text");
const hintEl = document.getElementById("hint");
const toolbar = document.getElementById("toolbar");
const livePill = document.getElementById("live-pill");
const liveText = document.getElementById("live-text");

// Each effect is a live style prompt for Lucy 2.5, phrased per Decart's
// prompt templates ("Change the style of the video to <description>." with
// concrete visual specifics — vague or non-template phrasing degrades output).
const EFFECTS = [
  {
    id: "movie3d",
    label: "3D 电影",
    // Keep prompts in English — Lucy responds best to Decart's English templates.
    prompt:
      "Change the style of the video to a 3D animated movie: stylized CGI " +
      "animation, the person as an animated character with expressive big " +
      "eyes and smooth skin, soft cinematic lighting.",
  },
  {
    id: "anime",
    label: "动漫",
    prompt:
      "Change the style of the video to hand-drawn anime: clean black line " +
      "art, flat cel shading, vibrant colors, large expressive eyes.",
  },
  {
    id: "cyberpunk",
    label: "赛博朋克",
    prompt:
      "Change the style of the video to neon cyberpunk: glowing pink and " +
      "cyan neon light on the person and walls, rain-slick reflective " +
      "surfaces, holographic signs in the background.",
  },
  {
    id: "watercolor",
    label: "水彩",
    prompt:
      "Change the style of the video to a watercolor painting: soft loose " +
      "brushstrokes, gentle color bleeds, visible paper texture, muted " +
      "pastel palette.",
  },
  {
    id: "lego",
    label: "乐高",
    prompt:
      "Change the style of the video to a LEGO stop-motion animation: the " +
      "person is a yellow LEGO minifigure with a cylindrical head, painted " +
      "face, and claw hands, and the room is built entirely from glossy " +
      "plastic LEGO bricks with visible round studs on every surface.",
  },
  { id: "custom", label: "自定义 ✨", prompt: null },
];
let effect = "movie3d";

let apiKey =
  localStorage.getItem("decart-key") || sessionStorage.getItem("decart-key") || "";
let customPrompt = localStorage.getItem("lucy-custom") || "";
let realtimeClient = null;
let lucyLive = false;
let cameraStream = null;
// Separate cloned stream for Decart/LiveKit so the local preview + MediaPipe
// tracks are never stopped or exclusive-consumed by the WebRTC publish path.
let lucyInputStream = null;

// Smoothed quad corners + presence fade (0..1).
let corners = null;
let presence = 0;
// True while a frame is being shown — relaxes the gesture gate (hysteresis).
let frameActive = false;
// Frames since the quad was last seen; short dropouts hold the last quad.
let lostFrames = 0;
// Crossing/overlapping hands often occlude each other and break detection
// for a while — hold the last quad through a moderate dropout window.
const MAX_LOST_FRAMES = 25;
// Frames in a row a far-jumped quad must persist before we accept it as a
// real reposition rather than a mis-detection during hand overlap.
const JUMP_CONFIRM_FRAMES = 2;
let jumpFrames = 0;

let landmarker = null;
let lastVideoTime = -1;
let lastResults = null;

function currentPrompt() {
  const e = EFFECTS.find((x) => x.id === effect);
  if (e?.prompt) return e.prompt;
  return (
    customPrompt.trim() ||
    "Transform the person into a 3D animated movie character."
  );
}

function buildToolbar() {
  EFFECTS.forEach((e, i) => {
    const btn = document.createElement("button");
    btn.innerHTML = `<span class="key">${i + 1}</span>${e.label}`;
    btn.dataset.id = e.id;
    if (e.id === effect) btn.classList.add("active");
    btn.addEventListener("click", () => setEffect(e.id));
    toolbar.appendChild(btn);
  });
  window.addEventListener("keydown", (ev) => {
    const idx = parseInt(ev.key, 10) - 1;
    if (idx >= 0 && idx < EFFECTS.length) setEffect(EFFECTS[idx].id);
  });
}

function setEffect(id) {
  effect = id;
  toolbar.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.id === id);
  });
  if (id === "custom" && !customPrompt.trim()) {
    document.getElementById("key-panel").classList.remove("hidden");
  }
  pushPrompt();
}

// Send the active style to the live Lucy session (no reconnect needed).
async function pushPrompt() {
  if (!realtimeClient || !lucyLive) return;
  const text = currentPrompt();
  try {
    // SDK versions differ on the exact shape — try the documented forms.
    try {
      await realtimeClient.set({ prompt: text, enhance: true });
    } catch {
      await realtimeClient.set({ prompt: { text }, enhance: true });
    }
  } catch (err) {
    console.error("prompt update failed:", err);
  }
}

function setPill(state, text) {
  livePill.className = state ? `on ${state}` : "";
  if (state) livePill.classList.add("on");
  liveText.textContent = text;
}

// Clone camera tracks so WebRTC/LiveKit cannot kill the local preview stream.
function cloneCameraStream(src) {
  if (!src) return null;
  const tracks = src.getTracks().map((t) => t.clone());
  return new MediaStream(tracks);
}

function stopStream(stream) {
  if (!stream) return;
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch {}
  }
}

function ensureLocalPreview() {
  // If SDK/WebRTC ever mutates the original stream, re-bind the local <video>.
  if (!cameraStream) return;
  const live = cameraStream.getVideoTracks().some((t) => t.readyState === "live");
  if (!live) return;
  if (video.srcObject !== cameraStream) video.srcObject = cameraStream;
  if (video.paused) video.play().catch(() => {});
}

function friendlyConnectError(err) {
  const msg = String(err?.message || err || "连接失败");
  const code = err?.code || err?.data?.code || "";
  const lower = msg.toLowerCase();
  if (code === "INVALID_API_KEY" || lower.includes("api key") || lower.includes("401")) {
    return "密钥无效，请检查 Decart API Key";
  }
  if (lower.includes("ice") || lower.includes("webrtc") || lower.includes("websocket")) {
    return "网络/WebRTC 失败（需能访问 Decart，部分网络需代理）";
  }
  if (lower.includes("failed to fetch") || lower.includes("network") || lower.includes("load")) {
    return "无法加载 Decart SDK 或接口（检查网络/代理）";
  }
  return msg.slice(0, 80);
}

// ---- Decart Lucy 2.5 (realtime video-to-video over WebRTC) ----
async function connectLucy() {
  if (!apiKey || !cameraStream || DEMO) return;
  try {
    setPill("connecting", "连接中…");
    ensureLocalPreview();

    // Always feed Lucy a cloned stream — never the same tracks as local preview.
    stopStream(lucyInputStream);
    lucyInputStream = cloneCameraStream(cameraStream);
    if (!lucyInputStream?.getVideoTracks().length) {
      throw new Error("摄像头视频轨道不可用");
    }

    const { createDecartClient, models } = await import(DECART_SDK_URL);
    const model = models.realtime("lucy-2.5");
    const client = createDecartClient({ apiKey });
    realtimeClient = await client.realtime.connect(lucyInputStream, {
      model,
      // Keep local orientation; the canvas already mirrors for display.
      // (SDK default may also mirror user-facing cams — double-mirror is OK for AI.)
      initialState: { prompt: { text: currentPrompt(), enhance: true } },
      onRemoteStream: (stream) => {
        lucyVid.srcObject = stream;
        lucyVid.play().catch(() => {});
        lucyLive = true;
        setPill("", "实时");
        ensureLocalPreview();
      },
    });
    // Some SDK versions return a client that emits remote stream via event only.
    if (typeof realtimeClient?.on === "function") {
      realtimeClient.on("remoteStream", (stream) => {
        lucyVid.srcObject = stream;
        lucyVid.play().catch(() => {});
        lucyLive = true;
        setPill("", "实时");
        ensureLocalPreview();
      });
      realtimeClient.on("disconnected", () => {
        lucyLive = false;
        setPill("error", "AI 已断开");
        ensureLocalPreview();
      });
    }
    ensureLocalPreview();
    console.log("Lucy connected", realtimeClient);
  } catch (err) {
    console.error("Lucy connect failed:", err);
    lucyLive = false;
    stopStream(lucyInputStream);
    lucyInputStream = null;
    ensureLocalPreview();
    setPill("error", "AI 离线 — " + friendlyConnectError(err));
  }
}

async function disconnectLucy() {
  lucyLive = false;
  setPill(null, "");
  try {
    await realtimeClient?.disconnect?.();
    realtimeClient?.close?.();
  } catch {}
  realtimeClient = null;
  lucyVid.srcObject = null;
  // Stop only the cloned tracks — never the live cameraStream used by preview.
  stopStream(lucyInputStream);
  lucyInputStream = null;
  ensureLocalPreview();
}

function setupKeyPanel() {
  const btn = document.getElementById("key-btn");
  const panel = document.getElementById("key-panel");
  const input = document.getElementById("key-input");
  const remember = document.getElementById("key-remember");
  const custom = document.getElementById("style-custom");

  input.value = apiKey;
  remember.checked = !!localStorage.getItem("decart-key");
  custom.value = customPrompt;

  btn.addEventListener("click", () => panel.classList.toggle("hidden"));
  document.getElementById("key-save").addEventListener("click", async () => {
    apiKey = input.value.trim();
    localStorage.removeItem("decart-key");
    sessionStorage.removeItem("decart-key");
    if (apiKey) {
      (remember.checked ? localStorage : sessionStorage).setItem("decart-key", apiKey);
    }
    customPrompt = custom.value;
    localStorage.setItem("lucy-custom", customPrompt);
    panel.classList.add("hidden");
    try {
      await disconnectLucy();
      ensureLocalPreview();
      if (apiKey) await connectLucy();
      else pushPrompt();
    } catch (err) {
      console.error("save/connect failed:", err);
      ensureLocalPreview();
      setPill("error", "AI 离线 — " + friendlyConnectError(err));
    }
  });
  document.getElementById("key-clear").addEventListener("click", async () => {
    apiKey = "";
    input.value = "";
    localStorage.removeItem("decart-key");
    sessionStorage.removeItem("decart-key");
    await disconnectLucy();
  });
}

async function init() {
  buildToolbar();
  setupKeyPanel();

  let stream;
  if (DEMO) {
    stream = makeDemoStream();
  } else {
    statusText.textContent = "正在加载手势追踪…";
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.3,
      minHandPresenceConfidence: 0.3,
      minTrackingConfidence: 0.3,
    });

    statusText.textContent = "正在请求摄像头…";
    // Lucy 2.5 expects 1280x720 @ 30fps landscape input.
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
        facingMode: "user",
      },
      audio: false,
    });
    cameraStream = stream;
  }
  video.srcObject = stream;
  await new Promise((res) => (video.onloadedmetadata = res));
  await video.play();

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  statusEl.classList.add("hidden");
  if (apiKey && !DEMO) connectLucy();
  requestAnimationFrame(loop);
}

// Draw a (mirrored) source onto any 2d context, filling w x h.
// Returns false if the source has no drawable frame (avoids painting pure black).
function drawMirrored(c, w, h, src = video) {
  const ready =
    src &&
    (src.readyState === undefined || src.readyState >= 2) &&
    (src.videoWidth === undefined || src.videoWidth > 0);
  if (!ready) return false;
  try {
    c.save();
    c.translate(w, 0);
    c.scale(-1, 1);
    c.drawImage(src, 0, 0, w, h);
    c.restore();
    return true;
  } catch (err) {
    console.warn("drawMirrored failed:", err);
    c.restore?.();
    return false;
  }
}

function toPixel(lm) {
  // Mirror x so coordinates match the mirrored canvas.
  return { x: (1 - lm.x) * canvas.width, y: lm.y * canvas.height };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function lerpPt(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// Given landmark sets for exactly two hands, return the 4 frame corners in
// ANATOMICAL order: [left.index, right.index, right.thumb, left.thumb]
// ("left"/"right" = on-screen wrist position). Each corner belongs to a
// specific finger, so the edge cycle is honest geometry: two upright "L"s
// trace a rectangle, and flipping one hand's fingers makes the edges cross
// into a bowtie of two triangles — and uncrossing recovers by itself, since
// nothing about the ordering is stateful.
function computeQuad(hands) {
  const info = hands.map((lm) => ({
    index: toPixel(lm[INDEX_TIP]),
    thumb: toPixel(lm[THUMB_TIP]),
    wristX: toPixel(lm[WRIST]).x,
    // Hand size from wrist -> middle knuckle: stable regardless of which way
    // the fingers point (unlike finger-based measures, which foreshorten).
    scale: dist(toPixel(lm[WRIST]), toPixel(lm[MIDDLE_MCP])) + 1,
  }));
  // Require thumb and index spread apart (an open "L"). Hysteresis: easy to
  // keep once active, so rotating/foreshortening fingers doesn't drop it.
  const needed = frameActive ? 0.2 : 0.75;
  for (const hd of info) {
    if (dist(hd.thumb, hd.index) < hd.scale * needed) return null;
  }
  info.sort((a, b) => a.wristX - b.wristX);
  const [A, B] = info;
  // Standard gesture holds both index fingers up and thumbs down, so this
  // cycle traces a rectangle; flipping one hand crosses it into a bowtie.
  const pts = [A.index, B.index, B.thumb, A.thumb];
  // Degenerate-frame gate on the spanned extent (angle-sorted area) — the
  // traced area is near zero for a legitimate crossed (bowtie) frame.
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const hull = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
  );
  const minArea = frameActive ? 0.0005 : 0.005;
  if (polygonArea(hull) < canvas.width * canvas.height * minArea) return null;
  return pts;
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a / 2);
}

function quadPath(c, q) {
  c.beginPath();
  c.moveTo(q[0].x, q[0].y);
  for (let i = 1; i < 4; i++) c.lineTo(q[i].x, q[i].y);
  c.closePath();
}

function applyEffect(q) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.save();
  quadPath(ctx, q);
  ctx.clip();
  ctx.globalAlpha = presence;

  let drewAi = false;
  if (lucyLive && lucyVid.readyState >= 2 && lucyVid.videoWidth > 0) {
    // The live AI stream is a full-frame transform of the same camera feed —
    // draw it mirrored and screen-aligned so the finger frame is a window
    // into the AI world, staying registered as hands move.
    drewAi = drawMirrored(ctx, w, h, lucyVid);
  }
  if (!drewAi) {
    // Fallback while connecting / remote frames not ready / no key:
    // local color shift so the window never becomes a pure black hole.
    ctx.filter = "hue-rotate(140deg) saturate(1.6) contrast(1.1)";
    drawMirrored(ctx, w, h);
    ctx.filter = "none";
    const cx = q.reduce((s, p) => s + p.x, 0) / 4;
    const cy = q.reduce((s, p) => s + p.y, 0) / 4;
    ctx.font = `600 ${Math.round(w / 55)}px -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.7)";
    ctx.shadowBlur = 8;
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    if (!apiKey && !DEMO) {
      ctx.fillText("🔑 添加 Decart 密钥以开启实时 AI 世界", cx, cy);
    } else if (apiKey && !lucyLive) {
      ctx.fillText("AI 连接中… 框内先显示本地滤镜", cx, cy);
    }
    ctx.shadowBlur = 0;
  }

  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawFrameOutline(q) {
  const t = performance.now() / 1000;
  ctx.save();
  ctx.globalAlpha = presence;

  quadPath(ctx, q);
  ctx.setLineDash([10, 8]);
  // Marching ants: slide the dash pattern along the outline.
  ctx.lineDashOffset = -t * 40;
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 6;
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  ctx.shadowBlur = 0;
  q.forEach((p, i) => {
    const r = 7 + Math.sin(t * 3 + i * 1.5) * 1.5;
    // Soft expanding halo behind each corner dot.
    const halo = (t * 0.8 + i * 0.25) % 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + halo * 14, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - halo) * presence})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
  ctx.restore();
}

function loop() {
  try {
    const w = canvas.width;
    const h = canvas.height;

    // Base layer: mirrored camera feed. If preview died, keep canvas readable.
    const drew = drawMirrored(ctx, w, h);
    if (!drew) {
      ctx.fillStyle = "#0a0a0c";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.font = "600 16px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("摄像头预览中断，正在尝试恢复…", w / 2, h / 2);
      ensureLocalPreview();
    }

    // Run detection once per new video frame.
    if (DEMO) {
      lastResults = { landmarks: fakeHands(performance.now() / 1000) };
    } else if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      try {
        lastResults = landmarker.detectForVideo(video, performance.now());
      } catch (err) {
        // One bad frame must not kill the animation loop.
        console.warn("hand detect failed:", err);
      }
    }

    let targetQuad = null;
    if (lastResults && lastResults.landmarks && lastResults.landmarks.length === 2) {
      targetQuad = computeQuad(lastResults.landmarks);
    }

    if (targetQuad) {
      if (!corners) {
        lostFrames = 0;
        frameActive = true;
        jumpFrames = 0;
        corners = targetQuad;
        presence = Math.min(1, presence + 0.12);
      } else {
        const moved =
          targetQuad.reduce((s, p, i) => s + dist(p, corners[i]), 0) / 4;
        // Only quads that genuinely teleport (≥30% of the screen in one frame,
        // beyond any real hand motion) are treated as suspect mis-detections.
        if (moved > canvas.width * 0.3 && ++jumpFrames < JUMP_CONFIRM_FRAMES) {
          if (++lostFrames > MAX_LOST_FRAMES) {
            presence = Math.max(0, presence - 0.05);
          }
        } else {
          lostFrames = 0;
          frameActive = true;
          jumpFrames = 0;
          // Velocity-adaptive smoothing: damp pixel jitter when nearly still,
          // follow at high gain the moment the hands genuinely move.
          const alpha = Math.min(
            0.85,
            Math.max(0.35, moved / (canvas.width * 0.05))
          );
          corners = corners.map((c, i) => lerpPt(c, targetQuad[i], alpha));
          presence = Math.min(1, presence + 0.12);
        }
      }
    } else if (corners && ++lostFrames <= MAX_LOST_FRAMES) {
      // Brief tracking dropout: hold the last quad instead of fading.
      presence = Math.min(1, presence + 0.12);
    } else {
      presence = Math.max(0, presence - 0.05);
      if (presence === 0) {
        corners = null;
        frameActive = false;
        jumpFrames = 0;
      }
    }

    if (corners && presence > 0.01) {
      applyEffect(corners);
      drawFrameOutline(corners);
    }

    hintEl.classList.toggle("hidden", presence > 0.5);
  } catch (err) {
    console.error("render loop error:", err);
  }

  requestAnimationFrame(loop);
}

// ---- Demo mode helpers ----

function makeDemoStream() {
  const demo = document.createElement("canvas");
  demo.width = 1280;
  demo.height = 720;
  const d = demo.getContext("2d");
  function paint() {
    const t = performance.now() / 1000;
    const g = d.createLinearGradient(0, 0, demo.width, demo.height);
    g.addColorStop(0, "#1c2a4a");
    g.addColorStop(1, "#3a1c4a");
    d.fillStyle = g;
    d.fillRect(0, 0, demo.width, demo.height);
    for (let i = 0; i < 6; i++) {
      const x = demo.width * (0.15 + 0.14 * i) + Math.sin(t * 0.8 + i) * 60;
      const y = demo.height * 0.5 + Math.cos(t * 0.6 + i * 1.7) * 160;
      d.beginPath();
      d.arc(x, y, 50 + 18 * Math.sin(t + i), 0, Math.PI * 2);
      d.fillStyle = `hsl(${(i * 60 + t * 30) % 360}, 75%, 62%)`;
      d.fill();
    }
    d.fillStyle = "rgba(255,255,255,0.9)";
    d.font = "bold 56px sans-serif";
    d.textAlign = "center";
    // Draw mirrored so it reads correctly after the canvas flips it back.
    d.save();
    d.translate(demo.width, 0);
    d.scale(-1, 1);
    d.fillText("演示画面", demo.width / 2, demo.height / 2);
    d.restore();
    requestAnimationFrame(paint);
  }
  paint();
  return demo.captureStream(30);
}

function fakeHand(indexTip, thumbTip, indexMcp) {
  const lm = Array.from({ length: 21 }, () => ({ ...indexMcp, z: 0 }));
  lm[INDEX_TIP] = { ...indexTip, z: 0 };
  lm[THUMB_TIP] = { ...thumbTip, z: 0 };
  lm[INDEX_MCP] = { ...indexMcp, z: 0 };
  return lm;
}

function fakeHands(t) {
  const ox = Math.sin(t * 0.9) * 0.02;
  const oy = Math.cos(t * 0.7) * 0.02;
  return [
    fakeHand(
      { x: 0.74 + ox, y: 0.26 + oy },
      { x: 0.8 + ox, y: 0.56 + oy },
      { x: 0.75 + ox, y: 0.4 + oy }
    ),
    fakeHand(
      { x: 0.26 - ox, y: 0.28 - oy },
      { x: 0.2 - ox, y: 0.58 - oy },
      { x: 0.25 - ox, y: 0.44 - oy }
    ),
  ];
}

init().catch((err) => {
  console.error(err);
  statusEl.classList.remove("hidden");
  statusEl.querySelector(".spinner")?.remove();
  statusText.textContent =
    err.name === "NotAllowedError"
      ? "摄像头权限被拒绝。请允许访问摄像头后刷新页面。"
      : `启动失败：${err.message}`;
});
