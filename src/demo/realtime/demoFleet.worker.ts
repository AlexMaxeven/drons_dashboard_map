export type DemoFleetWorkerStart = {
  type: 'start';
  vehicles: number;
  ticksPerSecond: number;
  center: { lng: number; lat: number };
};

export type DemoFleetWorkerStop = { type: 'stop' };
export type DemoFleetWorkerConfig = { type: 'config'; vehicles?: number; ticksPerSecond?: number };

export type DemoFleetWorkerIn = DemoFleetWorkerStart | DemoFleetWorkerStop | DemoFleetWorkerConfig;

export type DemoFleetUpdate = {
  id: string;
  kind: 'fpv' | 'bomber' | 'fixedWing' | 'mavic';
  region: string;
  flightMin: number;
  lng: number;
  lat: number;
  headingDeg: number;
  speedKmh: number;
  enduranceMinTotal: number;
  enduranceMinLeft: number;
  state: 'active' | 'missing';
  missingReason: 'linkLost' | 'destroyed' | null;
  missingSinceTs: number | null;
  blinkOffsetMs: number;
  ts: number;
  /** Present for ~40% of vehicles: synthetic "already flown" path (oldest → newest). */
  routePolyline?: [number, number][];
};

export type DemoFleetWorkerOut =
  | { type: 'tick'; ts: number; updates: DemoFleetUpdate[]; events: number }
  | { type: 'status'; running: boolean; vehicles: number; ticksPerSecond: number };

type VehicleState = {
  id: string;
  lng: number;
  lat: number;
  headingRad: number;
  speedMps: number;
  home: { lng: number; lat: number };
  kind: 'fpv' | 'bomber' | 'fixedWing' | 'mavic';
  region: string;
  patrolRadiusM: number;
  patrolPhase: number;
  stopUntilTs: number;
  spawnTs: number;
  /** Adds "already flown" minutes so flightMin matches synthetic route history. */
  flightOffsetMin: number;
  enduranceMs: number;
  state: 'active' | 'missing';
  missingReason: 'linkLost' | 'destroyed' | null;
  missingSinceTs: number | null;
  respawnAtTs: number;
  blinkOffsetMs: number;
  routePolyline: [number, number][] | null;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function metersToLatDegrees(m: number) {
  return m / 111_320;
}

function metersToLngDegrees(m: number, atLat: number) {
  return m / (111_320 * Math.cos((atLat * Math.PI) / 180));
}

function softPull(v: VehicleState, target: { lng: number; lat: number }, strength: number) {
  v.lat = v.lat * (1 - strength) + target.lat * strength;
  v.lng = v.lng * (1 - strength) + target.lng * strength;
}

function approxDistanceMeters(a: { lng: number; lat: number }, b: { lng: number; lat: number }) {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLng = (a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function headingTo(from: { lng: number; lat: number }, to: { lng: number; lat: number }) {
  // atan2(x, y) where y ~ north/south, x ~ east/west
  const dLat = (to.lat - from.lat) * 111_320;
  const dLng = (to.lng - from.lng) * 111_320 * Math.cos((from.lat * Math.PI) / 180);
  return Math.atan2(dLng, dLat);
}

/** Walk backward from current pose to fake ~10–15 min of past flight; returns oldest→newest. */
function buildImaginaryPastRoute(
  endLng: number,
  endLat: number,
  headingRad: number,
  speedMps: number,
  durationMinutes: number,
): [number, number][] {
  const dtSec = 25 + Math.floor(Math.random() * 16); // 25–40 s per segment
  const totalSec = durationMinutes * 60;
  const steps = Math.max(10, Math.floor(totalSec / dtSec));
  const backward: [number, number][] = [[endLng, endLat]];
  let lng = endLng;
  let lat = endLat;
  let hr = headingRad;
  const baseSpeed = clamp(speedMps, 4, 50);
  for (let i = 0; i < steps; i++) {
    hr += (Math.random() - 0.5) * 0.22;
    const meters = (baseSpeed * (0.75 + Math.random() * 0.45)) * dtSec;
    lng -= metersToLngDegrees(meters * Math.sin(hr), lat);
    lat -= metersToLatDegrees(meters * Math.cos(hr));
    backward.push([lng, lat]);
  }
  backward.reverse();
  return backward;
}

function assignRoutePolyline(v: VehicleState) {
  if (Math.random() >= 0.4) {
    v.routePolyline = null;
    v.flightOffsetMin = 0;
    return;
  }
  const durationMin = 10 + Math.random() * 5;
  v.routePolyline = buildImaginaryPastRoute(v.lng, v.lat, v.headingRad, v.speedMps, durationMin);
  v.flightOffsetMin = Math.round(durationMin);
}

function syncRoutePolylineTail(v: VehicleState) {
  if (!v.routePolyline || v.routePolyline.length === 0) return;
  v.routePolyline[v.routePolyline.length - 1] = [v.lng, v.lat];
}

function moveForward(v: VehicleState, dtSec: number) {
  const meters = v.speedMps * dtSec;
  v.lat += metersToLatDegrees(meters * Math.cos(v.headingRad));
  v.lng += metersToLngDegrees(meters * Math.sin(v.headingRad), v.lat);
}

function stepCity(v: VehicleState, dtSec: number, nowTs: number) {
  // "City": short moves + occasional stops (traffic lights / pickup).
  if (nowTs < v.stopUntilTs) {
    v.speedMps = 0;
    return;
  }

  // Occasionally stop for 3..15 sec
  if (Math.random() < 0.01) {
    v.stopUntilTs = nowTs + 3000 + Math.random() * 12_000;
    v.speedMps = 0;
    return;
  }

  // Random walk with mild heading drift
  v.headingRad += (Math.random() - 0.5) * 0.45;
  v.speedMps = clamp(v.speedMps + (Math.random() - 0.45) * 1.2, 0, 16); // 0..16 m/s (~0..58 km/h)

  const meters = v.speedMps * dtSec;
  v.lat += metersToLatDegrees(meters * Math.cos(v.headingRad));
  v.lng += metersToLngDegrees(meters * Math.sin(v.headingRad), v.lat);

  // Keep it near its "district"
  softPull(v, v.home, 0.0025);
}

function stepPatrol(v: VehicleState, dtSec: number) {
  // "Patrol": smoother loop around home.
  v.patrolPhase += dtSec * (0.25 + Math.random() * 0.05);
  const r = v.patrolRadiusM;
  const x = Math.cos(v.patrolPhase) * r;
  const y = Math.sin(v.patrolPhase) * r;

  const targetLat = v.home.lat + metersToLatDegrees(y);
  const targetLng = v.home.lng + metersToLngDegrees(x, v.home.lat);

  // Move towards target point (spring-ish)
  const dLat = targetLat - v.lat;
  const dLng = targetLng - v.lng;
  v.lat += dLat * 0.08;
  v.lng += dLng * 0.08;

  // Derive heading/speed from displacement
  const mLat = dLat * 111_320;
  const mLng = dLng * 111_320 * Math.cos((v.lat * Math.PI) / 180);
  const distM = Math.sqrt(mLat * mLat + mLng * mLng);
  v.speedMps = clamp(distM / Math.max(dtSec, 0.01), 0, 22);
  v.headingRad = Math.atan2(mLng, mLat);
}

function stepFpv(v: VehicleState, dtSec: number) {
  // FPV: very fast, twitchy.
  v.headingRad += (Math.random() - 0.5) * 0.35;
  // More realistic: ~50..110 km/h
  v.speedMps = clamp(v.speedMps + (Math.random() - 0.35) * 2.6, 18, 36);

  moveForward(v, dtSec);
}

function stepBomber(v: VehicleState, dtSec: number) {
  // Bomber: bigger and fast, smoother than FPV.
  v.headingRad += (Math.random() - 0.5) * 0.18;
  // More realistic: ~60..130 km/h
  v.speedMps = clamp(v.speedMps + (Math.random() - 0.4) * 2.2, 20, 42);

  moveForward(v, dtSec);
}

function stepFixedWing(v: VehicleState, dtSec: number, nowTs: number) {
  // drone_type_1: long endurance, fast, sometimes loiters.
  if (nowTs < v.stopUntilTs) {
    v.speedMps = 0;
    return;
  }
  // Occasionally "loiter" for 10..40 sec
  if (Math.random() < 0.004) {
    v.stopUntilTs = nowTs + 10_000 + Math.random() * 30_000;
    v.speedMps = 0;
    return;
  }

  // Avoid speed spikes after loiter: change speed smoothly instead of deriving it from a spring displacement.
  v.headingRad += (Math.random() - 0.5) * 0.06;
  v.speedMps = clamp(v.speedMps + (Math.random() - 0.45) * 1.6, 20, 44); // ~72..158 km/h
  moveForward(v, dtSec);
}

function stepMavic(v: VehicleState, dtSec: number, nowTs: number) {
  // drone_type_2: slower, can hover often.
  if (nowTs < v.stopUntilTs) {
    v.speedMps = 0;
    return;
  }
  // Hover, but less than before (so it actually moves).
  if (Math.random() < 0.01) {
    v.stopUntilTs = nowTs + 1500 + Math.random() * 8000;
    v.speedMps = 0;
    return;
  }

  v.headingRad += (Math.random() - 0.5) * 0.22;
  // Slightly faster & more stable: 10..55 km/h most of the time
  v.speedMps = clamp(v.speedMps + (Math.random() - 0.48) * 1.2, 3, 15);

  moveForward(v, dtSec);
}

const CITY_CENTERS = [
  { name: 'Kyiv', lng: 30.5238, lat: 50.4547 },
  { name: 'Zhytomyr', lng: 28.6587, lat: 50.2547 },
  { name: 'Chernihiv', lng: 31.2893, lat: 51.4982 },
  { name: 'Cherkasy', lng: 32.0611, lat: 49.4444 },
  { name: 'BilaTserkva', lng: 30.1121, lat: 49.7968 },
  { name: 'Poltava', lng: 34.5514, lat: 49.5883 },
  { name: 'Brovary', lng: 30.789, lat: 50.511 },
  { name: 'Boryspil', lng: 30.955, lat: 50.352 }
] as const;

function pickSpawnOutsideCities(kyiv: { lng: number; lat: number }) {
  // Spawn mostly from North/South bands, not inside big cities.
  // North band: Chernihiv-ish direction; South band: Cherkasy-ish direction.
  for (let attempt = 0; attempt < 40; attempt++) {
    const north = Math.random() < 0.55;
    const lat = north ? 51.2 + Math.random() * 1.2 : 48.7 + Math.random() * 1.0;
    const lng = 29.2 + Math.random() * 3.6; // roughly west/east around Kyiv
    const p = { lng, lat };

    // Don't spawn in/near cities.
    const tooCloseToCity = CITY_CENTERS.some((c) => approxDistanceMeters(p, c) < 22_000);
    if (tooCloseToCity) continue;

    // Also don't spawn too close to Kyiv (should "fly in" from outside).
    if (approxDistanceMeters(p, kyiv) < 45_000) continue;

    return p;
  }
  // Fallback
  return { lng: kyiv.lng + 1.2, lat: kyiv.lat + 1.0 };
}

const UA_BOUNDS = {
  minLng: 22.1,
  maxLng: 40.2,
  minLat: 44.3,
  maxLat: 52.4,
};

function pickSpawnCorridorSouthEastToNorthEast(kyiv: { lng: number; lat: number }) {
  // User intent: spawns mostly from the south / south-east / east / north-east.
  // We approximate it with 2 boxes and weighted choice.
  //
  // Box A (south + south-east): lat 45..48.8, lng 31.5..38.7
  // Box B (east + north-east):  lat 48.2..52.2, lng 34.0..40.0
  for (let attempt = 0; attempt < 140; attempt++) {
    const useA = Math.random() < 0.62;
    const lat = useA ? 45.0 + Math.random() * 3.8 : 48.2 + Math.random() * 4.0;
    const lng = useA ? 31.5 + Math.random() * 7.2 : 34.0 + Math.random() * 6.0;
    const p = { lng, lat, region: useA ? 'South / South‑East corridor' : 'East / North‑East corridor' };

    // Keep inside rough UA bounds (guard rails).
    if (p.lng < UA_BOUNDS.minLng || p.lng > UA_BOUNDS.maxLng || p.lat < UA_BOUNDS.minLat || p.lat > UA_BOUNDS.maxLat) {
      continue;
    }

    // Should "fly in" visibly.
    if (approxDistanceMeters(p, kyiv) < 180_000) continue;

    // Not inside big cities (these are "outside city" spawns).
    const tooCloseToCity = CITY_CENTERS.some((c) => approxDistanceMeters(p, c) < 22_000);
    if (tooCloseToCity) continue;

    return p;
  }
  return { lng: 37.0, lat: 46.5, region: 'South / South‑East corridor' };
}

function pickSpawnApproachNearCities(kyiv: { lng: number; lat: number }) {
  // 10% "already on approach": closer to cities, as if they've already flown partway.
  // We still keep them outside city center, but noticeably nearer than corridor spawns.
  for (let attempt = 0; attempt < 160; attempt++) {
    const city = CITY_CENTERS[Math.floor(Math.random() * CITY_CENTERS.length)] ?? { name: 'fallback', ...kyiv };
    const angle = Math.random() * Math.PI * 2;
    const radiusM = 8_000 + Math.random() * 22_000; // 8..30 km from city center (near a city)
    const p = {
      lng: city.lng + metersToLngDegrees(Math.cos(angle) * radiusM, city.lat),
      lat: city.lat + metersToLatDegrees(Math.sin(angle) * radiusM),
      region: `${city.name} (approach)`,
    };

    // Not too far: this is an "approach" spawn.
    const dKyiv = approxDistanceMeters(p, kyiv);
    if (dKyiv < 55_000) return p; // close to Kyiv is ok (already near)
    if (dKyiv > 190_000) continue;

    // Keep inside UA-ish bounds.
    if (p.lng < UA_BOUNDS.minLng || p.lng > UA_BOUNDS.maxLng || p.lat < UA_BOUNDS.minLat || p.lat > UA_BOUNDS.maxLat) {
      continue;
    }

    return p;
  }
  return { lng: kyiv.lng + 1.0, lat: kyiv.lat - 0.8, region: 'Kyiv (approach)' };
}

function pickSpawnInCities(kyiv: { lng: number; lat: number }) {
  // For FPV/Bomber: allow spawns in cities.
  const base = CITY_CENTERS[Math.floor(Math.random() * CITY_CENTERS.length)] ?? { name: 'fallback', ...kyiv };
  return {
    lng: base.lng + (Math.random() - 0.5) * 0.18,
    lat: base.lat + (Math.random() - 0.5) * 0.12,
    region: base.name,
  };
}

function respawn(v: VehicleState, nowTs: number, centerFallback: { lng: number; lat: number }) {
  const spawn =
    v.kind === 'fpv' || v.kind === 'bomber'
      ? pickSpawnInCities(centerFallback)
      : Math.random() < 0.1
        ? pickSpawnApproachNearCities(centerFallback)
        : pickSpawnCorridorSouthEastToNorthEast(centerFallback);
  v.home = { lng: spawn.lng, lat: spawn.lat };
  v.region = spawn.region;
  v.lng = spawn.lng + (Math.random() - 0.5) * 0.02;
  v.lat = spawn.lat + (Math.random() - 0.5) * 0.02;
  v.headingRad = Math.random() * Math.PI * 2;
  v.patrolPhase = Math.random() * Math.PI * 2;
  v.stopUntilTs = 0;
  v.spawnTs = nowTs;
  v.state = 'active';
  v.missingReason = null;
  v.missingSinceTs = null;
  assignRoutePolyline(v);
}

function step(v: VehicleState, dtSec: number, nowTs: number, globalCenter: { lng: number; lat: number }) {
  // Everyone flies "mostly to Kyiv" (slightly west), with type-specific noise.
  const target = { lng: globalCenter.lng - 0.08, lat: globalCenter.lat };
  const distToKyivM = approxDistanceMeters({ lng: v.lng, lat: v.lat }, globalCenter);

  // Lifecycle: when endurance is over (or random link loss), mark missing; respawn later (not immediately).
  if (v.state === 'active') {
    const enduranceOver = nowTs - v.spawnTs >= v.enduranceMs;
    // Missing/destroyed should happen mainly near/in Kyiv.
    const nearKyiv = distToKyivM < 28_000;
    const randomLinkLossNearKyiv = nearKyiv && Math.random() < 0.0009;
    if ((enduranceOver && nearKyiv) || randomLinkLossNearKyiv) {
      v.state = 'missing';
      v.missingReason = Math.random() < 0.2 ? 'destroyed' : 'linkLost';
      v.missingSinceTs = nowTs;
      // Wait before showing a "new" drone to avoid chaos.
      const delayMs = 45_000 + Math.random() * 180_000; // 45..225 sec
      v.respawnAtTs = nowTs + delayMs;
      v.speedMps = 0;
      return;
    }
  }

  if (v.state === 'missing') {
    v.speedMps = 0;
    // Stay at last known point until respawn time.
    if (nowTs >= v.respawnAtTs) {
      respawn(v, nowTs, globalCenter);
    }
    return;
  }

  // Guide heading toward target. Noise varies by type (FPV more twitchy).
  const desired = headingTo({ lng: v.lng, lat: v.lat }, target);
  const noise =
    v.kind === 'fpv'
      ? (Math.random() - 0.5) * 0.25
      : v.kind === 'bomber'
        ? (Math.random() - 0.5) * 0.18
        : v.kind === 'fixedWing'
          ? (Math.random() - 0.5) * 0.08
          : (Math.random() - 0.5) * 0.14;
  // Smoothly steer towards desired heading.
  const steerStrength = v.kind === 'fixedWing' ? 0.18 : 0.24;
  v.headingRad = v.headingRad * (1 - steerStrength) + (desired + noise) * steerStrength;

  if (v.kind === 'fpv') stepFpv(v, dtSec);
  else if (v.kind === 'bomber') stepBomber(v, dtSec);
  else if (v.kind === 'fixedWing') stepFixedWing(v, dtSec, nowTs);
  else stepMavic(v, dtSec, nowTs);

  syncRoutePolylineTail(v);

  // Extremely light pull to global center to keep the whole fleet in view if it drifts.
  // Disabled: we now steer explicitly; no need to "teleport-pull" positions.
}

let running = false;
let vehiclesCount = 200;
let ticksPerSecond = 10;
let center = { lng: 30.5238, lat: 50.4547 };
let intervalId: number | null = null;

let vehicles: VehicleState[] = [];

function initVehicles() {
  vehicles = [];
  for (let i = 0; i < vehiclesCount; i++) {
    const id = `veh_${i + 1}`;
    const r = Math.random();
    const kind: VehicleState['kind'] =
      r < 0.4 ? 'mavic' : r < 0.65 ? 'fixedWing' : r < 0.85 ? 'fpv' : 'bomber';

    // Spawn near border (most), but FPV/Bomber can be in cities.
    const home =
      kind === 'fpv' || kind === 'bomber'
        ? pickSpawnInCities(center)
        : Math.random() < 0.1
          ? pickSpawnApproachNearCities(center)
          : pickSpawnCorridorSouthEastToNorthEast(center);

    const enduranceMinTotal = kind === 'fpv' ? 25 : kind === 'bomber' ? 30 : kind === 'fixedWing' ? 240 : 55;

    const enduranceMs = enduranceMinTotal * 60_000;

    vehicles.push({
      id,
      lng: home.lng + (Math.random() - 0.5) * 0.02,
      lat: home.lat + (Math.random() - 0.5) * 0.02,
      headingRad: Math.random() * Math.PI * 2,
      speedMps:
        kind === 'fpv'
          ? 20 + Math.random() * 8
          : kind === 'bomber'
            ? 22 + Math.random() * 10
            : kind === 'fixedWing'
              ? 14 + Math.random() * 8
              : 6 + Math.random() * 4,
      home: { lng: home.lng, lat: home.lat },
      kind,
      region: home.region,
      patrolRadiusM: 300 + Math.random() * 1400,
      patrolPhase: Math.random() * Math.PI * 2,
      stopUntilTs: 0,
      spawnTs: Date.now(),
      flightOffsetMin: 0,
      enduranceMs,
      state: 'active',
      missingReason: null,
      missingSinceTs: null,
      respawnAtTs: 0,
      blinkOffsetMs: Math.floor(Math.random() * 2000),
      routePolyline: null,
    });
    assignRoutePolyline(vehicles[vehicles.length - 1]!);
  }
}

function postStatus() {
  const msg: DemoFleetWorkerOut = {
    type: 'status',
    running,
    vehicles: vehiclesCount,
    ticksPerSecond,
  };
  postMessage(msg);
}

function stop() {
  running = false;
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  postStatus();
}

function start() {
  stop();
  running = true;
  initVehicles();

  const tickMs = Math.max(10, Math.floor(1000 / ticksPerSecond));
  const dtSec = tickMs / 1000;

  intervalId = setInterval(() => {
    const ts = Date.now();
    const updates: DemoFleetUpdate[] = new Array(vehicles.length);
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i]!;
      step(v, dtSec, ts, center);
      const enduranceMinTotal = Math.round(v.enduranceMs / 60_000);
      const enduranceMinLeft = Math.max(0, Math.round((v.enduranceMs - (ts - v.spawnTs)) / 60_000));
      const flightMin = Math.max(0, v.flightOffsetMin + Math.round((ts - v.spawnTs) / 60_000));
      const u: DemoFleetUpdate = {
        id: v.id,
        kind: v.kind,
        region: v.region,
        flightMin,
        lng: v.lng,
        lat: v.lat,
        headingDeg: (v.headingRad * 180) / Math.PI,
        speedKmh: v.speedMps * 3.6,
        enduranceMinTotal,
        enduranceMinLeft,
        state: v.state,
        missingReason: v.missingReason,
        missingSinceTs: v.missingSinceTs,
        blinkOffsetMs: v.blinkOffsetMs,
        ts,
      };
      if (v.routePolyline && v.routePolyline.length >= 2) {
        u.routePolyline = v.routePolyline.map((p) => [p[0], p[1]] as [number, number]);
      }
      updates[i] = u;
    }
    const msg: DemoFleetWorkerOut = { type: 'tick', ts, updates, events: updates.length };
    postMessage(msg);
  }, tickMs) as unknown as number;

  postStatus();
}

addEventListener('message', (e: MessageEvent<DemoFleetWorkerIn>) => {
  const msg = e.data;
  if (msg.type === 'start') {
    vehiclesCount = msg.vehicles;
    ticksPerSecond = msg.ticksPerSecond;
    center = msg.center;
    start();
    return;
  }
  if (msg.type === 'stop') {
    stop();
    return;
  }
  if (msg.type === 'config') {
    if (typeof msg.vehicles === 'number') vehiclesCount = msg.vehicles;
    if (typeof msg.ticksPerSecond === 'number') ticksPerSecond = msg.ticksPerSecond;
    if (running) start();
    else postStatus();
    return;
  }
});

