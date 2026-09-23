// Tiny fake parks for planner tests. Positions are metres on a flat plane;
// walking minutes = metres / 75. Matrix index 0 is the start point.

export function ride(id, x, y, o = {}){
  return {
    id, name: o.name || id, kind: o.kind || "ride", x, y,
    wait: o.wait ?? 10, duration: o.duration ?? 5, thrill: o.thrill ?? 3, popularity: o.popularity ?? 1,
    kidFriendly: o.kidFriendly ?? false, minHeightIn: o.minHeightIn ?? null, showtimes: o.showtimes
  };
}

export function meal(id, x, y, o = {}){
  return { id, name: o.name || id, kind: "meal", x, y, mealDelay: o.mealDelay ?? 10 };
}

export function makePark(stops, { start = [0, 0], speed = 75 } = {}){
  const points = [start, ...stops.map(s => [s.x, s.y])];
  const meters = points.map(a => points.map(b => Math.hypot(a[0] - b[0], a[1] - b[1])));
  stops.forEach((s, i) => { s.idx = i + 1; });
  return { stops, matrix: { meters, minutes: meters.map(r => r.map(m => m / speed)) }, startIdx: 0 };
}

export function baseInput(park, over = {}){
  return {
    ...park,
    now: 9 * 60, planStart: 9 * 60, budgetEnd: 15 * 60,
    mustRideIds: [], lockedNextId: null, previousPlan: null, previousWaits: {},
    seed: 42, maxIterations: 20000, timeLimitMs: 10000, beamWidth: 200,
    ...over,
    prefs: { thrill: "balanced", walking: "balanced", groupSize: 4, food: "skip-food", ...(over.prefs || {}) }
  };
}

export function ringPark(n = 16, radius = 400){
  const stops = [];
  for(let i = 0; i < n; i++){
    const a = (i / n) * Math.PI * 2;
    stops.push(ride(`r${i}`, Math.cos(a) * radius, Math.sin(a) * radius + radius, {
      thrill: 1 + (i % 5), popularity: 1 + (i % 3), wait: 5 + (i * 7) % 40
    }));
  }
  return makePark(stops);
}

export function randomPark(n = 30, seed = 7){
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const stops = [];
  for(let i = 0; i < n; i++){
    stops.push(ride(`p${i}`, rnd() * 900 - 450, rnd() * 900, {
      thrill: 1 + Math.floor(rnd() * 5), popularity: 1 + Math.floor(rnd() * 3),
      wait: Math.floor(rnd() * 60), duration: 2 + Math.floor(rnd() * 8)
    }));
  }
  for(let i = 0; i < 4; i++) stops.push(meal(`m${i}`, rnd() * 900 - 450, rnd() * 900, { mealDelay: 5 + i * 5 }));
  return makePark(stops);
}
