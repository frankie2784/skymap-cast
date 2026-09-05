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
 *   SETUP         { lat, lng, aim: {bl,br,tl,tr: {az,alt}},
 *                   corners: {tl,tr,br,bl} }    finalise setup, start sky
 *
 * Two independent calibrations compose to produce the final image:
 *   1. `aim` — four real-world (azimuth, altitude) directions, measured by
 *      physically pointing the phone at each corner of the light hitting the
 *      wall/ceiling from the viewer's actual seat. Determines the exact
 *      direction -> image homography (see applyAim()), so the rendered image
 *      is what that flat surface would really look like as a window onto the
 *      sky, not a fisheye dome. All four are needed: three corners cannot
 *      determine the shape, since angles alone carry no distance.
 *   2. `corners` — normalised 0–1 screen-space quad, unchanged from before.
 *      Applied afterwards as a CSS homographic warp, purely to correct the
 *      *projector's own* keystone (mounted off-angle) or to confine the sky
 *      to only part of the projector's full output frame. Orthogonal to (1):
 *      this never affects which sky direction maps to which pixel, only
 *      where that already-correct rectangular image physically lands.
 *
 * Corner coordinates are normalised 0–1 (x: left=0, right=1; y: top=0, bot=1).
 *
 * After SETUP the receiver:
 *   1. Builds the camera homography from `aim`, then applies the `corners` warp.
 *   2. Downloads TLEs from CelesTrak and runs SGP4 every 5s.
 *   3. Recomputes star positions every 1s.
 *   4. Refreshes TLEs every 2h.
 *   The phone may disconnect; the sky continues indefinitely.
 */

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  // NOTE: NORAD/elements/gp.php (not supplemental/sup-gp.php — that endpoint only
  // serves operator-supplied groups like intelsat/gorizont, not "visual"/"stations").
  // Matches the endpoint the Android app itself uses (CelesTrakService.kt).
  CELESTRAK_VISUAL:   'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=json',
  CELESTRAK_STATIONS: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json',
  TLE_REFRESH_MS:     2 * 60 * 60 * 1000,
  SAT_PROPAGATE_MS:   5_000,
  // Stars only drift ~0.25 deg/minute (Earth's sidereal rotation), so unlike
  // satellites they don't need a fast cadence to look smooth — they need a
  // cadence fine enough that each step's jump isn't a visible discrete snap.
  // 60s (~0.25 deg/step, all ~8,870 stars moving in lockstep in a single
  // frame) was visibly jumpy; 15s (~0.06 deg/step) keeps the same total drift
  // but spread over 4x as many steps, at 1/15th the CPU/GC cost of the 1s
  // cadence this used to run at. Must stay >= SAT_PROPAGATE_MS, since
  // satellites move fast enough (low orbit, ~90min/orbit) that they need the
  // more frequent cadence, not the other way round.
  STAR_UPDATE_MS:     15_000,
  MIN_SAT_ALT_DEG:   -5,
  // Radius (arbitrary world units) of the sphere every sky object is placed
  // on. Absolute scale doesn't matter — applyAim()'s homography is linear, so
  // the radius cancels when the clip coordinates are dehomogenised.
  SKY_RADIUS:         900,
  CAST_NAMESPACE:     'urn:x-cast:com.skymap.receiver',
};

// ─── State ────────────────────────────────────────────────────────────────────

const AppState = { WAITING: 'waiting', CALIBRATING: 'calibrating', RUNNING: 'running' };
let appState = AppState.WAITING;

// Snapshot of the last confirmed SETUP (see applySetup()), so a cancelled
// recalibration (CANCEL_CALIBRATION message) has something to revert to
// instead of leaving the receiver stuck showing the calibration overlay —
// null until the very first SETUP ever lands.
let lastAppliedSetup = null;

const sky = {
  lat:            null,
  lng:            null,
  // Real-world (azimuth, altitude) directions to all 4 corners of the physical
  // surface, measured from the viewer's seat — see applyAim(). Null until
  // the first SETUP arrives.
  aim:            null,
  tleRecords:     [],
  // Which layers are drawn — toggled from the phone (see LAYERS message) with
  // the same three groupings the phone app's own HUD toggles use.
  layers: {
    stars:      true,
    planets:    true,   // Sun, Moon, and the 8 planets — one switch, matching the app
    satellites: true,
  },
};

// Default corners: centred rectangle with ~20% margin
const DEFAULT_CORNERS = {
  tl: { x: 0.15, y: 0.20 },
  tr: { x: 0.85, y: 0.20 },
  br: { x: 0.85, y: 0.80 },
  bl: { x: 0.15, y: 0.80 },
};
let currentCorners = { ...DEFAULT_CORNERS };

// ─── Persistence ──────────────────────────────────────────────────────────────
//
// Chromecasts reboot (power loss, idle standby, a firmware update) without any
// warning to the running receiver app, which otherwise loses lat/lng/corners and
// sits at WAITING until someone walks over with their phone again. Persisting the
// last-applied SETUP lets the receiver resume autonomously on its own next boot.

const STORAGE_KEY = 'skymap-projector-setup-v1';

// typeof-guarded, unlike a bare isFinite() — isFinite(null) is true (null
// coerces to 0), which would let a LAYERS toggle sent before any real SETUP
// persist a bogus lat:null/lng:null that looks "valid" on the next boot.
function isValidCoord(v) {
  return typeof v === 'number' && isFinite(v);
}

function isValidAim(aim) {
  return !!aim && ['bl', 'br', 'tl', 'tr'].every(
    k => aim[k] && isValidCoord(aim[k].az) && isValidCoord(aim[k].alt),
  );
}

function saveSetup() {
  // Nothing meaningful to resume yet — e.g. a LAYERS toggle arrived before the
  // first SETUP. Don't overwrite (or create) a persisted entry with it.
  if (!isValidCoord(sky.lat) || !isValidCoord(sky.lng) || !isValidAim(sky.aim)) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      lat: sky.lat, lng: sky.lng, aim: sky.aim,
      corners: currentCorners, layers: sky.layers,
    }));
  } catch (e) {
    // Some Cast receiver contexts run with storage disabled/quota-limited — non-fatal.
    console.warn('[Receiver] Could not persist setup:', e);
  }
}

function loadSetup() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isValidCoord(parsed.lat) || !isValidCoord(parsed.lng) || !isValidAim(parsed.aim)) return null;
    // Merge over the defaults so a setup saved before layer toggles existed
    // (no `layers` key) still restores with everything on.
    parsed.layers = { ...sky.layers, ...(parsed.layers || {}) };
    return parsed;
  } catch (e) {
    console.warn('[Receiver] Could not load persisted setup:', e);
    return null;
  }
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const canvasEl  = document.getElementById('sky');
const selectionCanvasEl = document.getElementById('selection-overlay');
const selectionCtx = selectionCanvasEl.getContext('2d');
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
  hideAimHighlight();
}

// Marks the single corner the phone is asking the user to point at during aim
// calibration (see the AIM_TARGET message). The ring is deliberately large and
// pulsing rather than a precise dot: the user is holding a phone up in front of
// that exact spot to aim at it, so the corner itself is physically hidden behind
// the phone — the ring stays visible around the phone's silhouette.
function showAimHighlight(cornerKey) {
  const corner = currentCorners[cornerKey];
  if (!corner) return;
  const g   = svgEl.querySelector('#aim-highlight');
  const ring = svgEl.querySelector('#aim-ring');
  const dot  = svgEl.querySelector('#aim-dot');
  [ring, dot].forEach(el => {
    el.setAttribute('cx', corner.x);
    el.setAttribute('cy', corner.y);
  });
  const label = { bl: 'bottom-left', br: 'bottom-right', tl: 'top-left', tr: 'top-right' }[cornerKey] || cornerKey;
  const instruction = svgEl.querySelector('#cal-instruction');
  if (instruction) instruction.textContent = `Point your phone at the ${label} corner`;
  g.style.display = 'block';
  svgEl.style.display = 'block';
}

function hideAimHighlight() {
  const g = svgEl.querySelector('#aim-highlight');
  if (g) g.style.display = 'none';
  const instruction = svgEl.querySelector('#cal-instruction');
  if (instruction) instruction.textContent = 'Drag corners on your phone to fit the projection surface';
}

// ─── Projection placement ─────────────────────────────────────────────────────
//
// After setup the canvas is uniformly scaled into the calibrated bounds, then
// clipped to the user-defined quad. A projective CSS warp would make the sky,
// selected-object rings, and labels visibly stretch near the quad edges.

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

// Keeps the 2D selection-marker canvas pixel-for-pixel aligned with the WebGL
// canvas — same backing resolution, so drawSelectionOverlay()'s NDC->pixel
// math lands in the same coordinate frame applyWarp() then transforms below.
function resizeSelectionCanvas() {
  selectionCanvasEl.width = window.innerWidth;
  selectionCanvasEl.height = window.innerHeight;
}

function applyWarp(corners) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const points = [corners.tl, corners.tr, corners.br, corners.bl];
  const minX = Math.min(...points.map(point => point.x));
  const maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxY = Math.max(...points.map(point => point.y));
  const scale = Math.min(maxX - minX, maxY - minY);
  const offsetX = ((minX + maxX - scale) * W) / 2;
  const offsetY = ((minY + maxY - scale) * H) / 2;

  // A projective CSS transform makes every circular marker and label locally
  // anisotropic. Keep the rendered sky isotropic and use the quad only as a
  // mask; uncovered parts of a non-rectangular calibration stay black.
  const clipPoints = points.map(point => {
    const x = ((point.x * W - offsetX) / scale / W) * 100;
    const y = ((point.y * H - offsetY) / scale / H) * 100;
    return `${x.toFixed(4)}% ${y.toFixed(4)}%`;
  });
  // Selection overlay gets the exact same isotropic transform/clip as the sky
  // canvas, so a marker drawn as a true circle in canvas-pixel space stays a
  // true circle after this uniform (non-projective) scale is applied.
  for (const el of [canvasEl, selectionCanvasEl]) {
    el.style.transformOrigin = '0px 0px';
    el.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    el.style.clipPath = `polygon(${clipPoints.join(', ')})`;
  }
  console.log('[Warp] Uniform scale and clip applied');
}

// ─── Three.js scene ───────────────────────────────────────────────────────────

let renderer, scene, camera, sceneGroup;
let starPosAttr;
let starsPoints;             // the star Points object — toggled via sky.layers.stars
let starsMaterial;           // its ShaderMaterial — uTime updated each frame for twinkle
let satGroup;                 // toggled via sky.layers.satellites
let planetGroup;               // toggled via sky.layers.planets
let planetSprites = {};        // body name -> THREE.Sprite, built once in initScene()
let STARS = [];   // deduped catalog, populated by initScene(); read by updateStarPositions()

// Stars sit on a sphere of radius SKY_RADIUS (see Astro.altAzToXYZ) — every
// star is the same distance from the origin regardless of altitude, so unlike
// the old flat fisheye disc, distance-from-origin can no longer signal "near
// the horizon". Use the world-space Y (up) component instead: Y/SKY_RADIUS is
// exactly sin(altitude), zero at the horizon and 1 at the zenith.
const STAR_VERT = `
  attribute float starSize;
  attribute vec3  starColor;
  attribute float starSeed;   // random per-star, 0..1 — desyncs twinkle phase/speed
  uniform   float uTime;      // seconds, updated once per animate() frame
  varying   vec3  vColor;
  varying   float vAlpha;
  void main() {
    vColor = starColor;
    float sinAlt = position.y / ${CONFIG.SKY_RADIUS}.0;
    float horizonFade = smoothstep(-0.031, 0.094, sinAlt);

    // Subtle, per-star-desynced flicker — atmospheric scintillation, not a
    // strobe. +-15% around full brightness so it reads as "alive" without
    // being distracting on a projector.
    float twinkle = 0.85 + 0.15 * sin(uTime * (0.6 + starSeed) + starSeed * 6.2831853);

    vAlpha = horizonFade * twinkle;
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

// ── Moon phase shader ───────────────────────────────────────────────────────
//
// Masks the Moon's texture into the correct crescent/gibbous shape from two
// uniforms: uK (illuminated fraction, 0=new..1=full) and uSide (+1/-1, which
// side of the disc is the "biased lit" limb — see Planets.compute()'s moon
// entry). Geometrically derived (not copied from memory) from the standard
// "terminator = ellipse" model of a sphere lit from one side and viewed
// face-on: for a point (x,y) on the unit disc, with a = 2*uK - 1:
//   always-lit side (sign(x) == uSide): lit if a > 0 (gibbous/full), i.e. most
//     of the disc is lit; on the *other* side, lit only inside the ellipse
//     x²/a² + y² <= 1 (a thin dark sliver for a≈1, growing toward full).
//   for a < 0 (crescent/new): it inverts — the always-lit side is instead
//     *dark* except a thin sliver outside that same ellipse near its rim
//     (the crescent), and the opposite side is fully dark.
// Verified against all four cardinal phases (new/quarter/full + the
// crescent<->gibbous sign flip) by hand before writing this — see the
// derivation in planets.js's moonPhase() doc comment.
//
// KNOWN SIMPLIFICATION: this gets the phase fraction and gross left/right
// bias (waxing vs waning) astronomically right, but treats the terminator as
// screen-horizontal rather than computing the true parallactic tilt angle —
// reasonable for "thin crescent, right side lit," not exact to the degree.
const MOON_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const MOON_FRAG = `
  uniform sampler2D uMap;
  uniform float uK;
  uniform float uSide;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;

    float a = 2.0 * uK - 1.0;
    float aa = max(abs(a), 0.0001);
    bool sideMatches = (p.x == 0.0) || (sign(p.x) == uSide);
    bool insideEllipse = (p.x * p.x) / (aa * aa) + p.y * p.y <= 1.0;

    bool lit;
    if (abs(a) < 0.0001) {
      lit = sideMatches;                                   // quarter: straight terminator
    } else if (a > 0.0) {
      lit = sideMatches ? true : insideEllipse;             // gibbous/full
    } else {
      lit = sideMatches ? !insideEllipse : false;           // crescent/new
    }

    vec4 tex = texture2D(uMap, vUv);
    float shade = lit ? 1.0 : 0.06;   // faint earthshine, not pure black
    // Soften the disc edge slightly so it doesn't alias against the black background.
    float edgeAlpha = 1.0 - smoothstep(0.94, 1.0, sqrt(r2));
    gl_FragColor = vec4(tex.rgb * shade, edgeAlpha);
  }
`;

function initScene() {
  renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 1);
  resizeSelectionCanvas();

  scene      = new THREE.Scene();
  sceneGroup = new THREE.Group();
  scene.add(sceneGroup);

  // ── Camera ───────────────────────────────────────────────────────────────
  //
  // A real perspective camera, positioned at the viewer's eye (the origin —
  // sky objects are placed relative to the observer, not the projector) and
  // oriented/framed by applyAim() once real-world corner measurements arrive:
  // a true off-axis (asymmetric) frustum, so the render is exactly what
  // someone standing in that spot would see looking through a window shaped
  // like the physical wall/ceiling patch — see applyAim()'s doc for the math.
  // Until the first SETUP lands, use an ordinary symmetric perspective camera
  // pointed at the zenith as a reasonable preview.
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, CONFIG.SKY_RADIUS * 4);
  camera.position.set(0, 0, 0);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, CONFIG.SKY_RADIUS, 0);

  // No separate "ground" mesh is needed: nothing is ever placed at radius >
  // SKY_RADIUS, so that area renders as plain black (the clear colour).
  // The horizon ring below marks the SKY_RADIUS boundary itself.

  // ── Stars ──────────────────────────────────────────────────────────────────
  // Dedup the catalog by sky position — some alternate-name aliases share
  // identical RA/Dec and would cause z-fighting at the exact same pixel.
  const _seen = new Map();
  STARS = STAR_CATALOG.filter(([, ra, dec]) => {
    const key = `${ra.toFixed(3)},${dec.toFixed(3)}`;
    if (_seen.has(key)) return false;
    _seen.set(key, true);
    return true;
  });

  const count = STARS.length;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const siz = new Float32Array(count);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const c = bvToColor(STARS[i][4]);
    col[i*3]=c.r; col[i*3+1]=c.g; col[i*3+2]=c.b;
    siz[i] = magToSize(STARS[i][3]);
    seed[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  starPosAttr = new THREE.BufferAttribute(pos, 3);
  geo.setAttribute('position',  starPosAttr);
  geo.setAttribute('starColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('starSize',  new THREE.BufferAttribute(siz, 1));
  geo.setAttribute('starSeed',  new THREE.BufferAttribute(seed, 1));
  starsMaterial = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  starsPoints = new THREE.Points(geo, starsMaterial);
  // Never frustum-cull the star field. Three computes a geometry's bounding sphere
  // once, lazily, on the first render — which happens at boot while this buffer is
  // still all zeros (positions aren't filled until a SETUP supplies lat/lng), giving
  // a permanently cached sphere of radius 0 at the origin. Updating the position
  // attribute does NOT invalidate it. The old orthographic camera didn't care (the
  // origin was well inside its frustum), but the perspective camera sits AT the
  // origin with near=1, so that zero-radius sphere falls behind the near plane and
  // the whole star field is culled every frame — a black sky, with the object still
  // reporting visible:true. The star sphere always encloses the camera, so culling
  // it can never be a win anyway.
  starsPoints.frustumCulled = false;
  sceneGroup.add(starsPoints);

  // ── Horizon ring ───────────────────────────────────────────────────────────
  // A literal circle of points around the horizon (alt=0, every azimuth) on
  // the SKY_RADIUS sphere — replaces the old flat RingGeometry annulus, which
  // only made sense lying in the fisheye's projection plane. Only the portion
  // inside the calibrated frustum ever actually renders on screen.
  const ringPts = [];
  for (let az = 0; az <= 360; az += 2) {
    const { x, y, z } = Astro.altAzToXYZ(0, az);
    ringPts.push(new THREE.Vector3(x, y, z).multiplyScalar(CONFIG.SKY_RADIUS));
  }
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(ringPts),
    new THREE.LineBasicMaterial({ color: 0x223344, transparent: true, opacity: 0.4 }),
  );
  scene.add(ring);

  // ── Compass markers ────────────────────────────────────────────────────────
  // Sit exactly on the horizon (alt=0) at their compass bearing, slightly
  // inside SKY_RADIUS (like planets/satellites — see updatePlanetPositions())
  // so they draw in front of the star field rather than z-fighting with it.
  const compassGroup = new THREE.Group();
  [{ t:'N', az:0 }, { t:'E', az:90 }, { t:'S', az:180 }, { t:'W', az:270 }]
    .forEach(({ t, az }) => {
      const sprite = _textSprite(t, az === 0 ? '#4a9eff' : '#336677');
      const { x, y, z } = Astro.altAzToXYZ(0, az);
      sprite.position.set(x, y, z).multiplyScalar(CONFIG.SKY_RADIUS * 0.999);
      sprite.scale.set(40, 20, 1);
      compassGroup.add(sprite);
    });
  sceneGroup.add(compassGroup);

  satGroup = new THREE.Group();
  sceneGroup.add(satGroup);

  // ── Sun, Moon, planets ──────────────────────────────────────────────────
  // One object per body, built once here (only 9 of them — no pooling needed
  // like the variable-count satellites) and repositioned in updatePlanetPositions().
  // `planetSprites[name]` always holds the object whose .position gets updated —
  // for Sun/Saturn that's the "primary" sprite, with the glow halo / ring as a
  // child so it rides along automatically without separate position tracking.
  //
  // Mercury/Venus/Mars/Jupiter/Uranus/Neptune stay flat colour dots rather than
  // their own equirectangular surface textures: at ~6-14px on screen a squished
  // rectangular photo would read as noise, not a recognisable planet, and (e.g.
  // Venus) some of those textures are false-colour radar maps anyway — no more
  // "accurate" than a hand-picked colour. The Sun (50px) and Moon (40px, with
  // real phase shape) are where real texture detail is actually visible.
  planetGroup = new THREE.Group();
  for (const body of Planets.compute(new Date())) {
    let obj;
    if (body.name === 'sun') {
      obj = _buildSunSprite(body);
    } else if (body.name === 'moon') {
      obj = _buildMoonMesh(body);
    } else {
      obj = new THREE.Sprite(new THREE.SpriteMaterial({
        map: _dotTexture(body.color), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      obj.scale.set(body.sizePx, body.sizePx, 1);
      if (body.name === 'saturn') obj.add(_buildSaturnRing());
    }
    // Position is fully overwritten every tick by updatePlanetPositions() —
    // see PLANET_RADIUS there for how depth-ordering vs. the star field works
    // now that everything sits on a sphere instead of a flat plane.
    planetSprites[body.name] = obj;
    planetGroup.add(obj);
  }
  sceneGroup.add(planetGroup);
  applyLayerVisibility();

  window.addEventListener('resize', () => {
    resizeSelectionCanvas();
    if (sky.aim) {
      applyAim(sky.aim);   // re-fits canvas sizing + re-applies the corners warp
    } else {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    }
  });
}

// ─── Perspective camera from a 4-corner homography ───────────────────────────
//
// Maps sky DIRECTIONS to image coordinates using the exact projective map
// determined by the four measured corner directions. For any planar surface
// viewed from a point, direction -> image is exactly a homography (a 3x3
// projective map), so four corner correspondences determine it completely —
// with no knowledge of distances and no assumption that the surface is a
// rectangle, only that it's flat.
//
// WHY NOT KOOIMA'S OFF-AXIS FRUSTUM (what this used to do)?
// That algorithm needs the screen's real 3D corner POINTS, and takes
// (br-bl) ⊥ (tl-bl) as given. All we can measure with a compass is
// DIRECTIONS — angles carry no distance — so the old code placed all three
// corners at the same radius. But a real rectangle viewed off-axis has its
// corners at genuinely different distances, so equal-radius placement warps
// it into a non-rectangular patch: measured on real calibration data the
// basis came out 110° instead of 90°, and the resulting frustum pointed
// 10-13° away from the corners the user actually aimed at. Verified against
// a synthetic perfect rectangle with perfect sensors, the approximation alone
// introduced ~6° of skew — it was never a sensor-accuracy problem.
//
// The 4th corner is what makes this exact: 4 correspondences x 2 coordinates
// = the 8 degrees of freedom of a homography. Three corners genuinely cannot
// determine the shape, which is why the old approach had to invent the
// missing constraint and got it wrong.
function applyAim(aim) {
  const dirs = ['bl', 'br', 'tl', 'tr'].map(k => {
    const { x, y, z } = Astro.altAzToXYZ(aim[k].alt, aim[k].az);
    return [x, y, z];
  });
  // Image-space targets, in NDC: the rendered frame's own corners.
  const targets = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

  const H = solveHomography(dirs, targets);
  if (!H) {
    console.warn('[Receiver] Degenerate aim calibration — cannot solve homography:', aim);
    sendState({ event: 'AIM_DEGENERATE', error: 'corners collinear or coincident' });
    return;
  }

  // Homogeneous coordinates have a sign ambiguity: (x,y,w) and (-x,-y,-w) are the
  // same 2D point after dehomogenising, so H and -H solve the exact same (u,v)
  // correspondences equally validly. Fixing h22=1 in solveHomography() picks a
  // SPECIFIC one of those two solutions, but nothing about that choice is tied to
  // which one puts the calibrated patch in front of the eye (w>0) rather than
  // behind it (w<0, clipped by WebGL as invisible) — it depends on the aim
  // geometry and can land either way. Confirmed on real calibration data: all 4
  // corners came out at w<0, silently discarding the entire star field with no
  // error anywhere. Detect it against a corner and flip every entry of H — that
  // leaves every x/w,y/w ratio (and so every rendered position) unchanged, since
  // negating both numerator and denominator doesn't change their quotient.
  const w0 = H[2][0] * dirs[0][0] + H[2][1] * dirs[0][1] + H[2][2] * dirs[0][2];
  if (w0 < 0) {
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) H[r][c] *= -1;
  }

  // Build the 4x4 the renderer wants. Objects live at world position p = R*d,
  // and H is linear, so H*(R*d) dehomogenises to exactly H*d — the radius
  // cancels and every object lands where its direction says it should.
  //   clip.x = H0·p,  clip.y = H1·p,  clip.w = H2·p
  // clip.z is left at 0 (so NDC z = 0, mid-range and always inside the depth
  // clip): nothing here writes depth — every material is transparent with
  // depthWrite:false and relies on draw order — so there's no depth precision
  // to preserve. Points behind the surface plane get clip.w < 0 and are
  // clipped by the GPU, which is the behaviour we want.
  camera.matrixAutoUpdate = false;
  camera.matrix.identity();          // H maps world directions directly; no view transform
  camera.matrixWorldNeedsUpdate = true;
  camera.projectionMatrix.set(
    H[0][0], H[0][1], H[0][2], 0,
    H[1][0], H[1][1], H[1][2], 0,
    0,       0,       0,       0,
    H[2][0], H[2][1], H[2][2], 0,
  );

  // Three derives its culling frustum from the projection matrix, which this
  // deliberately non-standard one breaks. Nothing here is expensive enough to
  // need culling (one Points cloud, ~10 sprites, a line loop), so switch it
  // off wholesale rather than have objects vanish for the wrong reasons — the
  // star field already had to do this, see initScene().
  scene.traverse(o => { o.frustumCulled = false; });

  // The homography maps the aimed quad onto the full NDC square, so the render
  // fills the canvas. applyWarp() then uniformly places and clips that canvas
  // to the user's dragged output quad. Canvas therefore tracks the window.
  renderer.setSize(window.innerWidth, window.innerHeight);
  resizeSelectionCanvas();
  if (appState === AppState.RUNNING) applyWarp(currentCorners);
}

// Solves the 3x3 H with H[2][2] fixed to 1 (8 unknowns) such that, for each
// correspondence, dehomogenise(H · dir) == target. Straight Gaussian
// elimination with partial pivoting on the 8x8 system; returns null if the
// system is singular, which means the measured directions are degenerate
// (collinear, or two captures landing on the same spot).
function solveHomography(dirs, targets) {
  const N = 8;
  const M = [];
  for (let i = 0; i < 4; i++) {
    const [dx, dy, dz] = dirs[i];
    const [u, v] = targets[i];
    M.push([dx, dy, dz, 0, 0, 0, -u * dx, -u * dy, u * dz]);
    M.push([0, 0, 0, dx, dy, dz, -v * dx, -v * dy, v * dz]);
  }
  for (let c = 0; c < N; c++) {
    let piv = c;
    for (let r = c + 1; r < N; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < N; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k <= N; k++) M[r][k] -= f * M[c][k];
    }
  }
  const h = [];
  for (let i = 0; i < N; i++) {
    const v = M[i][N] / M[i][i];
    if (!isFinite(v)) return null;
    h.push(v);
  }
  return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
}

// ── Selection marker (2D overlay) ───────────────────────────────────────────
//
// Mirrors whatever's tapped/tracked on the phone (see the SELECT message): a
// ring plus a name label at whatever (az, alt) the phone last reported.
//
// This used to be a pair of THREE.Sprite billboards living in the 3D scene,
// positioned at the selected direction. That looked fine under the old
// symmetric preview camera, but breaks under applyAim()'s real calibration:
// a Sprite's quad is a fixed-size offset added in *world* space, then the
// whole (center + offset) is run through camera.projectionMatrix in one
// matrix multiply. That projection matrix is a general homography fitted to
// the physical (often off-axis, non-rectangular) projection quad — for an
// arbitrary homography, unlike a plain symmetric perspective matrix, the
// local Jacobian is not conformal, so it scales/shears x and y differently
// depending on screen position. The fixed square offset came out as a
// stretched ellipse and slanted text, worst near the quad's edges/corners —
// exactly where a tracked object tends to drift to.
//
// A single point, in contrast, is never distorted by projecting it — only
// shapes (quads) are, because distortion is about how a matrix's Jacobian
// varies *across* an extended region. So: project just the selection's
// center through the same camera matrix used for everything else, then draw
// a fixed-pixel circle and upright text directly in 2D on a canvas layered
// over the WebGL one (see #selection-overlay in index.html and
// resizeSelectionCanvas()/applyWarp() for how it stays aligned).
let selection = { visible: false, azDeg: 0, altDeg: 0, name: '' };

function projectToScreen(azDeg, altDeg) {
  const { x, y, z } = Astro.altAzToXYZ(altDeg, azDeg);
  // Magnitude doesn't matter here — same reasoning as applyAim()'s comment on
  // SKY_RADIUS cancelling: scaling p before a projective transform scales
  // clip.xy and clip.w by the same factor, leaving x/w, y/w unchanged.
  const p = new THREE.Vector4(x, y, z, 1)
    .applyMatrix4(camera.matrixWorldInverse)
    .applyMatrix4(camera.projectionMatrix);
  if (p.w <= 0) return null;   // behind the calibrated surface — a real GPU would clip it too
  return {
    x: (p.x / p.w * 0.5 + 0.5) * selectionCanvasEl.width,
    y: (1 - (p.y / p.w * 0.5 + 0.5)) * selectionCanvasEl.height,
  };
}

function drawSelectionOverlay() {
  selectionCtx.clearRect(0, 0, selectionCanvasEl.width, selectionCanvasEl.height);
  if (!selection.visible) return;
  const pt = projectToScreen(selection.azDeg, selection.altDeg);
  if (!pt) return;

  selectionCtx.save();
  selectionCtx.globalCompositeOperation = 'lighter';
  selectionCtx.strokeStyle = '#ffe270';
  selectionCtx.lineWidth = 3;
  selectionCtx.beginPath();
  selectionCtx.arc(pt.x, pt.y, 28, 0, Math.PI * 2);
  selectionCtx.stroke();
  selectionCtx.restore();

  if (selection.name) {
    selectionCtx.save();
    selectionCtx.fillStyle = '#ffe270';
    selectionCtx.textAlign = 'center';
    selectionCtx.textBaseline = 'middle';
    const maxWidth = Math.min(320, selectionCanvasEl.width - 24);
    let fontSize = 28;
    selectionCtx.font = `bold ${fontSize}px monospace`;
    while (selectionCtx.measureText(selection.name).width > maxWidth && fontSize > 12) {
      fontSize -= 2;
      selectionCtx.font = `bold ${fontSize}px monospace`;
    }
    selectionCtx.fillText(selection.name, pt.x, pt.y - 46);
    selectionCtx.restore();
  }
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

// Soft radial-glow dot texture, cached per colour — used for Sun/Moon/planet
// sprites, each a fixed body so caching by colour (not per-instance) is enough.
const _dotTextureCache = {};
function _dotTexture(colorHex) {
  if (_dotTextureCache[colorHex]) return _dotTextureCache[colorHex];
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 1, 32, 32, 30);
  g.addColorStop(0,   colorHex);
  g.addColorStop(0.6, colorHex);
  g.addColorStop(1,   colorHex + '00');   // fade to transparent (hex alpha=00)
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(32, 32, 30, 0, Math.PI * 2); ctx.fill();
  const tex = new THREE.CanvasTexture(cv);
  _dotTextureCache[colorHex] = tex;
  return tex;
}

// ── Real texture assets (Sun disc, Moon, Saturn's ring) ────────────────────
// Loaded from the same source images the phone app ships (see
// tools/generate_cast_star_catalog.py's sibling, generate_cast_sun_disc.py,
// for how sun_disc.webp was derived). Loading is async — Three.js renders the
// mesh untextured for a frame or two until each texture arrives, which is
// unnoticeable at boot.
const _textureLoader = new THREE.TextureLoader();
function _loadTexture(fileName) {
  return _textureLoader.load(`assets/planet-textures/${fileName}`);
}

function _buildSunSprite(body) {
  const group = new THREE.Group();

  // Soft additive glow behind the disc — the "glowing" part of "glowing sun."
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: _dotTexture('#fff2b0'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  halo.scale.set(body.sizePx * 2.2, body.sizePx * 2.2, 1);
  halo.position.z = -0.05;
  group.add(halo);

  // Real (circularly-masked) sun texture on top — normal blending, not
  // additive, so it reads as a solid disc rather than washing out into the halo.
  const disc = new THREE.Sprite(new THREE.SpriteMaterial({
    map: _loadTexture('sun_disc.webp'), transparent: true, depthWrite: false,
  }));
  disc.scale.set(body.sizePx, body.sizePx, 1);
  group.add(disc);

  return group;
}

function _buildMoonMesh(body) {
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap:  { value: _loadTexture('moon.webp') },
      uK:    { value: body.illuminatedFraction ?? 1 },
      uSide: { value: body.waxing ? 1 : -1 },
    },
    vertexShader: MOON_VERT, fragmentShader: MOON_FRAG,
    transparent: true, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(body.sizePx, body.sizePx, 1);
  return mesh;
}

function _buildSaturnRing() {
  // Parented to the Saturn sprite (see the caller), which inherits its
  // scale.set(sizePx, sizePx, 1) — a Sprite quad spans -0.5..+0.5 of that
  // scale (radius ~0.5 "dot units"), so these raw radii are chosen to land
  // just outside that after inheriting the same scale: ~0.55x-0.9x sizePx.
  const geo = new THREE.RingGeometry(0.55, 0.9, 48);
  const mat = new THREE.MeshBasicMaterial({
    map: _loadTexture('saturn_ring.webp'), transparent: true, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(geo, mat);
  ring.scale.y = 0.45;   // flat ring geometry, squished for a "tilted" look
  ring.position.z = -0.02;
  return ring;
}

// ── Layer visibility ────────────────────────────────────────────────────────
// Applied whenever sky.layers changes (LAYERS message) or on boot/restore.
function applyLayerVisibility() {
  if (starsPoints)  starsPoints.visible  = sky.layers.stars;
  if (satGroup)     satGroup.visible     = sky.layers.satellites;
  if (planetGroup)  planetGroup.visible  = sky.layers.planets;
}

// ─── Star / satellite / planet updates ─────────────────────────────────────

// Everything sits on a sphere of radius SKY_RADIUS around the viewer (see
// Astro.altAzToXYZ), but planets/satellites use a very slightly smaller
// radius than the stars — same trick as the old flat model's small +z
// offsets, just expressed as radius instead: since none of these materials
// write to the depth buffer (see their depthWrite:false), what actually
// determines paint order is Three's back-to-front distance sort for
// transparent objects, so "slightly closer to the eye" is what makes
// planets draw over stars, and satellites over both.
const PLANET_RADIUS = CONFIG.SKY_RADIUS * 0.999;
const SAT_RADIUS     = CONFIG.SKY_RADIUS * 0.998;

function updateStarPositions() {
  if (sky.lat === null) return;
  const now = new Date();
  // Hoisted once per tick — see raDecToXYZInto()'s doc comment. These are
  // invariant across every star in the loop below, unlike ra/dec.
  const latR = Astro.rad(sky.lat);
  const sinLat = Math.sin(latR);
  const cosLat = Math.cos(latR);
  const LST = Astro.lstDeg(now, sky.lng);
  const pos = starPosAttr.array;
  for (let i = 0; i < STARS.length; i++) {
    const [, ra, dec] = STARS[i];
    Astro.raDecToXYZInto(ra, dec, sinLat, cosLat, LST, CONFIG.SKY_RADIUS, pos, i * 3);
  }
  starPosAttr.needsUpdate = true;
}

// Time: O(1) — fixed 9 bodies, recomputed at the same cadence as stars (their
// motion relative to the star field is negligible minute-to-minute; almost
// all of their apparent movement is the same Earth-rotation term stars have).
function updatePlanetPositions() {
  if (sky.lat === null) return;
  const now = new Date();
  for (const body of Planets.compute(now)) {
    const obj = planetSprites[body.name];
    if (!obj) continue;
    const { alt, az } = Astro.raDecToAltAz(body.ra, body.dec, sky.lat, sky.lng, now);
    const { x, y, z } = Astro.altAzToXYZ(alt, az);
    obj.position.set(x, y, z).multiplyScalar(PLANET_RADIUS);

    // Sprites (Sun, and every other body) billboard to face the camera
    // automatically as part of how Three.js renders them — that's baked into
    // the old orthographic-camera design too, so it kept working unchanged.
    // The Moon is the one Mesh (needed for its phase shader, which a Sprite's
    // fixed quad-facing-camera trick can't drive), so unlike a Sprite it does
    // NOT auto-face the eye — with the eye fixed at the origin, lookAt(0,0,0)
    // re-orients it to face inward every tick as it moves across the sphere.
    if (body.name === 'moon') {
      obj.lookAt(0, 0, 0);
      // Moon is a Mesh with a phase shader (see MOON_FRAG) — its uniforms
      // need refreshing too, not just its position/orientation. Phase changes
      // slowly (~12h per 1% of a cycle) so this only needs to keep pace with
      // the position update.
      if (obj.material?.uniforms) {
        obj.material.uniforms.uK.value = body.illuminatedFraction;
        obj.material.uniforms.uSide.value = body.waxing ? 1 : -1;
      }
    }
  }
}

// Satellite dot texture and pooled sprites — built once and reused, rather than
// allocating a canvas/texture/material per satellite on every 5s propagate tick
// (the Chromecast's GPU/memory budget is tight; churn here caused visible jank).
let _satDotTexture = null;
let _satSpritePool = [];

function _getSatDotTexture() {
  if (_satDotTexture) return _satDotTexture;
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
  _satDotTexture = new THREE.CanvasTexture(cv);
  return _satDotTexture;
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
    const unique = records.filter(r => {
      if (seen.has(r.NORAD_CAT_ID)) return false;
      seen.add(r.NORAD_CAT_ID);
      return !!(r.TLE_LINE1 && r.TLE_LINE2);
    });
    // Parse each TLE into a satrec once here, not on every propagate() tick.
    sky.tleRecords = unique.map(r => {
      try {
        return { name: r.OBJECT_NAME || 'SAT', satrec: satellite.twoline2satrec(r.TLE_LINE1, r.TLE_LINE2) };
      } catch (_) {
        return null;
      }
    }).filter(Boolean);
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
  if (sky.lat === null || !sky.tleRecords.length || typeof satellite === 'undefined') return;
  const now  = new Date();
  const gmst = satellite.gstime(now);
  const obs  = {
    latitude:  sky.lat  * (Math.PI / 180),
    longitude: sky.lng  * (Math.PI / 180),
    height:    0,
  };
  const visible = [];
  for (const { satrec } of sky.tleRecords) {
    try {
      const pv = satellite.propagate(satrec, now);
      if (!pv.position) continue;
      const ecf    = satellite.eciToEcf(pv.position, gmst);
      const look   = satellite.ecfToLookAngles(obs, ecf);
      const altDeg = look.elevation * (180 / Math.PI);
      if (altDeg < CONFIG.MIN_SAT_ALT_DEG) continue;
      // Apparent (refracted) altitude — see astronomy.js's refractionDeg() doc
      // comment: keeps a tracked satellite's dot aligned with the SELECT ring,
      // which mirrors the phone's already-refracted azimuthDeg/altitudeDeg.
      visible.push({ alt: Astro.apparentFromTrueDeg(altDeg), az: look.azimuth * (180 / Math.PI) });
    } catch (_) {}
  }
  _updateSatSprites(visible);
}

// Time: O(n) | Space: O(max concurrent visible satellites) — pool grows to the
// high-water mark and is never shrunk (a handful of sprites is negligible).
function _updateSatSprites(sats) {
  const texture = _getSatDotTexture();

  while (_satSpritePool.length < sats.length) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    sprite.scale.set(16, 16, 1);
    _satSpritePool.push(sprite);
    satGroup.add(sprite);
  }

  for (let i = 0; i < _satSpritePool.length; i++) {
    const sprite = _satSpritePool[i];
    if (i < sats.length) {
      // SAT_RADIUS < PLANET_RADIUS < SKY_RADIUS — see its declaration — puts
      // satellites in front of both planets and stars.
      const { x, y, z } = Astro.altAzToXYZ(sats[i].alt, sats[i].az);
      sprite.position.set(x, y, z).multiplyScalar(SAT_RADIUS);
      sprite.visible = true;
    } else {
      sprite.visible = false;
    }
  }
}

// ─── Render loop ──────────────────────────────────────────────────────────────

let _lastStarMs = 0;

const _clockStart = performance.now();

function animate() {
  requestAnimationFrame(animate);
  if (Date.now() - _lastStarMs > CONFIG.STAR_UPDATE_MS) {
    updateStarPositions();
    updatePlanetPositions();
    _lastStarMs = Date.now();
  }
  if (starsMaterial) starsMaterial.uniforms.uTime.value = (performance.now() - _clockStart) / 1000;
  renderer.render(scene, camera);
  drawSelectionOverlay();
}

// Shared by the SETUP message handler and the boot-time localStorage restore
// (see loadSetup()) — both need to lock the corners, spin up the sky, and start
// the TLE download the same way.
function applySetup(setup) {
  sky.lat = setup.lat;
  sky.lng = setup.lng;
  sky.aim = setup.aim ?? sky.aim;
  if (setup.corners) currentCorners = setup.corners;
  if (setup.layers)  sky.layers = { ...sky.layers, ...setup.layers };

  appState = AppState.RUNNING;
  hideCalibrationOverlay();

  applyLayerVisibility();
  updateStarPositions();
  updatePlanetPositions();
  // applyAim() also resizes the canvas to match the calibrated frustum and
  // re-applies the `corners` warp on top — no separate applyWarp() call needed.
  if (sky.aim) applyAim(sky.aim); else applyWarp(currentCorners);
  fetchTLEs();

  // Snapshot the now-confirmed state — see cancelCalibration()'s use of this.
  lastAppliedSetup = {
    lat: sky.lat, lng: sky.lng, aim: sky.aim,
    corners: currentCorners, layers: { ...sky.layers },
  };
}

// Reverts an in-progress recalibration (QUAD_CORNERS/AIM_TARGET already
// switched appState to CALIBRATING — see dispatchMessage()) back to the last
// confirmed SETUP, without re-fetching TLEs or otherwise disturbing anything
// already running (satellites keep propagating on their own timer regardless
// of appState). If no SETUP has ever been confirmed (cancelling out of a
// first-time setup), there's nothing to revert to — go back to idle WAITING
// instead of leaving the calibration overlay stuck on screen.
function cancelCalibration() {
  hideAimHighlight();
  if (lastAppliedSetup) {
    sky.lat = lastAppliedSetup.lat;
    sky.lng = lastAppliedSetup.lng;
    sky.aim = lastAppliedSetup.aim;
    currentCorners = lastAppliedSetup.corners;
    sky.layers = { ...lastAppliedSetup.layers };

    appState = AppState.RUNNING;
    hideCalibrationOverlay();
    applyLayerVisibility();
    if (sky.aim) applyAim(sky.aim); else applyWarp(currentCorners);
    setStatus('Recalibration cancelled', 'Resumed previous setup', 4000);
  } else {
    appState = AppState.WAITING;
    hideCalibrationOverlay();
    setStatus('Waiting for setup…', 'Open SkyMap on your phone');
  }
  sendState({ event: 'CALIBRATION_CANCELLED' });
}

// ─── Message handler ──────────────────────────────────────────────────────────

function handleMessage(_, raw) {
  // CAF's addCustomMessageListener has been observed delivering `raw` as an
  // already-parsed object in some SDK versions (mirroring how sendCustomMessage
  // auto-serializes objects on the way out — see sendState()), rather than the
  // plain string the Android sender actually put on the wire via
  // CastSession.sendMessage(). JSON.parse() on a non-string coerces via
  // String(raw) -> "[object Object]" -> throws, so every message from the phone
  // was being silently dropped. Accept both shapes.
  let msg;
  if (typeof raw === 'string') {
    try { msg = JSON.parse(raw); }
    catch { console.warn('[Receiver] Bad JSON'); return; }
  } else if (raw && typeof raw === 'object') {
    msg = raw;
  } else {
    console.warn('[Receiver] Bad message payload:', raw);
    return;
  }

  // The receiver's own console is only reachable via remote debugging, which makes
  // silent failures here effectively invisible. Report them back over the Cast
  // channel so they surface in the phone's logcat instead — see sendState().
  try {
    dispatchMessage(msg);
  } catch (e) {
    console.error('[Receiver] handleMessage failed:', e);
    sendState({ event: 'ERROR', error: `${msg && msg.type}: ${e && e.message}` });
  }
}

function dispatchMessage(msg) {
  switch (msg.type) {

    // ── Live corner preview while user drags on phone ──────────────────────
    case 'QUAD_CORNERS': {
      if (!msg.corners) return;
      currentCorners = msg.corners;
      // Always show the overlay, even if we were already RUNNING — this is the
      // recalibration path (ProjectorControlSheet's "Recalibrate projection"),
      // and previously the RUNNING guard here meant re-entering setup on an
      // already-projecting receiver silently updated currentCorners with no
      // visible feedback at all until a final SETUP was sent.
      appState = AppState.CALIBRATING;
      showCalibrationOverlay(currentCorners);
      break;
    }

    // ── Final setup: lock corners, start sky ───────────────────────────────
    case 'SETUP': {
      if (!isValidCoord(msg.lat) || !isValidCoord(msg.lng)) return;

      applySetup(msg);
      saveSetup();

      setStatus(
        `📍 ${msg.lat.toFixed(3)}°, ${msg.lng.toFixed(3)}°`,
        'Calibrated',
        5000,
      );
      sendState({ event: 'SETUP_APPLIED' });
      break;
    }

    // ── Toggle which layers are drawn — can arrive any time, including while
    //    already RUNNING (recalibration isn't required just to hide a layer).
    case 'LAYERS': {
      if (!msg.layers) return;
      sky.layers = { ...sky.layers, ...msg.layers };
      applyLayerVisibility();
      saveSetup();
      sendState({ event: 'LAYERS_APPLIED' });
      break;
    }

    // ── User backed out of the setup sheet without finishing ────────────────
    //    Only QUAD_CORNERS/AIM_TARGET can start a recalibration, and previously
    //    nothing could end one except a full SETUP — so leaving the setup sheet
    //    (swipe-dismiss, back button) left the projector stuck on the
    //    calibration overlay indefinitely. See cancelCalibration().
    case 'CANCEL_CALIBRATION': {
      cancelCalibration();
      break;
    }

    // ── Which corner the phone is currently asking the user to aim at ────────
    //    Highlights that corner on the projection so there's something real to
    //    point the phone at — the sky alone gives no clue where the projected
    //    rectangle's corners are. `corner: null` clears the highlight.
    case 'AIM_TARGET': {
      if (msg.corner) {
        appState = AppState.CALIBRATING;
        showCalibrationOverlay(currentCorners);
        showAimHighlight(msg.corner);
      } else {
        hideAimHighlight();
      }
      break;
    }

    // ── Mirrors whatever's tapped/tracked on the phone ────────────────────
    //    Sent repeatedly (~1/sec) while something is selected, since alt/az
    //    drifts for every object as the sky turns — this receiver has no
    //    ephemeris of its own for an arbitrary phone-side selection, unlike
    //    its own star/planet/satellite catalogs. `id: null` clears it.
    case 'SELECT': {
      if (msg.id == null || !isValidCoord(msg.azimuthDeg) || !isValidCoord(msg.altitudeDeg)) {
        selection.visible = false;
        break;
      }
      selection = {
        visible: true,
        azDeg: msg.azimuthDeg,
        altDeg: msg.altitudeDeg,
        name: msg.name || '',
      };
      break;
    }

    // ── Phone explicitly hit "Stop casting" ─────────────────────────────────
    //    initCastReceiver() sets disableIdleTimeout so the projector can keep
    //    running autonomously after the phone merely disconnects (see
    //    SENDER_DISCONNECTED above) — but that same flag makes this app
    //    responsible for closing itself; the platform will not do it for us,
    //    even when the sender ends its session with stopApplication=true.
    //    ProjectorSetupManager.disconnect() sends this right before ending
    //    the session, so it's the only reliable way left to actually stop.
    case 'STOP': {
      setStatus('Casting stopped', '', 0);
      try { castReceiverCtx.stop(); } catch (e) { console.warn('[Receiver] stop failed:', e); }
      break;
    }
  }
}

// ─── Cast SDK ─────────────────────────────────────────────────────────────────

// Set once initCastReceiver() runs; used by sendState() to talk back to the phone.
let castReceiverCtx = null;
// Whether at least one sender has ever connected. Deliberately NOT a specific
// sender id: a single Cast session carries more than one sender — on-device logs
// show both "au.com.skymap" and "com.google.android.gms" connecting for the same
// session — so tracking one id meant SENDER_CONNECTED from the second sender
// overwrote the first, and every later reply was addressed to a sender that
// wasn't the app. sendState() broadcasts to all senders instead.
let anySenderConnected = false;

// Tells the connected phone what the receiver is currently doing — acknowledges
// a SETUP, and (on SENDER_CONNECTED) reports state the phone has no other way to
// learn, e.g. "already running from a persisted setup" after a Chromecast reboot.
// Without this the phone-side UI has no signal beyond "message sent, presumably
// received"; ProjectorSetupManager surfaces this as `receiverState`.
function sendState(extra = {}) {
  if (!castReceiverCtx || !anySenderConnected) return;
  // Pass a plain object, not a pre-stringified string — sendCustomMessage
  // serializes its `data` argument itself. Passing an already-JSON.stringify'd
  // string here made it serialize *that string*, so the Android sender's
  // JSONObject(message) received a JSON text wrapped in an extra layer of
  // quotes (JSONTokener parsed a String primitive, not an object) and threw
  // "Value {...} of type java.lang.String cannot be converted to JSONObject"
  // on every STATE message — confirmed via on-device logcat.
  const payload = {
    type: 'STATE',
    appState,
    lat: sky.lat,
    lng: sky.lng,
    aim: sky.aim,
    // Lets the phone's recalibration flow start from the saved shape instead of
    // resetting to a default every time — see ProjectorSetupSheet's corners seed.
    corners: currentCorners,
    layers: sky.layers,
    // The Chromecast's JS console needs remote debugging to reach, so ship the
    // values that actually explain a blank projection back to the phone, where
    // they land in logcat. NaN/0 here localises a fault immediately.
    diag: {
      stars:    STARS.length,
      camOk:    !!camera && isFinite(camera.projectionMatrix.elements[0]),
      proj0:    camera ? camera.projectionMatrix.elements[0] : null,
      proj5:    camera ? camera.projectionMatrix.elements[5] : null,
      canvasW:  canvasEl.offsetWidth,
      canvasH:  canvasEl.offsetHeight,
      starVis:  !!starsPoints && starsPoints.visible,
    },
    ...extra,
  };
  try {
    // undefined senderId = broadcast to every connected sender. See anySenderConnected.
    castReceiverCtx.sendCustomMessage(CONFIG.CAST_NAMESPACE, undefined, payload);
  } catch (e) {
    console.warn('[Receiver] sendState failed:', e);
  }
}

function initCastReceiver() {
  const ctx  = cast.framework.CastReceiverContext.getInstance();
  const opts = new cast.framework.CastReceiverOptions();
  opts.disableIdleTimeout = true;
  opts.skipPlayersLoad    = true;
  castReceiverCtx = ctx;

  ctx.addCustomMessageListener(CONFIG.CAST_NAMESPACE, e => handleMessage(e.senderId, e.data));

  ctx.addEventListener(cast.framework.system.EventType.READY,
    () => setStatus('SkyMap ready', 'Open the app on your phone to set up'));

  ctx.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, e => {
    anySenderConnected = true;
    setStatus('Phone connected', 'Follow the setup steps in the app');
    sendState({ event: 'SENDER_CONNECTED' });
  });

  ctx.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, e => {
    // Only truly disconnected once no senders remain — one session's second sender
    // (Play Services) dropping must not silence replies to the app's own sender,
    // nor make the projector announce it's been left alone while the phone is
    // still driving it.
    let remaining = 0;
    try { remaining = (ctx.getSenders() || []).length; } catch (_) {}
    anySenderConnected = remaining > 0;
    if (anySenderConnected) return;

    // The user explicitly hit "Stop casting" — from SkyMap's own projector sheet, the
    // stock Cast dialog, or the system Cast notification. Only the first of those sends
    // our custom STOP message, and disableIdleTimeout (set above) stops the platform
    // closing us on its own, so this reason code is the one signal every explicit-stop
    // path shares. Without it, "stop casting" on the phone left the projector happily
    // running the sky with no session and no way to reach it short of unplugging.
    //
    // Every other reason (ERROR / UNKNOWN — phone slept, lost WiFi, or was killed) is an
    // *implicit* drop and deliberately leaves the projector running autonomously, which is
    // the whole point of disableIdleTimeout.
    const REQUESTED = cast.framework.system.DisconnectReason.REQUESTED_BY_SENDER;
    if (e && e.reason === REQUESTED) {
      console.info('[Receiver] Sender requested disconnect — shutting down');
      setStatus('Casting stopped', '', 0);
      try { ctx.stop(); } catch (err) { console.warn('[Receiver] stop failed:', err); }
      return;
    }

    // No phone left to keep it updated — a frozen selection marker from whenever
    // the phone happened to disconnect would be misleading, not informative.
    selection.visible = false;

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
  setInterval(propagateSatellites, CONFIG.SAT_PROPAGATE_MS);
  animate();

  // Resume autonomously if we have a persisted setup (e.g. the Chromecast just
  // rebooted) rather than sitting at WAITING until someone reopens the app.
  const persisted = loadSetup();
  if (persisted) {
    applySetup(persisted);
    setStatus('Resumed previous setup', `📍 ${persisted.lat.toFixed(3)}°, ${persisted.lng.toFixed(3)}°`, 5000);
  } else {
    setStatus('Initialising…', '');
  }

  if (typeof cast !== 'undefined' && cast.framework) {
    initCastReceiver();
  } else {
    setStatus('Preview mode', 'Paste test command in browser console');
    console.info('[Receiver] Test commands:');
    console.info("  handleMessage('dev', JSON.stringify({ type:'QUAD_CORNERS', corners:{tl:{x:0.1,y:0.1},tr:{x:0.9,y:0.15},br:{x:0.85,y:0.85},bl:{x:0.12,y:0.88}} }))");
    console.info("  handleMessage('dev', JSON.stringify({ type:'SETUP', lat:-37.8, lng:144.96, aim:{bl:{az:170,alt:20},br:{az:190,alt:20},tl:{az:170,alt:50},tr:{az:190,alt:50}}, corners:{tl:{x:0.1,y:0.1},tr:{x:0.9,y:0.15},br:{x:0.85,y:0.85},bl:{x:0.12,y:0.88}} }))");
  }
});
