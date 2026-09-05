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
  // NOTE: NORAD/elements/gp.php (not supplemental/sup-gp.php — that endpoint only
  // serves operator-supplied groups like intelsat/gorizont, not "visual"/"stations").
  // Matches the endpoint the Android app itself uses (CelesTrakService.kt).
  CELESTRAK_VISUAL:   'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=json',
  CELESTRAK_STATIONS: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json',
  TLE_REFRESH_MS:     2 * 60 * 60 * 1000,
  SAT_PROPAGATE_MS:   5_000,
  // Was 60s, causing a visible once-a-minute "jump" as the whole sky snapped to
  // its new position. Benchmarked at ~2ms/tick for the full 8,870-star catalog
  // on a dev machine (worth re-checking on real Chromecast hardware, but even
  // 5x slower is a trivial duty cycle at 1Hz); 1s gives smooth-looking
  // continuous motion instead.
  STAR_UPDATE_MS:     1_000,
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

function saveSetup() {
  // Nothing meaningful to resume yet — e.g. a LAYERS toggle arrived before the
  // first SETUP. Don't overwrite (or create) a persisted entry with it.
  if (!isValidCoord(sky.lat) || !isValidCoord(sky.lng)) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      lat: sky.lat, lng: sky.lng, azimuthOffset: sky.azimuthOffset,
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
    if (!isValidCoord(parsed.lat) || !isValidCoord(parsed.lng)) return null;
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
let starsPoints;             // the star Points object — toggled via sky.layers.stars
let starsMaterial;           // its ShaderMaterial — uTime updated each frame for twinkle
let satGroup;                 // toggled via sky.layers.satellites
let planetGroup;               // toggled via sky.layers.planets
let planetSprites = {};        // body name -> THREE.Sprite, built once in initScene()
let STARS = [];   // deduped catalog, populated by initScene(); read by updateStarPositions()

// Stars sit on the z=0 plane in fisheye-projected (x,y) — see Astro.altAzToXY.
// Distance from the origin *is* zenith angle here (0 at zenith, DOME_R at the
// horizon), so alpha fades using that radius instead of world-space altitude.
const STAR_VERT = `
  attribute float starSize;
  attribute vec3  starColor;
  attribute float starSeed;   // random per-star, 0..1 — desyncs twinkle phase/speed
  uniform   float uTime;      // seconds, updated once per animate() frame
  varying   vec3  vColor;
  varying   float vAlpha;
  void main() {
    vColor = starColor;
    float r = length(position.xy) / ${CONFIG.DOME_R}.0;
    float horizonFade = 1.0 - smoothstep(0.94, 1.02, r);

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

  scene      = new THREE.Scene();
  sceneGroup = new THREE.Group();
  scene.add(sceneGroup);

  // ── Camera ───────────────────────────────────────────────────────────────
  //
  // Sky content is pre-projected to flat (x,y) via Astro.altAzToXY (equidistant
  // azimuthal / fisheye: zenith at centre, horizon at the DOME_R-radius edge) —
  // see that function's doc for why. An orthographic camera looking straight
  // down -Z at that plane then renders it undistorted, same as a real fisheye
  // lens photo: a circle of sky inscribed in the frame, black in the corners.
  // A perspective camera can't do this — no FOV shows a full 180° hemisphere
  // without the edges stretching to infinity.
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.set(0, 0, 5);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);
  updateCameraFrustum();

  // No separate "ground" mesh is needed: nothing is ever placed at radius >
  // DOME_R, so that area renders as plain black (the clear colour) — exactly
  // what the vignette outside a real fisheye lens's circular image looks like.
  // The horizon ring below marks the DOME_R boundary itself.

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
  sceneGroup.add(starsPoints);

  // ── Horizon ring ───────────────────────────────────────────────────────────
  // RingGeometry already lies flat in the XY plane by default — exactly the
  // plane everything else is projected onto, so no rotation is needed (unlike
  // the old 3-D hemisphere model, where this had to be laid down as a "floor").
  // Left in `scene` rather than `sceneGroup`: a circle centred on the origin
  // is rotationally symmetric, so it doesn't need to follow the azimuth spin.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(CONFIG.DOME_R * 0.99, CONFIG.DOME_R, 128),
    new THREE.MeshBasicMaterial({ color: 0x223344, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
  );
  scene.add(ring);

  // ── Compass markers ────────────────────────────────────────────────────────
  // Sit exactly on the horizon ring (alt=0) at their compass bearing — part of
  // sceneGroup so they spin with the sky when azimuthOffset rotates it.
  const compassGroup = new THREE.Group();
  [{ t:'N', az:0 }, { t:'E', az:90 }, { t:'S', az:180 }, { t:'W', az:270 }]
    .forEach(({ t, az }) => {
      const sprite = _textSprite(t, az === 0 ? '#4a9eff' : '#336677');
      const { x, y } = Astro.altAzToXY(0, az);
      sprite.position.set(x * CONFIG.DOME_R, y * CONFIG.DOME_R, 0.5);
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
    obj.position.z = 0.4;   // in front of stars, behind compass/satellite markers
    planetSprites[body.name] = obj;
    planetGroup.add(obj);
  }
  sceneGroup.add(planetGroup);
  applyLayerVisibility();

  window.addEventListener('resize', () => {
    updateCameraFrustum();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (appState === AppState.RUNNING) applyWarp(currentCorners);
  });
}

// Fits the DOME_R-radius fisheye disc entirely within the viewport ("contain"
// sizing) regardless of aspect ratio, rather than stretching it — a circle of
// sky, letterboxed in black on whichever axis is longer.
function updateCameraFrustum() {
  const aspect = window.innerWidth / window.innerHeight;
  const halfW  = aspect >= 1 ? CONFIG.DOME_R * aspect : CONFIG.DOME_R;
  const halfH  = aspect >= 1 ? CONFIG.DOME_R : CONFIG.DOME_R / aspect;
  camera.left = -halfW; camera.right = halfW;
  camera.top  = halfH;  camera.bottom = -halfH;
  camera.updateProjectionMatrix();
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

function updateStarPositions() {
  if (sky.lat === null) return;
  const now = new Date();
  const pos = starPosAttr.array;
  for (let i = 0; i < STARS.length; i++) {
    const [, ra, dec] = STARS[i];
    const { alt, az } = Astro.raDecToAltAz(ra, dec, sky.lat, sky.lng, now);
    const { x, y } = Astro.altAzToXY(alt, az);
    pos[i*3]=x*CONFIG.DOME_R; pos[i*3+1]=y*CONFIG.DOME_R; pos[i*3+2]=0;
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
    const { x, y } = Astro.altAzToXY(alt, az);
    obj.position.x = x * CONFIG.DOME_R;
    obj.position.y = y * CONFIG.DOME_R;

    // Moon is a Mesh with a phase shader (see MOON_FRAG) — its uniforms need
    // refreshing too, not just its position. Phase changes slowly (~12h per
    // 1% of a cycle) so this only needs to keep pace with the position update.
    if (body.name === 'moon' && obj.material?.uniforms) {
      obj.material.uniforms.uK.value = body.illuminatedFraction;
      obj.material.uniforms.uSide.value = body.waxing ? 1 : -1;
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
      visible.push({ alt: altDeg, az: look.azimuth * (180 / Math.PI) });
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
    sprite.position.z = 0.5;   // sit just in front of the star plane, avoid z-fighting
    _satSpritePool.push(sprite);
    satGroup.add(sprite);
  }

  for (let i = 0; i < _satSpritePool.length; i++) {
    const sprite = _satSpritePool[i];
    if (i < sats.length) {
      // altAzToXY already encodes zenith angle as radius (see its doc) — an object
      // just below the horizon (alt down to MIN_SAT_ALT_DEG) lands just outside the
      // DOME_R disc, which is the correct, undistorted continuation of the projection.
      const { x, y } = Astro.altAzToXY(sats[i].alt, sats[i].az);
      sprite.position.x = x * CONFIG.DOME_R;
      sprite.position.y = y * CONFIG.DOME_R;
      sprite.visible = true;
    } else {
      sprite.visible = false;
    }
  }
}

function applyAzimuthOffset() {
  // Rotate the flat sky field around the viewing axis (Z, since the camera now
  // looks down -Z) so the direction the user pointed at the ▲ marker ends up at
  // the top of the image. See Astro.altAzToXY: az=0 (North) is already "up"
  // (+Y) with no offset, and az increases clockwise, matching Three's Z-axis
  // rotation sense from the camera's point of view.
  sceneGroup.rotation.z = THREE.MathUtils.degToRad(sky.azimuthOffset);
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
}

// Shared by the SETUP message handler and the boot-time localStorage restore
// (see loadSetup()) — both need to lock the corners, spin up the sky, and start
// the TLE download the same way.
function applySetup(setup) {
  sky.lat           = setup.lat;
  sky.lng           = setup.lng;
  sky.azimuthOffset = setup.azimuthOffset ?? 0;
  if (setup.corners) currentCorners = setup.corners;
  if (setup.layers)  sky.layers = { ...sky.layers, ...setup.layers };

  appState = AppState.RUNNING;
  hideCalibrationOverlay();

  applyAzimuthOffset();
  applyLayerVisibility();
  updateStarPositions();
  updatePlanetPositions();
  applyWarp(currentCorners);
  fetchTLEs();
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
        `North offset ${sky.azimuthOffset.toFixed(1)}°`,
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
  }
}

// ─── Cast SDK ─────────────────────────────────────────────────────────────────

// Set once initCastReceiver() runs; used by sendState() to talk back to the phone.
let castReceiverCtx = null;
let connectedSenderId = null;

// Tells the connected phone what the receiver is currently doing — acknowledges
// a SETUP, and (on SENDER_CONNECTED) reports state the phone has no other way to
// learn, e.g. "already running from a persisted setup" after a Chromecast reboot.
// Without this the phone-side UI has no signal beyond "message sent, presumably
// received"; ProjectorSetupManager surfaces this as `receiverState`.
function sendState(extra = {}) {
  if (!castReceiverCtx || !connectedSenderId) return;
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
    azimuthOffset: sky.azimuthOffset,
    layers: sky.layers,
    ...extra,
  };
  try {
    castReceiverCtx.sendCustomMessage(CONFIG.CAST_NAMESPACE, connectedSenderId, payload);
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
    connectedSenderId = e.senderId;
    setStatus('Phone connected', 'Follow the setup steps in the app');
    sendState({ event: 'SENDER_CONNECTED' });
  });

  ctx.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, () => {
    connectedSenderId = null;
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
    console.info("  handleMessage('dev', JSON.stringify({ type:'SETUP', lat:-37.8, lng:144.96, azimuthOffset:45, corners:{tl:{x:0.1,y:0.1},tr:{x:0.9,y:0.15},br:{x:0.85,y:0.85},bl:{x:0.12,y:0.88}} }))");
  }
});
