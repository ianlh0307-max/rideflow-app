import { test, assert, assertEqual } from "./harness.js";
import { ride, meal, makePark, baseInput, ringPark, randomPark } from "./fixtures/parks.js";
import { planDay, nearestRidePlan, shouldAdopt, retime, buildContext, evaluate, hashSeed, mulberry32 } from "../js/planner.js";

test("mulberry32 is deterministic and hashSeed is stable", () => {
  const a = mulberry32(5), b = mulberry32(5);
  assertEqual([a(), a(), a()], [b(), b(), b()]);
  assertEqual(hashSeed("magic-kingdom|2026-09-23|540"), hashSeed("magic-kingdom|2026-09-23|540"));
  assert(hashSeed("a") !== hashSeed("b"));
});

test("planDay is deterministic for the same inputs and seed", () => {
  const input = () => baseInput(randomPark(30, 21), { prefs:{ food:"eat-late" } });
  assertEqual(planDay(input()).plan.ids, planDay(input()).plan.ids);
});

test("planDay never exceeds the budget and keeps the locked stop first", () => {
  const r = planDay(baseInput(randomPark(30, 4), { lockedNextId:"p9", budgetEnd: 540 + 200 }));
  assertEqual(r.plan.ids[0], "p9");
  assert(r.plan.end <= 740);
});

test("planDay scores at least as well as the nearest-ride baseline on every fixture", () => {
  for(const park of [ringPark(16), randomPark(30, 5), randomPark(40, 9), randomPark(25, 13)]){
    const input = baseInput(park);
    const plan = planDay(input).plan;
    const baseline = evaluate(nearestRidePlan(input).ids, buildContext(input));
    assert(plan.score >= baseline.score, `plan ${plan.score} < baseline ${baseline.score}`);
  }
});

test("minimize walking walks less than max rides on the same park", () => {
  // Near ride worth 60, far ride (800 m ≈ 10.7 min) worth 72; time for only one.
  const park = () => makePark([ride("near", 100, 0, { thrill:3, popularity:1 }), ride("far", 800, 0, { thrill:3, popularity:2 })]);
  const low = planDay(baseInput(park(), { budgetEnd: 540 + 30, prefs:{ walking:"low" } })).plan;
  const max = planDay(baseInput(park(), { budgetEnd: 540 + 30, prefs:{ walking:"max" } })).plan;
  assertEqual(low.ids, ["near"]);
  assertEqual(max.ids, ["far"]);
  assert(low.walkMin < max.walkMin);
});

test("a must-ride that can't fit produces a warning, not a broken plan", () => {
  const park = makePark([ride("a", 50, 0), ride("huge", 100, 0, { wait:400 })]);
  const r = planDay(baseInput(park, { mustRideIds:["huge"] }));
  assert(r.plan.valid);
  assertEqual(r.warnings, [{ type:"must-ride-no-fit", id:"huge" }]);
});

test("a closed must-ride is reported and the rest still plans (Review Focus 5)", () => {
  const r = planDay(baseInput(ringPark(10), { mustRideIds:["tron-closed"] }));
  assert(r.plan.ids.length > 0);
  assertEqual(r.warnings, [{ type:"must-ride-unavailable", id:"tron-closed" }]);
});

test("planning at or after the budget end returns an empty valid plan (Review Focus 1)", () => {
  const r = planDay(baseInput(ringPark(10), { now: 15 * 60, budgetEnd: 15 * 60, prefs:{ food:"eat-late" } }));
  assert(r.plan.valid);
  assertEqual(r.plan.ids, []);
});

test("a meal window that already passed drops the meal but still plans rides (Review Focus 4)", () => {
  const park = makePark([ride("a", 100, 0), ride("b", 200, 0), meal("m", 50, 0)]);
  const r = planDay(baseInput(park, { now: 16 * 60, planStart: 10 * 60, budgetEnd: 19 * 60, prefs:{ food:"eat-early" } }));
  assertEqual(r.mealStatus, "window-passed");
  assert(r.plan.ids.includes("a") && !r.plan.ids.includes("m"));
});

test("if the meal can't fit with everything else, plan rides and report no-time", () => {
  const park = makePark([ride("a", 10, 0), meal("m", 50, 0, { mealDelay:30 })]);
  const r = planDay(baseInput(park, { now: 700, planStart: 540, budgetEnd: 740, prefs:{ food:"eat-early" } }));
  assertEqual(r.mealStatus, "no-time");
  assert(r.plan.valid);
});

test("a locked stop that closed is reported and dropped", () => {
  const r = planDay(baseInput(ringPark(8), { lockedNextId:"gone" }));
  assertEqual(r.lockDropped, "gone");
  assert(r.plan.valid);
});

test("shouldAdopt: needs 3% more, or more must-rides, or an invalid old plan", () => {
  const ev = (score, mustCount = 0, valid = true) => ({ score, mustCount, valid, ids: [] });
  assert(!shouldAdopt(ev(100), ev(102.9)));
  assert(shouldAdopt(ev(100), ev(103)));
  assert(shouldAdopt(ev(100, 0), ev(50, 1)));
  assert(shouldAdopt(ev(100, 0, false), ev(10)));
  assert(!shouldAdopt(ev(100), ev(200, 0, false)));
});

test("re-planning with no real change keeps the old plan (stability)", () => {
  const input = baseInput(randomPark(30, 8));
  const first = planDay(input);
  const again = planDay({ ...input, previousPlan:{ ids: first.plan.ids, names:{} } });
  assertEqual(again.plan.ids, first.plan.ids);
  assertEqual(again.adopted, false);
  assertEqual(again.reason, null);
});

test("retime drops stops that closed and trims stops that no longer fit", () => {
  const park = makePark([ride("a", 10, 0), ride("b", 20, 0), ride("c", 30, 0)]);
  const ctx = buildContext(baseInput(park, { budgetEnd: 540 + 40 }));
  const ev = retime(["a", "gone", "b", "c"], ctx);
  assertEqual(ev.ids, ["a", "b"]);
  assert(ev.valid);
});

test("a big wait drop that changes the plan is explained", () => {
  const park = () => makePark([ride("a", 100, 0, { wait:5 }), ride("b", 200, 0, { wait:60, popularity:3, name:"Space Mountain" })]);
  const input = baseInput(park(), { budgetEnd: 540 + 40 });
  const first = planDay(input);
  assertEqual(first.plan.ids, ["a"]);
  const p2 = park();
  p2.stops[1].wait = 10;
  const second = planDay({ ...baseInput(p2, { budgetEnd: 540 + 40 }), previousPlan:{ ids:["a"], names:{ a:"a" } }, previousWaits:{ a:5, b:60 } });
  assert(second.adopted);
  assertEqual(second.reason, "Space Mountain dropped to 10 min.");
});

test("a 60-stop park plans within 350 ms", () => {
  const input = baseInput(randomPark(56, 77), { maxIterations: 40000, timeLimitMs: 300, prefs:{ food:"eat-late" } });
  const t = performance.now();
  planDay(input);
  const ms = performance.now() - t;
  assert(ms < 350, `took ${ms.toFixed(0)} ms`);
}, { perf: true });

test("a locked meal stop stays first and isn't reported as closed", () => {
  // Regression: the lock check ran with meals switched off, so a locked meal always looked impossible.
  const park = makePark([ride("a", 100, 0), ride("b", 200, 0), meal("m", 50, 0)]);
  const r = planDay(baseInput(park, { now: 13 * 60 + 40, planStart: 9 * 60, prefs:{ food:"eat-late" }, lockedNextId:"m" }));
  assertEqual(r.plan.ids[0], "m");
  assertEqual(r.lockDropped, null);
});

test("a locked stop that no longer fits unlocks quietly (not 'closed')", () => {
  const park = makePark([ride("a", 100, 0), ride("slow", 50, 0, { wait: 500 })]);
  const r = planDay(baseInput(park, { lockedNextId:"slow" }));
  assertEqual(r.lockDropped, null);
  assert(r.plan.valid && r.plan.ids[0] !== "slow");
});

test("a settings change always re-plans for the new settings and says so", () => {
  // Regression: the 3% stability rule kept the old plan after the guest changed a setting.
  // At 689 m the "near" plan beats "far" by only ~1% under Minimize walking, inside the 3% margin.
  const park = () => makePark([ride("near", 100, 0, { thrill:3, popularity:1 }), ride("far", 689, 0, { thrill:3, popularity:2 })]);
  const oldPlan = planDay(baseInput(park(), { budgetEnd: 540 + 30, prefs:{ walking:"max" } })).plan;
  assertEqual(oldPlan.ids, ["far"]);
  const r = planDay(baseInput(park(), { budgetEnd: 540 + 30, prefs:{ walking:"low" }, prefsChanged: true, previousPlan:{ ids: oldPlan.ids, names:{} } }));
  assertEqual(r.plan.ids, ["near"]);
  assertEqual(r.reason, "Updated for your new settings.");
});

test("a restaurant leaving the shortlist isn't reported as closed; real closures are (review #9)", () => {
  const park = () => makePark([ride("a", 100, 0, { wait:5 }), ride("b", 200, 0, { wait:5, name:"B" }), meal("m-new", 50, 0)]);
  const base = { budgetEnd: 11 * 60 + 120, prefs:{ food:"eat-early" }, now: 11 * 60, planStart: 9 * 60 };
  const swapped = planDay({ ...baseInput(park(), base), previousPlan:{ ids:["m-old", "a"], names:{ "m-old":"Old Cafe", a:"a" }, closed:[] } });
  assert(!/closed/.test(swapped.reason || ""), `reason was: ${swapped.reason}`);
  const closed = planDay({ ...baseInput(park(), base), previousPlan:{ ids:["gone", "a"], names:{ gone:"Space Mountain", a:"a" }, closed:["gone"] } });
  assertEqual(closed.reason, "Space Mountain closed, so your plan changed.");
});
