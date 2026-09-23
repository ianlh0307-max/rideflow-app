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

  return {
    byId,
    points: new Map(stops.map(s => [s.id, enjoyment(s, prefs)])),
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
function optimisticRemaining(state, densities, ctx){
  let minutes = ctx.budgetEnd - state.clock;
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

  while(beam.length){
    const next = [];
    for(const state of beam){
      for(const stop of stops){
        const child = extend(state, stop, ctx);
        if(child) next.push(child);
      }
    }
    if(!next.length) break;

    for(const c of next){
      const missedMeal = ctx.mealWin && !c.meal && c.clock > ctx.mealWin[1];
      c.rank = c.points - ctx.penalty * c.walkMin + MUST_RIDE_WEIGHT * c.must
        + optimisticRemaining(c, densities, ctx) - (missedMeal ? MUST_RIDE_WEIGHT * 10 : 0);
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
