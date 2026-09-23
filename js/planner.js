// RideFlow day planner: scores rides against the guest's answers and searches for
// the day that fits the most enjoyment into their time.
// Pure: no DOM, no network, no Date.now(). Times are minutes since park-local midnight.

export const BASE_POINTS = {
  easy:     [60, 60, 35, 10, 0],
  balanced: [35, 50, 60, 55, 40],
  extreme:  [15, 25, 45, 60, 60]
};
export const POPULARITY_BONUS = { 1: 0, 2: 12, 3: 25 };
export const WALK_PENALTY = { low: 1.6, balanced: 1.0, max: 0.8 };
export const LOAD_UNLOAD_MIN = 3;
export const MEAL_MIN = 40;
export const SHOW_ARRIVE_EARLY_MIN = 5;
export const MUST_RIDE_WEIGHT = 1000;
export const ADOPT_MARGIN = 0.03;
export const AVOID_FACTOR = 0.5;    // points kept by rides the guest has already been shown
export const EXPAND_LIMIT = 25;     // beam search: next stops tried per partial day

export function enjoyment(stop, prefs){
  if(stop.kind === "meal") return 0;
  const thrill = Math.min(5, Math.max(1, Math.round(stop.thrill || 3)));
  let points = BASE_POINTS[prefs.thrill][thrill - 1] + (POPULARITY_BONUS[stop.popularity] ?? 0);
  if(prefs.thrill === "easy" && stop.minHeightIn >= 44) points *= 0.33;
  if(prefs.walking === "max") points += 10;
  if(prefs.groupSize >= 6 && stop.kidFriendly) points += 8;
  return points;
}

export function walkSpeed(prefs){
  let speed = 75;
  if(prefs.groupSize >= 6) speed *= 0.85;
  if(prefs.thrill === "easy") speed *= 0.9;
  return speed;
}

export function mealWindow(prefs, planStart){
  if(prefs.food === "eat-early"){
    return planStart > 11 * 60 ? [planStart, planStart + 120] : [11 * 60, 12 * 60 + 30];
  }
  if(prefs.food === "eat-late") return [13 * 60 + 30, 15 * 60];
  return null;
}

export function buildContext(input){
  const { stops, matrix, startIdx = 0, prefs, now, planStart, budgetEnd } = input;
  const byId = new Map(stops.map(s => [s.id, s]));
  const meals = stops.filter(s => s.kind === "meal");

  let mealWin = mealWindow(prefs, planStart);
  let mealStatus = mealWin ? "planned" : "skipped";
  if(mealWin){
    if(!meals.length){ mealWin = null; mealStatus = "no-restaurant"; }
    else if(mealWin[1] < now){ mealWin = null; mealStatus = "window-passed"; }
    else if(mealWin[0] >= budgetEnd || now >= budgetEnd){ mealWin = null; mealStatus = "no-time"; }
  }

  const requestedMust = input.mustRideIds || [];
  const mustIds = requestedMust.filter(id => byId.has(id));
  const lockedId = input.lockedNextId && byId.has(input.lockedNextId) ? input.lockedNextId : null;

  // "Reevaluate" passes the rides already shown; they count for half so other rides get a turn.
  // Must-rides are never made less appealing.
  const avoid = new Set((input.avoidIds || []).filter(id => !mustIds.includes(id)));

  return {
    byId,
    points: new Map(stops.map(s => [s.id, enjoyment(s, prefs) * (avoid.has(s.id) ? AVOID_FACTOR : 1)])),
    rides: stops.filter(s => s.kind !== "meal"),
    meals,
    matrix, startIdx, prefs, now, budgetEnd,
    mealWin, mealStatus,
    mustIds,
    mustSet: new Set(mustIds),
    unavailableMust: requestedMust.filter(id => !byId.has(id)),
    lockedId,
    lockDropped: input.lockedNextId && !lockedId ? input.lockedNextId : null,
    penalty: WALK_PENALTY[prefs.walking] ?? 1
  };
}

export function stopTimes(stop, arrive, ctx){
  if(stop.kind === "meal"){
    if(!ctx.mealWin || arrive > ctx.mealWin[1]) return null;
    const start = Math.max(arrive, ctx.mealWin[0]);
    return { start, end: start + (stop.mealDelay || 0) + MEAL_MIN };
  }
  if(stop.kind === "show" && stop.showtimes?.length){
    const start = stop.showtimes.find(t => t - SHOW_ARRIVE_EARLY_MIN >= arrive);
    return start === undefined ? null : { start, end: start + (stop.duration || 0) };
  }
  const start = arrive + (stop.wait || 0);
  return { start, end: start + (stop.duration || 0) + LOAD_UNLOAD_MIN };
}

export function evaluate(ids, ctx){
  let clock = ctx.now, at = ctx.startIdx;
  let points = 0, walkMin = 0, walkMeters = 0, waitMin = 0, mustCount = 0, meals = 0;
  let valid = true;
  const timeline = [];
  const seen = new Set();

  for(const id of ids){
    const stop = ctx.byId.get(id);
    if(!stop || seen.has(id)){ valid = false; break; }
    seen.add(id);
    const walk = ctx.matrix.minutes[at][stop.idx];
    const arrive = clock + walk;
    const times = stopTimes(stop, arrive, ctx);
    if(!times || times.end > ctx.budgetEnd || (stop.kind === "meal" && meals)){ valid = false; break; }

    const p = ctx.points.get(id);
    timeline.push({ id, arrive, start: times.start, end: times.end, walkMin: walk, waitMin: times.start - arrive, points: p });
    points += p;
    walkMin += walk;
    walkMeters += ctx.matrix.meters[at][stop.idx];
    waitMin += times.start - arrive;
    if(ctx.mustSet.has(id)) mustCount++;
    if(stop.kind === "meal") meals++;
    clock = times.end;
    at = stop.idx;
  }

  if(valid && ctx.lockedId && ids[0] !== ctx.lockedId) valid = false;
  if(valid && ctx.mealWin && !meals) valid = false;

  return {
    ids, valid,
    complete: valid && mustCount === ctx.mustIds.length,
    mustCount,
    score: points - ctx.penalty * walkMin,
    points, walkMin, walkMeters, waitMin,
    end: clock,
    rides: timeline.filter(t => ctx.byId.get(t.id).kind !== "meal").length,
    timeline
  };
}

export function objective(ev){
  return ev.score + MUST_RIDE_WEIGHT * ev.mustCount;
}

// True when a should replace b as the best plan so far.
export function isBetter(a, b){
  if(!b) return true;
  if(a.valid !== b.valid) return a.valid;
  return objective(a) > objective(b);
}

function extend(state, stop, ctx){
  if(state.visited.has(stop.id)) return null;
  if(stop.kind === "meal" && (state.meal || !ctx.mealWin)) return null;
  const walk = ctx.matrix.minutes[state.at][stop.idx];
  const times = stopTimes(stop, state.clock + walk, ctx);
  if(!times || times.end > ctx.budgetEnd) return null;
  const visited = new Set(state.visited);
  visited.add(stop.id);
  return {
    ids: [...state.ids, stop.id],
    visited,
    clock: times.end,
    at: stop.idx,
    points: state.points + ctx.points.get(stop.id),
    walkMin: state.walkMin + walk,
    meal: state.meal || stop.kind === "meal",
    must: state.must + (ctx.mustSet.has(stop.id) ? 1 : 0)
  };
}

// Upper bound on what's still reachable: best value-per-minute rides, zero walking.
// `reserve` holds back time for a meal the day still owes.
function optimisticRemaining(state, densities, ctx, reserve){
  let minutes = ctx.budgetEnd - state.clock - reserve;
  let total = 0;
  for(const d of densities){
    if(minutes <= 0) break;
    if(state.visited.has(d.id)) continue;
    if(d.cost <= minutes){ total += d.value; minutes -= d.cost; }
    else { total += d.value * minutes / d.cost; break; }
  }
  return total;
}

export function beamSearch(ctx, width = 200){
  const densities = ctx.rides
    .map(s => ({ id: s.id, value: ctx.points.get(s.id), cost: (s.wait || 0) + (s.duration || 0) + LOAD_UNLOAD_MIN }))
    .filter(d => d.value > 0)
    .sort((a, b) => b.value / b.cost - a.value / a.cost);

  const root = { ids: [], visited: new Set(), clock: ctx.now, at: ctx.startIdx, points: 0, walkMin: 0, meal: false, must: 0 };
  let beam = [root];
  if(ctx.lockedId){
    const locked = extend(root, ctx.byId.get(ctx.lockedId), ctx);
    if(locked) beam = [locked];
  }

  let best = evaluate(beam[0].ids, ctx);
  const stops = [...ctx.byId.values()];
  // A day that still owes its meal must keep time for it, or meal-less days out-rank
  // every meal-taking one and the beam never finds a valid day.
  const mealCost = ctx.mealWin ? MEAL_MIN + Math.min(...ctx.meals.map(m => m.mealDelay || 0)) : 0;

  while(beam.length){
    const next = [];
    for(const state of beam){
      // Only the most promising next stops; must-rides and meals always stay in.
      const options = stops
        .filter(stop => !state.visited.has(stop.id))
        .map(stop => ({
          stop,
          key: ctx.points.get(stop.id) - ctx.penalty * ctx.matrix.minutes[state.at][stop.idx]
            + (ctx.mustSet.has(stop.id) || stop.kind === "meal" ? MUST_RIDE_WEIGHT : 0)
        }))
        .sort((a, b) => b.key - a.key)
        .slice(0, EXPAND_LIMIT);
      for(const { stop } of options){
        const child = extend(state, stop, ctx);
        if(child) next.push(child);
      }
    }
    if(!next.length) break;

    for(const c of next){
      const owesMeal = ctx.mealWin && !c.meal;
      const missedMeal = owesMeal && (c.clock > ctx.mealWin[1] || c.clock + mealCost > ctx.budgetEnd);
      c.rank = c.points - ctx.penalty * c.walkMin + MUST_RIDE_WEIGHT * c.must
        + optimisticRemaining(c, densities, ctx, owesMeal ? mealCost : 0) - (missedMeal ? MUST_RIDE_WEIGHT * 10 : 0);
    }
    next.sort((a, b) => b.rank - a.rank);

    beam = [];
    const seen = new Set();
    for(const c of next){
      if(beam.length >= width) break;
      const key = `${c.at}|${[...c.visited].sort().join(",")}`;
      if(seen.has(key)) continue;
      seen.add(key);
      beam.push(c);
    }

    for(const c of beam){
      const ev = evaluate(c.ids, ctx);
      if(ev.valid && isBetter(ev, best)) best = ev;
    }
  }
  return best;
}

export function nearestRidePlan(input){
  const ctx = { ...buildContext({ ...input, lockedNextId: null, mustRideIds: [] }), mealWin: null };
  const left = new Set(ctx.rides.map(s => s.id));
  const ids = [];
  let at = ctx.startIdx, clock = ctx.now;

  while(true){
    let pick = null, pickWalk = Infinity;
    for(const id of left){
      const stop = ctx.byId.get(id);
      const walk = ctx.matrix.minutes[at][stop.idx];
      if(walk >= pickWalk) continue;
      const times = stopTimes(stop, clock + walk, ctx);
      if(times && times.end <= ctx.budgetEnd){ pick = stop; pickWalk = walk; }
    }
    if(!pick) break;
    clock = stopTimes(pick, clock + pickWalk, ctx).end;
    at = pick.idx;
    ids.push(pick.id);
    left.delete(pick.id);
  }
  return evaluate(ids, ctx);
}

export function mulberry32(seed){
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(text){
  let h = 2166136261;
  for(const ch of String(text)){
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const MOVES = ["swap", "relocate", "reverse", "drop", "insert", "replace", "restaurant"];

function mutate(ids, ctx, rng){
  const fixed = ctx.lockedId ? 1 : 0;
  const out = ids.slice();
  const n = out.length;
  const pick = (lo, hi) => lo + Math.floor(rng() * (hi - lo));
  const unusedRide = () => {
    const pool = ctx.rides.filter(s => !out.includes(s.id));
    return pool.length ? pool[pick(0, pool.length)].id : null;
  };
  const protectedAt = i => ctx.byId.get(out[i]).kind === "meal" || ctx.mustSet.has(out[i]);

  switch(MOVES[pick(0, MOVES.length)]){
    case "swap": {
      if(n - fixed < 2) return null;
      const i = pick(fixed, n), j = pick(fixed, n);
      if(i === j) return null;
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    }
    case "relocate": {
      if(n - fixed < 2) return null;
      const [moved] = out.splice(pick(fixed, n), 1);
      out.splice(pick(fixed, n), 0, moved);
      return out;
    }
    case "reverse": {
      if(n - fixed < 2) return null;
      let i = pick(fixed, n), j = pick(fixed, n);
      if(i > j) [i, j] = [j, i];
      if(i === j) return null;
      out.splice(i, j - i + 1, ...out.slice(i, j + 1).reverse());
      return out;
    }
    case "drop": {
      const options = [];
      for(let i = fixed; i < n; i++) if(!protectedAt(i)) options.push(i);
      if(!options.length) return null;
      out.splice(options[pick(0, options.length)], 1);
      return out;
    }
    case "insert": {
      const id = unusedRide();
      if(!id) return null;
      out.splice(pick(fixed, n + 1), 0, id);
      return out;
    }
    case "replace": {
      if(n - fixed < 1) return null;
      const id = unusedRide();
      const i = pick(fixed, n);
      if(!id || protectedAt(i)) return null;
      out[i] = id;
      return out;
    }
    case "restaurant": {
      if(!ctx.mealWin || !ctx.meals.length) return null;
      const i = out.findIndex(id => ctx.byId.get(id).kind === "meal");
      const choice = ctx.meals[pick(0, ctx.meals.length)].id;
      if(i === -1){ out.splice(pick(fixed, n + 1), 0, choice); return out; }
      if(i < fixed || out[i] === choice) return null;
      out[i] = choice;
      return out;
    }
  }
  return null;
}

export function anneal(startIds, ctx, { seed = 1, maxIterations = 40000, timeLimitMs = 300, clock = () => performance.now() } = {}){
  const rng = mulberry32(seed);
  let current = evaluate(startIds, ctx);
  let best = current;
  const started = clock();
  const T0 = 20, T1 = 0.5;

  for(let i = 0; i < maxIterations; i++){
    if((i & 255) === 0 && clock() - started > timeLimitMs) break;
    const ids = mutate(current.ids, ctx, rng);
    if(!ids) continue;
    const candidate = evaluate(ids, ctx);
    if(!candidate.valid) continue;
    const temperature = T0 * Math.pow(T1 / T0, i / maxIterations);
    const delta = objective(candidate) - objective(current);
    if(!current.valid || delta >= 0 || rng() < Math.exp(delta / temperature)){
      current = candidate;
      if(isBetter(current, best)) best = current;
    }
  }
  return best;
}

export function retime(prevIds, ctx){
  let ids = prevIds.filter(id => ctx.byId.has(id));
  if(ctx.lockedId) ids = [ctx.lockedId, ...ids.filter(id => id !== ctx.lockedId)];
  let ev = evaluate(ids, ctx);
  const keep = ctx.lockedId ? 1 : 0;
  while(!ev.valid && ids.length > keep){
    ids = ids.slice(0, -1);
    ev = evaluate(ids, ctx);
  }
  return ev;
}

export function shouldAdopt(oldEval, newEval){
  if(!oldEval || !oldEval.valid) return true;
  if(!newEval.valid) return false;
  if(newEval.mustCount !== oldEval.mustCount) return newEval.mustCount > oldEval.mustCount;
  return newEval.score > oldEval.score && newEval.score >= oldEval.score + Math.abs(oldEval.score) * ADOPT_MARGIN;
}

function sameIds(a, b){
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function explainChange(input, newPlan, ctx){
  if(input.prefsChanged) return "Updated for your new settings.";
  const prev = input.previousPlan;
  // Only stops the app reports as closed; a restaurant leaving the shortlist isn't a closure.
  const closed = (prev.closed || []).find(id => prev.ids.includes(id));
  if(closed) return `${prev.names?.[closed] || "A ride on your plan"} closed, so your plan changed.`;

  const waits = input.previousWaits || {};
  let biggest = null;
  for(const id of new Set([...newPlan.ids, ...prev.ids])){
    const stop = ctx.byId.get(id);
    if(!stop || stop.kind === "meal" || waits[id] === undefined) continue;
    const delta = (stop.wait || 0) - waits[id];
    if(Math.abs(delta) >= 10 && (!biggest || Math.abs(delta) > Math.abs(biggest.delta))) biggest = { stop, delta };
  }
  if(!biggest) return "Found a better plan with the latest waits.";
  return biggest.delta < 0
    ? `${biggest.stop.name} dropped to ${biggest.stop.wait} min.`
    : `${biggest.stop.name} rose to ${biggest.stop.wait} min.`;
}

export function planDay(input){
  let ctx = buildContext(input);
  // A locked stop that can no longer fit unlocks quietly; lockDropped is only for closures.
  if(ctx.lockedId){
    const stop = ctx.byId.get(ctx.lockedId);
    const times = stopTimes(stop, ctx.now + ctx.matrix.minutes[ctx.startIdx][stop.idx], ctx);
    if(!times || times.end > ctx.budgetEnd) ctx = { ...ctx, lockedId: null };
  }

  // One time limit covers the whole search: annealing gets what beam search leaves.
  const clock = input.clock || (() => performance.now());
  const limit = input.timeLimitMs ?? 300;
  const search = c => {
    const started = clock();
    const seeded = beamSearch(c, input.beamWidth ?? 200);
    return anneal(seeded.ids, c, {
      seed: input.seed ?? 1,
      maxIterations: input.maxIterations ?? 40000,
      timeLimitMs: Math.max(0, limit - (clock() - started)),
      clock
    });
  };

  let best = search(ctx);
  if(!best.valid && ctx.mealWin){
    ctx = { ...ctx, mealWin: null, mealStatus: "no-time" };
    best = search(ctx);
  }
  if(!best.valid) best = evaluate([], { ...ctx, lockedId: null });

  let adopted = true;
  let reason = null;
  if(input.previousPlan?.ids?.length && !input.force){
    const old = retime(input.previousPlan.ids, ctx);
    // A settings change is the guest asking for a new plan, so stability doesn't apply.
    if(!input.prefsChanged && !shouldAdopt(old, best)){
      best = old;
      adopted = false;
    }else if(!sameIds(old.ids, best.ids)){
      reason = explainChange(input, best, ctx);
    }
  }
  if(ctx.lockDropped) reason = null;

  const warnings = [
    ...ctx.mustIds.filter(id => !best.ids.includes(id)).map(id => ({ type: "must-ride-no-fit", id })),
    ...ctx.unavailableMust.map(id => ({ type: "must-ride-unavailable", id }))
  ];

  return { plan: best, warnings, reason, adopted, mealStatus: ctx.mealStatus, lockDropped: ctx.lockDropped };
}
