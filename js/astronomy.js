/**
 * astronomy.js — Coordinate transforms for SkyMap Cast Receiver
 * ══════════════════════════════════════════════════════════════
 *
 * Exposes a single global: Astro
 *
 * Usage:
 *   const { alt, az } = Astro.raDecToAltAz(raDeg, decDeg, latDeg, lngDeg, new Date());
 *   const { x, y, z } = Astro.altAzToXYZ(alt, az);
 *
 * Three.js coordinate convention used throughout:
 *   Y = up (zenith)
 *   -Z = North (az = 0°)
 *   +X = East  (az = 90°)
 *
 * This matches the compass sprite positions in receiver.js:
 *   sprite.position.set(r*sin(az), r*0.05, -r*cos(az))
 */

const Astro = (() => {

  // ─── Angle helpers ─────────────────────────────────────────────────────────

  function rad(deg) { return deg * Math.PI / 180; }
  function deg(r)   { return r * 180 / Math.PI; }

  // ─── Julian Day Number ─────────────────────────────────────────────────────
  //
  // Jean Meeus, "Astronomical Algorithms" ch.7 formula.
  // Works correctly for any Gregorian date.

  function julianDay(date) {
    const Y = date.getUTCFullYear();
    const M = date.getUTCMonth() + 1;   // 1–12
    const D = date.getUTCDate()
              + (date.getUTCHours()
               + date.getUTCMinutes()   / 60
               + date.getUTCSeconds()   / 3600
               + date.getUTCMilliseconds() / 3_600_000) / 24;

    let Yc = Y, Mc = M;
    if (Mc <= 2) { Yc--; Mc += 12; }

    const A = Math.floor(Yc / 100);
    const B = 2 - A + Math.floor(A / 4);   // Gregorian correction

    return Math.floor(365.25  * (Yc + 4716))
         + Math.floor(30.6001 * (Mc + 1))
         + D + B - 1524.5;
  }

  // ─── Greenwich Mean Sidereal Time ──────────────────────────────────────────
  //
  // USNO formula — accurate to ~0.1 arcsec for dates near J2000.
  // Returns GMST in degrees [0, 360).

  function gmstDeg(date) {
    const JD   = julianDay(date);
    // Julian centuries from J2000.0
    const T    = (JD - 2451545.0) / 36525;

    // GMST in seconds of time at 0h UT
    const GMST0 = 24110.54841
                + 8640184.812866 * T
                + 0.093104       * T * T
                - 0.0000062      * T * T * T;

    // Add Earth rotation for the current UT hour
    const UT = (date.getUTCHours()
              + date.getUTCMinutes()   / 60
              + date.getUTCSeconds()   / 3600
              + date.getUTCMilliseconds() / 3_600_000);

    const gmstSeconds = GMST0 + UT * 3600 * 1.00273790935;

    // Convert to degrees and normalise
    return ((gmstSeconds / 240) % 360 + 360) % 360;   // 240 sec = 1 degree
  }

  // ─── Local Sidereal Time ───────────────────────────────────────────────────
  //
  // LST = GMST + observer longitude (east positive)

  function lstDeg(date, lngDeg) {
    return (gmstDeg(date) + lngDeg + 360) % 360;
  }

  // ─── Atmospheric refraction ────────────────────────────────────────────────
  //
  // The atmosphere bends light downward, so every celestial object *appears*
  // higher than its true (airless) altitude — ~0.57° right at the horizon,
  // shrinking to ~1 arcminute at 45° and ~0 at the zenith. Sæmundsson (1986),
  // as a function of true altitude — Meeus, "Astronomical Algorithms" ch.16.
  //
  // Matches AtmosphericRefraction.kt (same formula/constants) on the phone,
  // which applies this correction before sending an object's azimuthDeg/
  // altitudeDeg over in the SELECT cast message. Without also applying it
  // here, the receiver's own stars/planets/satellites render at their true
  // (unrefracted) position while the SELECT ring sits at the phone's apparent
  // (refracted) one — the two drift apart near the horizon where the effect
  // is largest, so the ring stops looking centred on the object it's marking.
  const REFRACTION_MIN_ALT_DEG = -5.0;   // below this the formula blows up; no correction is meaningful anyway

  function refractionDeg(trueAltDeg) {
    if (trueAltDeg < REFRACTION_MIN_ALT_DEG) return 0;
    const argDeg = trueAltDeg + 10.3 / (trueAltDeg + 5.11);
    const arcmin = 1.02 / Math.tan(rad(argDeg));
    return Math.max(0, arcmin / 60);
  }

  function apparentFromTrueDeg(trueAltDeg) {
    return Math.min(90, trueAltDeg + refractionDeg(trueAltDeg));
  }

  // ─── RA / Dec → Altitude / Azimuth ────────────────────────────────────────
  //
  // Standard spherical-trig formula (Meeus ch.13).
  //
  // @param raDeg   Right Ascension (degrees, J2000)
  // @param decDeg  Declination    (degrees, J2000)
  // @param latDeg  Observer latitude   (degrees, north positive)
  // @param lngDeg  Observer longitude  (degrees, east positive)
  // @param date    JavaScript Date object (UTC)
  //
  // @returns { alt, az } both in degrees
  //   alt: altitude above horizon (negative = below horizon)
  //   az:  azimuth from North, clockwise (0=N, 90=E, 180=S, 270=W)

  function raDecToAltAz(raDeg, decDeg, latDeg, lngDeg, date) {
    const LST = lstDeg(date, lngDeg);
    const HA  = ((LST - raDeg) + 360) % 360;   // Hour Angle [0, 360)

    const haR  = rad(HA);
    const decR = rad(decDeg);
    const latR = rad(latDeg);

    // sin(alt) = sin(dec)·sin(lat) + cos(dec)·cos(lat)·cos(HA)
    const sinAlt = Math.sin(decR) * Math.sin(latR)
                 + Math.cos(decR) * Math.cos(latR) * Math.cos(haR);
    const altR   = Math.asin(Math.max(-1, Math.min(1, sinAlt)));

    // cos(A) = [sin(dec) - sin(lat)·sin(alt)] / [cos(lat)·cos(alt)]
    const cosAlt = Math.cos(altR);
    let azR;
    if (cosAlt < 1e-10) {
      // Observer at pole or star at zenith — azimuth undefined, default to North
      azR = 0;
    } else {
      const cosAz = (Math.sin(decR) - Math.sin(latR) * sinAlt)
                  / (Math.cos(latR) * cosAlt);
      azR = Math.acos(Math.max(-1, Math.min(1, cosAz)));
      // Resolve the 0–180° ambiguity: if sin(HA) > 0, object is west of meridian
      if (Math.sin(haR) > 0) azR = 2 * Math.PI - azR;
    }

    return {
      alt: apparentFromTrueDeg(deg(altR)),
      az:  deg(azR),
    };
  }

  // ─── Alt / Az → 3-D unit vector ───────────────────────────────────────────
  //
  // Produces a point on the unit sphere in Three.js dome coordinates:
  //   Y = up (zenith),  -Z = North,  +X = East
  //
  // To place a star in the dome at radius R:
  //   const { x, y, z } = altAzToXYZ(alt, az);
  //   position.set(x * R, y * R, z * R);

  function altAzToXYZ(altDeg, azDeg) {
    const altR = rad(altDeg);
    const azR  = rad(azDeg);
    return {
      x:  Math.cos(altR) * Math.sin(azR),   //  East component
      y:  Math.sin(altR),                    //  Up (zenith)
      z: -Math.cos(altR) * Math.cos(azR),   //  North component (−Z = North)
    };
  }

  // ─── Alt / Az → flat fisheye (equidistant azimuthal) 2-D coordinate ───────
  //
  // Maps the visible hemisphere onto a unit disc — the same projection a real
  // fisheye lens produces, and what DIY dome/wall star projectors are built
  // around: zenith at the centre, horizon at the disc's edge, azimuth angle
  // preserved going around it. Used by the receiver's orthographic render —
  // see receiver.js initScene() for why a full 3-D hemisphere camera doesn't
  // work for a projector (no perspective FOV can show a full 180° hemisphere
  // without infinite edge distortion).
  //
  // @returns { x, y } in [-1, 1] — x: East positive, y: North positive.
  //   Points below the horizon (altDeg < 0) fall outside the unit disc
  //   (radius > 1) rather than being clipped here — callers can use that to
  //   fade or cull them.

  function altAzToXY(altDeg, azDeg) {
    const r   = (90 - altDeg) / 90;
    const azR = rad(azDeg);
    return {
      x: r * Math.sin(azR),
      y: r * Math.cos(azR),
    };
  }

  // ─── Fast path: RA/Dec → world-space XYZ for a whole catalog in one tick ──
  //
  // raDecToAltAz()+altAzToXYZ() each recompute LST (Julian Day + GMST, itself
  // several Date field reads and float ops) and sin(lat)/cos(lat) from
  // scratch — invariant across every star in a single tick's loop, so calling
  // them per-star (as updateStarPositions() used to) redoes that work ~8,870x
  // a second for no reason, and allocates a fresh {alt,az} and {x,y,z} object
  // per star (~17,700 allocations/sec) purely as scratch. On a Chromecast's
  // weak CPU/limited RAM this shows up as a once-a-second frame hitch from
  // both the wasted arithmetic and the GC pressure.
  //
  // Callers hoist the invariants once per tick (see receiver.js
  // updateStarPositions): sinLat/cosLat from the observer's latitude, and
  // LST from lstDeg(date, lngDeg). This writes straight into the caller's
  // Float32Array at `idx`, so a whole catalog update touches zero heap
  // objects. Time: O(1) per star | Space: O(1) (no allocation).
  function raDecToXYZInto(raDeg, decDeg, sinLat, cosLat, LST, radius, arr, idx) {
    const HA  = ((LST - raDeg) + 360) % 360;
    const haR  = rad(HA);
    const decR = rad(decDeg);
    const sinDec = Math.sin(decR);
    const cosDec = Math.cos(decR);
    const cosHA  = Math.cos(haR);

    const sinAlt = Math.max(-1, Math.min(1,
      sinDec * sinLat + cosDec * cosLat * cosHA));
    // altR = asin(sinAlt), but sin(altR) is just sinAlt again — skip the
    // asin()/sin() round trip that raDecToAltAz()+altAzToXYZ() would do.
    const cosAlt = Math.sqrt(1 - sinAlt * sinAlt);

    let azR;
    if (cosAlt < 1e-10) {
      azR = 0;
    } else {
      const cosAz = (sinDec - sinLat * sinAlt) / (cosLat * cosAlt);
      azR = Math.acos(Math.max(-1, Math.min(1, cosAz)));
      if (Math.sin(haR) > 0) azR = 2 * Math.PI - azR;
    }

    // Apparent (refracted) altitude — see refractionDeg()'s doc comment above.
    // Reintroduces the asin/sin round trip this function's fast path
    // otherwise avoids, but only once per star per tick (1/sec), not per
    // frame — negligible next to the ~2ms/tick this already costs.
    const trueAltDeg = deg(Math.asin(sinAlt));
    const appAltR = rad(apparentFromTrueDeg(trueAltDeg));
    const sinAltApp = Math.sin(appAltR);
    const cosAltApp = Math.cos(appAltR);

    arr[idx]     =  cosAltApp * Math.sin(azR) * radius;   // East
    arr[idx + 1] =  sinAltApp * radius;                    // Up
    arr[idx + 2] = -cosAltApp * Math.cos(azR) * radius;   // North
  }

  // ─── Public API ────────────────────────────────────────────────────────────
  // julianDay is exposed for planets.js, which needs it as the time base for
  // planetary orbital elements — no need to duplicate the Meeus formula there.
  // lstDeg is exposed so callers can hoist it once per tick for
  // raDecToXYZInto() instead of recomputing it per star.

  return {
    raDecToAltAz, altAzToXYZ, altAzToXY, raDecToXYZInto, julianDay, lstDeg, rad, deg,
    refractionDeg, apparentFromTrueDeg,
  };

})();
