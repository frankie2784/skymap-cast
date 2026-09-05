/**
 * planets.js — Low-precision Sun/Moon/planet positions for SkyMap Cast Receiver
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Exposes a single global: Planets
 *
 *   const bodies = Planets.compute(new Date());
 *   // -> [{ name, ra, dec, mag, color, sizePx }, ...]  RA/Dec in degrees, J2000-ish
 *
 * This is Paul Schlyter's well-known public-domain "Approximate positions of
 * the planets" algorithm (single first-order Kepler ellipse per body, no
 * perturbation terms) — the standard compact algorithm used by countless
 * lightweight/JS planetariums. Good to roughly 1 arcminute, degrading slowly
 * over years from J2000; that's ample for a projector display of "which
 * planet is that dot."
 *
 * NOT the same engine as the phone app's PlanetEngine (shared/), which is a
 * separately audited, higher-precision implementation (see the 2026-07-10
 * accuracy audit) — the two will disagree by up to a degree or so. That's an
 * intentional trade-off: the receiver needs to keep computing after the phone
 * disconnects, so it carries its own small, dependency-free implementation
 * rather than a copy of the phone's Kotlin engine.
 */

const Planets = (() => {

  const { rad, deg, julianDay } = Astro;

  // Days since 1999-12-31 00:00 UT — the epoch Schlyter's elements are given
  // relative to (very close to J2000, JD 2451543.5).
  function daysSinceEpoch(date) {
    return julianDay(date) - 2451543.5;
  }

  // Solve Kepler's equation E - e*sin(E) = M for eccentric anomaly E (degrees),
  // given mean anomaly M (degrees) and eccentricity e. A few Newton iterations
  // is ample for e < ~0.25 (true of every body below).
  function eccentricAnomalyDeg(mDeg, e) {
    const eDegPerRad = 180 / Math.PI;
    let E = mDeg + e * eDegPerRad * Math.sin(rad(mDeg));
    for (let i = 0; i < 5; i++) {
      const dM = mDeg - (E - e * eDegPerRad * Math.sin(rad(E)));
      const dE = dM / (1 - e * Math.cos(rad(E)));
      E += dE;
    }
    return E;
  }

  // Orbital elements as linear functions of `d` (days since epoch above), per
  // Schlyter. a is in AU for every body except the Moon (Earth radii).
  const ELEMENTS = {
    sun:     d => ({ N: 0,                          i: 0,                        w: 282.9404 + 4.70935e-5  * d, a: 1.000000,                e: 0.016709  - 1.151e-9  * d, M: 356.0470 + 0.9856002585  * d }),
    moon:    d => ({ N: 125.1228 - 0.0529538083 * d, i: 5.1454,                  w: 318.0634 + 0.1643573223* d, a: 60.2666,                  e: 0.054900,                   M: 115.3654 + 13.0649929509 * d }),
    mercury: d => ({ N: 48.3313  + 3.24587e-5   * d, i: 7.0047  + 5.00e-8   * d, w: 29.1241  + 1.01444e-5  * d, a: 0.387098,                 e: 0.205635  + 5.59e-10  * d, M: 168.6562 + 4.0923344368  * d }),
    venus:   d => ({ N: 76.6799  + 2.46590e-5   * d, i: 3.3946  + 2.75e-8   * d, w: 54.8910  + 1.38374e-5  * d, a: 0.723330,                 e: 0.006773  - 1.302e-9  * d, M: 48.0052  + 1.6021302244  * d }),
    mars:    d => ({ N: 49.5574  + 2.11081e-5   * d, i: 1.8497  - 1.78e-8   * d, w: 286.5016 + 2.92961e-5  * d, a: 1.523688,                 e: 0.093405  + 2.516e-9  * d, M: 18.6021  + 0.5240207766  * d }),
    jupiter: d => ({ N: 100.4542 + 2.76854e-5   * d, i: 1.3030  - 1.557e-7  * d, w: 273.8777 + 1.64505e-5  * d, a: 5.20256,                  e: 0.048498  + 4.469e-9  * d, M: 19.8950  + 0.0830853001  * d }),
    saturn:  d => ({ N: 113.6634 + 2.38980e-5   * d, i: 2.4886  - 1.081e-7  * d, w: 339.3939 + 2.97661e-5  * d, a: 9.55475,                  e: 0.055546  - 9.499e-9  * d, M: 316.9670 + 0.0334442282  * d }),
    uranus:  d => ({ N: 74.0005  + 1.3978e-5    * d, i: 0.7733  + 1.9e-8    * d, w: 96.6612  + 3.0565e-5   * d, a: 19.18171 - 1.55e-8  * d,  e: 0.047318  + 7.45e-9  * d, M: 142.5905 + 0.011725806   * d }),
    neptune: d => ({ N: 131.7806 + 3.0173e-5    * d, i: 1.7700  - 2.55e-7   * d, w: 272.8461 - 6.027e-6    * d, a: 30.05826 + 3.313e-8 * d,  e: 0.008606  + 2.15e-9  * d, M: 260.2471 + 0.005995147   * d }),
  };

  // Rough mean apparent magnitude per body — not distance/phase-corrected
  // (that needs a fuller photometric model this receiver doesn't carry).
  // Only used to size/brighten the sprite; good enough for "how prominent
  // does this look."
  const MEAN_MAG = {
    sun: -26.7, moon: -10, mercury: -0.4, venus: -4.4, mars: 0.9,
    jupiter: -2.2, saturn: 0.5, uranus: 5.7, neptune: 7.8,
  };

  const COLOR = {
    sun: '#fff2b0', moon: '#e8e8e8', mercury: '#b8a89a', venus: '#f5deb3',
    mars: '#e07850', jupiter: '#e8c9a0', saturn: '#e8dcb0', uranus: '#a0d8e0', neptune: '#7090e8',
  };

  // Fixed display size in px — a simple stand-in for true brightness/angular-size
  // scaling (which would need distance + phase, more than this receiver tracks).
  const SIZE_PX = {
    sun: 50, moon: 40, mercury: 8, venus: 14, mars: 10,
    jupiter: 12, saturn: 10, uranus: 6, neptune: 6,
  };

  // Position of a body relative to the point its own elements orbit — the Sun
  // for planets (heliocentric), Earth for the Moon (geocentric already).
  function orbitPosition(el) {
    const E  = eccentricAnomalyDeg(el.M, el.e);
    const xv = el.a * (Math.cos(rad(E)) - el.e);
    const yv = el.a * (Math.sqrt(1 - el.e * el.e) * Math.sin(rad(E)));
    const v  = deg(Math.atan2(yv, xv));
    const r  = Math.sqrt(xv * xv + yv * yv);

    const vw = rad(v + el.w);
    const N  = rad(el.N);
    const i  = rad(el.i);
    return {
      x: r * (Math.cos(N) * Math.cos(vw) - Math.sin(N) * Math.sin(vw) * Math.cos(i)),
      y: r * (Math.sin(N) * Math.cos(vw) + Math.cos(N) * Math.sin(vw) * Math.cos(i)),
      z: r * (Math.sin(vw) * Math.sin(i)),
      r,
    };
  }

  // Ecliptic (x,y,z, AU) -> equatorial RA/Dec (degrees).
  function eclipticToEquatorialDeg(x, y, z, d) {
    const oblDeg = 23.4393 - 3.563e-7 * d;
    const obl = rad(oblDeg);
    const xe = x;
    const ye = y * Math.cos(obl) - z * Math.sin(obl);
    const ze = y * Math.sin(obl) + z * Math.cos(obl);
    const ra  = (deg(Math.atan2(ye, xe)) + 360) % 360;
    const dec = deg(Math.atan2(ze, Math.sqrt(xe * xe + ye * ye)));
    return { ra, dec };
  }

  // ─── Moon phase ─────────────────────────────────────────────────────────
  //
  // Illuminated fraction from the Sun-Earth-Moon elongation angle (standard
  // spherical-angle-between-two-sky-points formula, same shape as the alt/az
  // calc in astronomy.js): k = (1 - cos(elongation)) / 2.
  //   elongation = 0°   → Moon right next to the Sun    → k = 0 (new)
  //   elongation = 90°  → k = 0.5 (quarter)
  //   elongation = 180° → Moon opposite the Sun          → k = 1 (full)
  //
  // "Waxing" (growing toward full) vs "waning" needs a signed quantity, which
  // elongation alone doesn't give (it's symmetric) — that comes from whether
  // the Moon's ecliptic longitude leads or trails the Sun's.
  //
  // The receiver's Moon shader (receiver.js) uses {illuminatedFraction, waxing}
  // to mask a flat textured disc into the correct crescent/gibbous shape — see
  // its comment for the geometric derivation. That derivation gets the phase
  // *fraction* and *which side is the bright limb* astronomically right, but
  // approximates the terminator as screen-horizontal rather than computing the
  // true parallactic tilt angle — a deliberate simplification, not an oversight.

  function moonPhase(sunRaDeg, sunDecDeg, moonRaDeg, moonDecDeg, sunLonDeg, moonLonDeg) {
    const sunR  = rad(sunRaDeg),  sunD  = rad(sunDecDeg);
    const moonR = rad(moonRaDeg), moonD = rad(moonDecDeg);
    const cosElong = Math.sin(sunD) * Math.sin(moonD)
                    + Math.cos(sunD) * Math.cos(moonD) * Math.cos(sunR - moonR);
    const illuminatedFraction = (1 - Math.max(-1, Math.min(1, cosElong))) / 2;

    // Signed difference in ecliptic longitude, wrapped to (-180, 180]. Positive
    // means the Moon is east of the Sun along the ecliptic — waxing.
    let dLon = ((moonLonDeg - sunLonDeg + 540) % 360) - 180;
    return { illuminatedFraction, waxing: dLon > 0 };
  }

  /**
   * @returns Array<{ name, ra, dec, mag, color, sizePx, illuminatedFraction?, waxing? }>
   *          for the Sun, Moon, and the eight planets (Mercury..Neptune).
   *          RA/Dec in degrees, geocentric. illuminatedFraction/waxing and
   *          distanceEarthRadii (geocentric distance, for parallax) are only
   *          present on the "moon" entry.
   */
  function compute(date) {
    const d = daysSinceEpoch(date);

    // Sun's geocentric ecliptic position, computed directly from "Earth's
    // orbit as seen from the Sun" (i=0 so z=0) — used both as the Sun's own
    // position and, negated, as Earth's heliocentric position below.
    const sunGeoEcl = orbitPosition(ELEMENTS.sun(d));
    const sunLonDeg = deg(Math.atan2(sunGeoEcl.y, sunGeoEcl.x));

    const out = [];
    let moonRaDec = null, moonLonDeg = null, moonDistanceEarthRadii = null;
    for (const name of Object.keys(ELEMENTS)) {
      let x, y, z;
      if (name === 'sun') {
        ({ x, y, z } = sunGeoEcl);
      } else if (name === 'moon') {
        // Moon's elements are already geocentric. Its `r` is in Earth radii
        // (see ELEMENTS above) — reported so the receiver can apply diurnal
        // parallax, which for the Moon alone is large enough to see; see
        // astronomy.js topocentricAltDeg().
        const moonOrbit = orbitPosition(ELEMENTS.moon(d));
        ({ x, y, z } = moonOrbit);
        moonDistanceEarthRadii = moonOrbit.r;
        moonLonDeg = deg(Math.atan2(y, x));
      } else {
        // Heliocentric planet position + Earth's heliocentric position
        // (= -Sun's geocentric position) = geocentric planet position.
        const helio = orbitPosition(ELEMENTS[name](d));
        x = helio.x + sunGeoEcl.x;
        y = helio.y + sunGeoEcl.y;
        z = helio.z + sunGeoEcl.z;
      }
      const { ra, dec } = eclipticToEquatorialDeg(x, y, z, d);
      if (name === 'moon') moonRaDec = { ra, dec };
      out.push({ name, ra, dec, mag: MEAN_MAG[name], color: COLOR[name], sizePx: SIZE_PX[name] });
    }

    const sun = out.find(b => b.name === 'sun');
    const moon = out.find(b => b.name === 'moon');
    const { illuminatedFraction, waxing } = moonPhase(
      sun.ra, sun.dec, moonRaDec.ra, moonRaDec.dec, sunLonDeg, moonLonDeg,
    );
    moon.illuminatedFraction = illuminatedFraction;
    moon.waxing = waxing;
    moon.distanceEarthRadii = moonDistanceEarthRadii;

    return out;
  }

  return { compute };

})();
