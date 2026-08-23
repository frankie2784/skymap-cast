/**
 * SkyMap Cast Receiver — Calibration + Autonomous Sky Engine
 * ═══════════════════════════════════════════════════════════════
 *
 * State machine:
 *   WAITING       → waiting for phone to connect
 *   CALIBRATING   → showing adjustable quad; phone is dragging corners
 *   RUNNING       → sky rendered inside the warped quad; phone disconnected
 *
 * Messages accepted:
 *   QUAD_CORNERS  { corners: {tl,tr,br,bl} }   live corner updates while dragging
 *   SETUP         { lat, lng, azimuthOffset,
 *                   corners: {tl,tr,br,bl} }    finalise setup, start sky
 *
 * Corner coordinates are normalised 0–1 (x: left=0, right=1; y: top=0, bot=1).
 *
 * After SETUP the receiver:
 *   1. Applies a CSS homographic warp to the Three.js canvas so the sky fills
 *      the user-defined polygon exactly.
 *   2. Downloads TLEs from CelesTrak and runs SGP4 every 5s.
 *   3. Recomputes star positions every 60s.
 *   4. Refreshes TLEs every 2h.
 *   The phone may disconnect; the sky continues indefinitely.
 */

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  CELESTRAK_VISUAL:   'https://celestrak.org/supplemental/sup-gp.php?GROUP=visual&FORMAT=json',
  CELESTRAK_STATIONS: 'https://celestrak.org/supplemental/sup-gp.php?GROUP=stations&FORMAT=json',
  TLE_REFRESH_MS:     2 * 60 * 60 * 1000,
  SAT_PROPAGATE_MS:   5_000,
  STAR_UPDATE_MS:     60_000,
  MIN_SAT_ALT_DEG:   -5,
  DOME_R:             900,
  CAST_NAMESPACE:     'urn:x-cast:com.skymap.receiver',
};

// ─── State ────────────────────────────────────────────────────────────────────

const AppState = { WAITING: 'waiting', CALIBRATING: 'calibrating', RUNNING: 'running' };
let appState = AppState.WAITING;

const sky = {
  lat:            null,
  lng:            null,
  azimuthOffset:  0,
  tleRecords:     [],
};

// Default corners: centred rectangle with ~20% margin
const DEFAULT_CORNERS = {
  tl: { x: 0.15, y: 0.20 },
  tr: { x: 0.85, y: 0.20 },
  br: { x: 0.85, y: 0.80 },
  bl: { x: 0.15, y: 0.80 },
};
let currentCorners = { ...DEFAULT_CORNERS };

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const canvasEl  = document.getElementById('sky');
const svgEl     = document.getElementById('calibration-svg');
const statusEl  = document.getElementById('status');
const detailEl  = document.getElementById('detail');

function setStatus(line1, line2 = '', fadeMs = 0) {
  statusEl.textContent = line1;
  detailEl.textContent = line2;
  statusEl.style.opacity = detailEl.style.opacity = '1';
  if (fadeMs > 0) setTimeout(() => {
    statusEl.style.opacity = detailEl.style.opacity = '0';
  }, fadeMs);
}

// ─── Calibration SVG overlay ──────────────────────────────────────────────────
//
// Shows a quad outline with animated corner dots and a top-centre marker.
// Drawn in normalised (0-1) SVG viewBox coords, scaled to viewport.

function showCalibrationOverlay(corners) {
  const { tl, tr, br, bl } = corners;
  const topMid = { x: (tl.x + tr.x) / 2, y: (tl.y + tr.y) / 2 };

  // Polygon fill
  const poly = svgEl.querySelector('#cal-poly');
  const pts  = `${tl.x},${tl.y} ${tr.x},${tr.y} ${br.x},${br.y} ${bl.x},${bl.y}`;
  poly.setAttribute('points', pts);

  // Corner dots
  [['#dot-tl', tl], ['#dot-tr', tr], ['#dot-br', br], ['#dot-bl', bl]]
    .forEach(([sel, p]) => {
      const el = svgEl.querySelector(sel);
      el.setAttribute('cx', p.x);
      el.setAttribute('cy', p.y);
    });

  // Top-centre marker — translate in normalised space
  const marker = svgEl.querySelector('#cal-marker');
  marker.setAttribute('transform', `translate(${topMid.x}, ${topMid.y - 0.04})`);

  // Top edge line highlight
  const topLine = svgEl.querySelector('#cal-top-edge');
  topLine.setAttribute('x1', tl.x); topLine.setAttribute('y1', tl.y);
  topLine.setAttribute('x2', tr.x); topLine.setAttribute('y2', tr.y);

  svgEl.style.display = 'block';
}

function hideCalibrationOverlay() {
  svgEl.style.display = 'none';
}

// ─── Homography warp ──────────────────────────────────────────────────────────
//
// After setup we warp the Three.js canvas using a CSS matrix3d computed from
// the user-defined quad. The canvas fills the screen at rest; the transform
// maps its four corners to the quad corners, producing a perspective-correct
// projection into the defined polygon. Black body background shows everywhere
// else — ideal for a projector.
//
// Algorithm: solve 8×8 DLT system to find H mapping
//   canvas corners (pixels) → quad corners (pixels)
// then convert the 3×3 homography to a CSS matrix3d.

function gaussElim(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];

    const pivot = M[col][col];
    if (Math.abs(pivot) < 1e-10) continue;

    for (let row = col + 1; row < n; row++) {
      const f = M[row][col] / pivot;
      for (let j = col; j <= n; j++) M[row][j] -= f * M[col][j];
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = M[i][n] / M[i][i];
    for (let k = i - 1; k >= 0; k--) M[k][n] -= M[k][i] * x[i];
  }
  return x;
}

function computeHomography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x: sx, y: sy } = src[i];
    const { x: dx, y: dy } = dst[i];
    A.push([sx, sy, 1,  0,  0, 0, -dx * sx, -dx * sy]);
    b.push(dx);
    A.push([ 0,  0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
    b.push(dy);
  }
  const h = gaussElim(A, b);
  return [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1   ],
  ];
}

function homographyToCssMatrix3d(H) {
  const [
    [a, b, c],
    [d, e, f],
    [g, h, i],
  ] = H;
  return [
    a, d, 0, g,
    b, e, 0, h,
    0, 0, 1, 0,
    c, f, 0, i,
  ].map(v => v.toFixed(8)).join(',');
}

function applyWarp(corners) {
  const W = window.innerWidth;
  const H = window.innerHeight;

  const src = [
    { x: 0, y: 0 },
    { x: W, y: 0 },
    { x: W, y: H },
    { x: 0, y: H },
  ];
  const dst = [
    { x: corners.tl.x * W, y: corners.tl.y * H },
    { x: corners.tr.x * W, y: corners.tr.y * H },
    { x: corners.br.x * W, y: corners.br.y * H },
    { x: corners.bl.x * W, y: corners.bl.y * H },
  ];

  const Hmat = computeHomography(src, dst);
  canvasEl.style.transformOrigin = '0px 0px';
  canvasEl.style.transform = `matrix3d(${homographyToCssMatrix3d(Hmat)})`;
  console.log('[Warp] Homography applied');
}

// ─── Three.js scene ───────────────────────────────────────────────────────────

let renderer, scene, camera, sceneGroup;
let starPosAttr;
let satGroup;

const STAR_VERT = `
  attribute float starSize;
  attribute vec3  starColor;
  varying   vec3  vColor;
  varying   float vAlpha;
  void main() {
    vColor = starColor;
    vAlpha = smoothstep(-0.05, 0.08, position.y / ${CONFIG.DOME_R}.0);
    gl_PointSize = starSize;
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const STAR_FRAG = `
  varying vec3  vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float a = ((1.0 - smoothstep(0.0, 0.25, d)) * 0.9
              + (1.0 - smoothstep(0.25, 0.5,  d)) * 0.3) * vAlpha;
    gl_FragColor = vec4(vColor, a);
  }
`;

function initScene() {
  renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 1);

  scene      = new THREE.Scene();
  sceneGroup = new THREE.Group();
  scene.add(sceneGroup);

  // Camera looks straight up — the dome fills the view.
  // camera.up = -Z means the "top" of the rendered image points North (az=0).
  // azimuthOffset then rotates the scene so the user's chosen direction is "top".
  camera = new THREE.PerspectiveCamera(100, window.innerWidth / window.innerHeight, 1, 2000);
  camera.position.set(0, 0, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 1, 0);

  // Deep-space background
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(1800, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0x000005, side: THREE.BackSide }),
  ));

  // Subtle Milky Way band
  const band = new THREE.Mesh(
    new THREE.TorusGeometry(CONFIG.DOME_R * 0.85, CONFIG.DOME_R * 0.18, 8, 64),
    new THREE.MeshBasicMaterial({ color: 0x1a1a2e, transparent: true, opacity: 0.18, side: THREE.DoubleSide }),
  );
  band.rotation.x = THREE.MathUtils.degToRad(60);
  band.rotation.z = THREE.MathUtils.degToRad(25);
  sceneGroup.add(band);

  // ── Ground below the horizon ───────────────────────────────────────────────
  const ground = new THREE.Mesh(
    new THREE.SphereGeometry(CONFIG.DOME_R * 0.99, 64, 32, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: 0x00aa00,
      transparent: true,
      opacity: 0.15,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  sceneGroup.add(ground);

  // ── Stars ──────────────────────────────────────────────────────────────────
  // Dedup the catalog by sky position — some alternate-name aliases share
  // identical RA/Dec and would cause z-fighting at the exact same pixel.
  const _seen = new Map();
  const STARS = STAR_CATALOG.filter(([, ra, dec]) => {
    const key = `${ra.toFixed(3)},${dec.toFixed(3)}`;
    if (_seen.has(key)) return false;
    _seen.set(key, true);
    return true;
  });

  const count = STARS.length;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const siz = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const c = bvToColor(STARS[i][4]);
    col[i*3]=c.r; col[i*3+1]=c.g; col[i*3+2]=c.b;
    siz[i] = magToSize(STARS[i][3]);
  }
  const geo = new THREE.BufferGeometry();
  starPosAttr = new THREE.BufferAttribute(pos, 3);
  geo.setAttribute('position',  starPosAttr);
  geo.setAttribute('starColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('starSize',  new THREE.BufferAttribute(siz, 1));
  sceneGroup.add(new THREE.Points(geo, new THREE.ShaderMaterial({
    vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  })));

  // ── Horizon ring ───────────────────────────────────────────────────────────
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(CONFIG.DOME_R * 0.99, CONFIG.DOME_R, 128),
    new THREE.MeshBasicMaterial({ color: 0x223344, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  scene.add(ring);

  // ── Compass markers ────────────────────────────────────────────────────────
  const compassGroup = new THREE.Group();
  [{ t:'N', az:0 }, { t:'E', az:90 }, { t:'S', az:180 }, { t:'W', az:270 }]
    .forEach(({ t, az }) => {
      const sprite = _textSprite(t, az === 0 ? '#4a9eff' : '#336677');
      const r = CONFIG.DOME_R * 0.88;
      const a = THREE.MathUtils.degToRad(az);
      sprite.position.set(r * Math.sin(a), r * 0.05, -r * Math.cos(a));
      sprite.scale.set(40, 20, 1);
      compassGroup.add(sprite);
    });
  sceneGroup.add(compassGroup);

  satGroup = new THREE.Group();
  sceneGroup.add(satGroup);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (appState === AppState.RUNNING) applyWarp(currentCorners);
  });
}

function _textSprite(text, color) {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.font = 'bold 40px monospace';
  ctx.fillStyle = color;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 32);
  return new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false,
  }));
}

// ─── Star / satellite updates ─────────────────────────────────────────────────

function updateStarPositions() {
  if (!sky.lat) return;
  const now = new Date();
  const pos = starPosAttr.array;
  for (let i = 0; i < STARS.length; i++) {
    const [, ra, dec] = STARS[i];
    const { alt, az } = Astro.raDecToAltAz(ra, dec, sky.lat, sky.lng, now);
    const { x, y, z } = Astro.altAzToXYZ(alt, az);
    pos[i*3]=x*CONFIG.DOME_R; pos[i*3+1]=y*CONFIG.DOME_R; pos[i*3+2]=z*CONFIG.DOME_R;
  }
  starPosAttr.needsUpdate = true;
}

async function fetchTLEs() {
  setStatus('Downloading satellites…', 'CelesTrak');
  try {
    const [r1, r2] = await Promise.all([
      fetch(CONFIG.CELESTRAK_VISUAL),
      fetch(CONFIG.CELESTRAK_STATIONS),
    ]);
    const records = [];
    if (r1.ok) records.push(...await r1.json());
    if (r2.ok) records.push(...await r2.json());
    const seen = new Set();
    sky.tleRecords = records.filter(r => {
      if (seen.has(r.NORAD_CAT_ID)) return false;
      seen.add(r.NORAD_CAT_ID);
      return !!(r.TLE_LINE1 && r.TLE_LINE2);
    });
    console.log(`[Engine] ${sky.tleRecords.length} TLEs`);
    setStatus('Sky ready', `${sky.tleRecords.length} satellites`, 4000);
    propagateSatellites();
    setTimeout(fetchTLEs, CONFIG.TLE_REFRESH_MS);
  } catch (err) {
    console.warn('[Engine] TLE fetch failed:', err);
    setStatus('Satellites unavailable', 'Stars rendering', 5000);
    setTimeout(fetchTLEs, 5 * 60 * 1000);
  }
}

function propagateSatellites() {
  if (!sky.lat || !sky.tleRecords.length || typeof satellite === 'undefined') return;
  const now  = new Date();
  const gmst = satellite.gstime(now);
  const obs  = {
    latitude:  sky.lat  * (Math.PI / 180),
    longitude: sky.lng  * (Math.PI / 180),
    height:    0,
  };
  const visible = [];
  for (const rec of sky.tleRecords) {
    try {
      const satrec = satellite.twoline2satrec(rec.TLE_LINE1, rec.TLE_LINE2);
      const pv     = satellite.propagate(satrec, now);
      if (!pv.position) continue;
      const ecf    = satellite.eciToEcf(pv.position, gmst);
      const look   = satellite.ecfToLookAngles(obs, ecf);
      const altDeg = look.elevation * (180 / Math.PI);
      if (altDeg < CONFIG.MIN_SAT_ALT_DEG) continue;
      visible.push({
        name: rec.OBJECT_NAME || 'SAT',
        alt:  altDeg,
        az:   look.azimuth * (180 / Math.PI),
      });
    } catch (_) {}
  }
  _rebuildSatSprites(visible);
}

function _rebuildSatSprites(sats) {
  while (satGroup.children.length) satGroup.remove(satGroup.children[0]);
  for (const sat of sats) {
    const { x, y, z } = Astro.altAzToXYZ(sat.alt, sat.az);
    const r  = CONFIG.DOME_R * 0.97;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 32;
    const ctx = cv.getContext('2d');
    const g   = ctx.createRadialGradient(16,16,1,16,16,14);
    g.addColorStop(0,   'rgba(125,232,232,0.95)');
    g.addColorStop(0.5, 'rgba(125,232,232,0.40)');
    g.addColorStop(1,   'rgba(125,232,232,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(16,16,14,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(16,16,3,0,Math.PI*2);  ctx.fill();
    const dot = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(cv),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    dot.position.set(x*r, y*r, z*r);
    dot.scale.set(16, 16, 1);
    satGroup.add(dot);
  }
}

function applyAzimuthOffset() {
  // Rotate the entire star dome so the user's chosen direction appears at the top.
  sceneGroup.rotation.y = THREE.MathUtils.degToRad(sky.azimuthOffset);
}

// ─── Render loop ──────────────────────────────────────────────────────────────

let _lastStarMs = 0;

function animate() {
  requestAnimationFrame(animate);
  if (Date.now() - _lastStarMs > CONFIG.STAR_UPDATE_MS) {
    updateStarPositions();
    _lastStarMs = Date.now();
  }
  renderer.render(scene, camera);
}

// ─── Message handler ──────────────────────────────────────────────────────────

function handleMessage(_, raw) {
  let msg;
  try { msg = JSON.parse(raw); }
  catch { console.warn('[Receiver] Bad JSON'); return; }

  switch (msg.type) {

    // ── Live corner preview while user drags on phone ──────────────────────
    case 'QUAD_CORNERS': {
      if (!msg.corners) return;
      currentCorners = msg.corners;
      if (appState !== AppState.RUNNING) {
        appState = AppState.CALIBRATING;
        showCalibrationOverlay(currentCorners);
      }
      break;
    }

    // ── Final setup: lock corners, start sky ───────────────────────────────
    case 'SETUP': {
      if (!isFinite(msg.lat) || !isFinite(msg.lng)) return;

      sky.lat           = msg.lat;
      sky.lng           = msg.lng;
      sky.azimuthOffset = msg.azimuthOffset ?? 0;
      if (msg.corners) currentCorners = msg.corners;

      appState = AppState.RUNNING;
      hideCalibrationOverlay();

      applyAzimuthOffset();
      updateStarPositions();
      applyWarp(currentCorners);
      fetchTLEs();

      setStatus(
        `📍 ${msg.lat.toFixed(3)}°, ${msg.lng.toFixed(3)}°`,
        `North offset ${sky.azimuthOffset.toFixed(1)}°`,
        5000,
      );
      break;
    }
  }
}

// ─── Cast SDK ─────────────────────────────────────────────────────────────────

function initCastReceiver() {
  const ctx  = cast.framework.CastReceiverContext.getInstance();
  const opts = new cast.framework.CastReceiverOptions();
  opts.disableIdleTimeout = true;
  opts.skipPlayersLoad    = true;

  ctx.addCustomMessageListener(CONFIG.CAST_NAMESPACE, e => handleMessage(e.senderId, e.data));

  ctx.addEventListener(cast.framework.system.EventType.READY,
    () => setStatus('SkyMap ready', 'Open the app on your phone to set up'));

  ctx.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED,
    () => setStatus('Phone connected', 'Follow the setup steps in the app'));

  ctx.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, () => {
    if (appState === AppState.RUNNING) {
      setStatus('Running autonomously ✓', '', 4000);
    } else {
      setStatus('Waiting for setup…', 'Open SkyMap on your phone');
      appState = AppState.WAITING;
    }
  });

  ctx.start(opts);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  initScene();
  setStatus('Initialising…', '');
  setInterval(propagateSatellites, CONFIG.SAT_PROPAGATE_MS);
  animate();

  if (typeof cast !== 'undefined' && cast.framework) {
    initCastReceiver();
  } else {
    setStatus('Preview mode', 'Paste test command in browser console');
    console.info('[Receiver] Test commands:');
    console.info("  handleMessage('dev', JSON.stringify({ type:'QUAD_CORNERS', corners:{tl:{x:0.1,y:0.1},tr:{x:0.9,y:0.15},br:{x:0.85,y:0.85},bl:{x:0.12,y:0.88}} }))");
    console.info("  handleMessage('dev', JSON.stringify({ type:'SETUP', lat:-37.8, lng:144.96, azimuthOffset:45, corners:{tl:{x:0.1,y:0.1},tr:{x:0.9,y:0.15},br:{x:0.85,y:0.85},bl:{x:0.12,y:0.88}} }))");
  }
});
