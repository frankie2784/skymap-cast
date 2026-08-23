# SkyMap Cast — Integration Guide

## What was built

```
skymap-cast-receiver/          ← Deploy this folder to GitHub Pages
├── index.html                 ← Fixed: adds the #calibration-svg element
├── js/
│   ├── receiver.js            ← State machine + homography warp + Three.js sky
│   ├── astronomy.js           ← RA/Dec → Alt/Az coordinate math (Astro namespace)
│   └── stars.js               ← ~220 bright stars (mag ≤ 4.5), bvToColor, magToSize

androidApp/.../cast/
├── CastOptionsProvider.kt     ← Registers your Cast App ID with the SDK
├── ProjectorSetupManager.kt   ← Session lifecycle + throttled message sending
└── ProjectorSetupSheet.kt     ← Compose BottomSheet UI (2-step setup flow)
```

---

## Step 1 — Deploy the receiver

```bash
# From the repo root:
git subtree push --prefix skymap-cast-receiver origin gh-pages
# Then enable Pages in GitHub repo settings → Pages → Branch: gh-pages / root
# Your receiver URL will be: https://<you>.github.io/<repo>/
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

Both messages use namespace `urn:x-cast:com.skymap.receiver`.

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

---

## Testing the receiver in a browser

Open `index.html` locally (a local server is needed due to CORS on the CDN scripts):

```bash
cd skymap-cast-receiver
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
