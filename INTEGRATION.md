# SkyMap Cast — Integration Guide

## What was built

```
skymap-cast/          ← Deploy this folder to GitHub Pages
├── index.html                 ← Adds the #calibration-svg element
├── assets/
│   └── planet-textures/       ← Copied from the app's own assets (+ sun_disc.webp, derived)
├── js/
│   ├── receiver.js            ← State machine, fisheye warp, Three.js sky, layer toggles
│   ├── astronomy.js           ← RA/Dec → Alt/Az + fisheye projection math (Astro namespace)
│   ├── planets.js             ← Low-precision Sun/Moon/8-planet positions + Moon phase (Planets namespace)
│   └── stars.js               ← ~8,870 stars (mag ≤ 6.5, same asset as the app), bvToColor, magToSize

androidApp/.../cast/
├── CastOptionsProvider.kt     ← Registers your Cast App ID with the SDK
├── ProjectorSetupManager.kt   ← Session lifecycle, message sending/receiving, layer state
├── ProjectorSetupSheet.kt     ← Compose BottomSheet UI (2-step corner/orientation setup)
├── ProjectorControlSheet.kt   ← Layer toggles + "Recalibrate", shown once already running
└── CastDevicePicker.kt        ← MediaRouter-based device chooser (no AppCompat dependency)

tools/
├── generate_cast_star_catalog.py  ← Regenerates js/stars.js from the app's hygdata_v42.csv
└── generate_cast_sun_disc.py      ← Regenerates assets/planet-textures/sun_disc.webp
```

The receiver renders on an orthographic camera using an equidistant-azimuthal (fisheye)
projection — a circle of sky inscribed in the frame, black in the corners, the same shape a
real fisheye lens or DIY dome projector produces. See `Astro.altAzToXY`'s doc for why a
perspective camera can't do this (no FOV shows a full 180° hemisphere without infinite edge
distortion).

**Parity with the phone app**: the receiver is a separate, deliberately lightweight JS
reimplementation — not a mirror of the phone's renderer — so it can keep running after the
phone disconnects. It currently has:
- The **same full star catalog** the app ships (`hygdata_v42.csv`, ~8,870 stars, mag ≤ 6.5)
  — regenerate with `tools/generate_cast_star_catalog.py` if that asset changes.
- **Satellites**: CelesTrak `visual` + `stations` groups (narrower than the app's full
  category system).
- **Sun/Moon/8 planets**: Paul Schlyter's public-domain low-precision algorithm (~1 arcmin
  accuracy — not the same engine as the phone's audited PlanetEngine). The Sun and Moon use
  the app's own textures (`tools/generate_cast_sun_disc.py` derives the Sun's circular disc
  asset); the Moon is phase-shaded (real crescent/gibbous shape, geometrically derived — see
  `planets.js`'s `moonPhase()` doc comment for the math and its one documented simplification:
  correct phase fraction and waxing/waning side, approximate terminator tilt). The other 7
  planets stay flat colour dots — at their ~6-14px size a squished equirectangular texture
  would just be visual noise, and some (Venus) are false-colour radar maps, not truer than a
  hand-picked colour. Saturn gets a ring from the app's own ring texture.
- Twinkle (per-star desynced flicker) and 1Hz continuous star-field motion (was a 60s
  stepwise jump).

Not ported: DSOs, constellations/asterisms, meteor showers, aurora, aircraft, NEOs/comets,
the Milky Way band, light-pollution-aware magnitude limits, skyculture art.

---

## Step 1 — Deploy the receiver

```bash
# From the repo root:
git push skymap-cast origin main
# Then enable Pages in GitHub repo settings → Pages → Branch: / root
# Your receiver URL will be: https://frankie2784.github.io/skymap-cast/
```

---

## Step 2 — Register the Cast App

1. Go to [cast.google.com/publish](https://cast.google.com/publish)
2. **Add New Application → Custom Receiver**
3. Name: `SkyMap`, Receiver Application URL: your GitHub Pages URL
4. Copy the assigned **App ID** (e.g. `AB12CD34`)
5. Open `CastOptionsProvider.kt` and replace `"CC1AD845"` with your App ID

> During development, add your Chromecast's serial number under **Cast Receiver Devices**
> in the developer console — otherwise the receiver won't load until the app is published.

---

## Step 3 — Wire up the Android sender

### 3a. Add to SkyViewModel

```kotlin
// SkyViewModel.kt — add these

val projectorSetupManager = ProjectorSetupManager(application)

init {
    // ... existing init code ...
    projectorSetupManager.start(this)   // 'this' implements LifecycleOwner (AndroidViewModel does)
}

val isCastConnected: StateFlow<Boolean> = projectorSetupManager.isCastConnected
```

> **Note:** `AndroidViewModel` does not implement `LifecycleOwner`.  
> Pass the owner from the Activity instead:
> ```kotlin
> // In SkyActivity.onCreate():
> viewModel.projectorSetupManager.start(this)
> ```

### 3b. Expose heading to the UI

`ProjectorSetupSheet` needs `sensorHeading` — the compass bearing of the phone's top edge.
This already exists in `SkyViewState` as `phoneOrientation?.headingAzimuthDeg`.

### 3c. Add Cast button + show the sheet (in SkyOverlay.kt)

```kotlin
// Near the top of your SkyOverlay composable, add:
var showProjectorSetup by remember { mutableStateOf(false) }

// Add a Cast button somewhere in your UI (e.g. top-right corner):
Box(
    modifier = Modifier
        .align(Alignment.TopEnd)
        .padding(16.dp)
        .size(44.dp)
        .background(Color(0x334A9EFF), CircleShape)
        .clickable { showProjectorSetup = true },
    contentAlignment = Alignment.Center,
) {
    // Cast icon — use your existing icon resources or a simple text
    Text("⊙", color = Color(0xFF4A9EFF), fontSize = 20.sp)
}

// At the bottom of SkyOverlay, show the sheet:
if (showProjectorSetup) {
    ProjectorSetupSheet(
        setupManager    = viewModel.projectorSetupManager,
        currentLocation = viewState.observerLocation,
        sensorHeading   = viewState.phoneOrientation?.headingAzimuthDeg ?: 0.0,
        onDismiss       = { showProjectorSetup = false },
    )
}
```

### 3d. Add the MediaRouteButton (optional but recommended)

The standard Cast button lets users pick the Chromecast device.  Place it in your
Activity's menu or toolbar — the Cast Framework handles device discovery automatically.

```kotlin
// In SkyActivity.kt — add menu inflation:
override fun onCreateOptionsMenu(menu: Menu): Boolean {
    menuInflater.inflate(R.menu.main, menu)
    CastButtonFactory.setUpMediaRouteButton(this, menu, R.id.media_route_menu_item)
    return true
}
```

```xml
<!-- res/menu/main.xml -->
<menu xmlns:android="http://schemas.android.com/apk/res/android"
      xmlns:app="http://schemas.android.com/apk/res-auto">
    <item
        android:id="@+id/media_route_menu_item"
        android:title="Cast"
        app:actionProviderClass="androidx.mediarouter.app.MediaRouteActionProvider"
        app:showAsAction="always" />
</menu>
```

---

## Setup flow (user experience)

```
1. User taps Cast button → picks Chromecast from device list
2. Chromecast loads the receiver → shows "SkyMap ready"
3. User taps ⊙ button in app → ProjectorSetupSheet slides up

   ┌─ Step 1: Shape the projection ──────────────────────────────┐
   │  Dark canvas with 4 draggable corner handles                │
   │  Phone sends QUAD_CORNERS live → projector updates in place │
   │  [Next — Align orientation]                                 │
   └─────────────────────────────────────────────────────────────┘

   ┌─ Step 2: Align orientation ─────────────────────────────────┐
   │  "Point your phone at the ▲ marker on the ceiling/wall"     │
   │  Live compass rose + heading in degrees                     │
   │  [Done — Send to projector]                                 │
   └─────────────────────────────────────────────────────────────┘

4. App sends SETUP { lat, lng, azimuthOffset, corners }
5. Projector warp locks, stars appear, TLEs download
6. User closes the sheet — phone can disconnect
7. Projector runs autonomously ✓
```

---

## Message protocol

All messages use namespace `urn:x-cast:com.skymap.receiver`. SETUP, LAYERS and STATE
persist to `localStorage` (or echo it back) so a Chromecast reboot resumes the last
setup on its own, without the phone reconnecting — see `receiver.js` `loadSetup()`.

**`utcMillis` — present on every phone → receiver message.** The phone stamps it in
`ProjectorSetupManager.sendJson()` from the app's `TimeSource` (so time-travelling the
phone takes the projector with it), and the receiver takes its clock from it — see
`syncClock()` in `receiver.js`. Every position the receiver draws is a function of
sidereal time, so a second of clock error rotates its whole sky by 15", a minute by
0.25°; that reads as the SELECT ring sitting off the object it marks, worst near the
edges of the frame where the calibration homography packs the most pixels into a degree.
A Cast device's own clock is NTP-synced at boot, i.e. least trustworthy exactly when the
receiver starts drawing from its persisted setup.

It costs no extra traffic (SELECT alone repeats once a second while anything is
selected) and the receiver carries the last value forward on `performance.now()`, so it
keeps correct time indefinitely after the phone disconnects and is immune to a later NTP
jump on the TV. The offset is deliberately not persisted: absent a phone, the receiver
falls back to the device clock. A sender that omits the field is ignored, not trusted.

### QUAD_CORNERS (live, throttled to ~20/sec)
```json
{
  "type": "QUAD_CORNERS",
  "corners": {
    "tl": { "x": 0.10, "y": 0.10 },
    "tr": { "x": 0.90, "y": 0.15 },
    "br": { "x": 0.85, "y": 0.85 },
    "bl": { "x": 0.12, "y": 0.88 }
  }
}
```

### SETUP (once, on Done)
```json
{
  "type": "SETUP",
  "lat": -37.814,
  "lng": 144.963,
  "azimuthOffset": 247.3,
  "corners": {
    "tl": { "x": 0.10, "y": 0.10 },
    "tr": { "x": 0.90, "y": 0.15 },
    "br": { "x": 0.85, "y": 0.85 },
    "bl": { "x": 0.12, "y": 0.88 }
  }
}
```

`azimuthOffset` = compass bearing (°) the user's phone was pointing when they tapped Done.
The receiver rotates its star dome so that compass direction appears at the top of the image.

### LAYERS (any time, including while already RUNNING)
```json
{
  "type": "LAYERS",
  "layers": { "stars": true, "planets": true, "satellites": false }
}
```
Toggles which layers are drawn — the same three groupings the phone app's own HUD uses
(`showStars` / `showPlanets` / `showSatellites`). `planets` bundles the Sun, Moon, and the
8 planets. No recalibration needed; sent from `ProjectorControlSheet` on the phone.

### STATE (receiver → phone, same namespace)
```json
{
  "type": "STATE",
  "appState": "running",
  "lat": -37.814,
  "lng": 144.963,
  "azimuthOffset": 247.3,
  "layers": { "stars": true, "planets": true, "satellites": true },
  "event": "SETUP_APPLIED"
}
```
Sent after applying SETUP/LAYERS, and whenever a phone connects — including reporting
"already running from a persisted setup" after an unattended Chromecast reboot. The phone
surfaces this as `ProjectorSetupManager.receiverState` and uses it to decide whether tapping
the Cast button opens the setup flow or the layer-toggle/recalibrate controls.

---

## Testing the receiver in a browser

Open `index.html` locally (a local server is needed due to CORS on the CDN scripts):

```bash
cd ../skymap-cast
python3 -m http.server 8080
# Open http://localhost:8080
```

Then paste in the browser console:

```javascript
// Step 1 — show calibration overlay with a skewed quad
handleMessage('dev', JSON.stringify({
  type: 'QUAD_CORNERS',
  corners: { tl:{x:0.1,y:0.1}, tr:{x:0.9,y:0.15}, br:{x:0.85,y:0.85}, bl:{x:0.12,y:0.88} }
}))

// Step 2 — finalise (Melbourne, facing NNW)
handleMessage('dev', JSON.stringify({
  type: 'SETUP',
  lat: -37.814, lng: 144.963, azimuthOffset: 337,
  corners: { tl:{x:0.1,y:0.1}, tr:{x:0.9,y:0.15}, br:{x:0.85,y:0.85}, bl:{x:0.12,y:0.88} }
}))
```

You should see stars appear, warped into the skewed quad, with North (and the N compass
marker) pointing in the upper-right direction of the warped image.
