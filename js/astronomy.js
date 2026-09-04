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
      alt: deg(altR),
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

  // ─── Public API ────────────────────────────────────────────────────────────
  // julianDay is exposed for planets.js, which needs it as the time base for
  // planetary orbital elements — no need to duplicate the Meeus formula there.

  return { raDecToAltAz, altAzToXYZ, altAzToXY, julianDay, rad, deg };

})();
