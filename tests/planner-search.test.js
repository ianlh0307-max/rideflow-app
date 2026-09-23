import { test, assert, assertEqual } from "./harness.js";
import { ride, meal, makePark, baseInput, ringPark, randomPark } from "./fixtures/parks.js";
import { buildContext, beamSearch, nearestRidePlan, evaluate } from "../js/planner.js";

test("beam search never exceeds the budget", () => {
  const park = randomPark(30, 3);
  const ctx = buildContext(baseInput(park, { budgetEnd: 540 + 120 }));
  const best = beamSearch(ctx);
  assert(best.valid);
  assert(best.end <= 660, `ends at ${best.end}`);
});

test("beam search includes a feasible must-ride even if it's far and slow", () => {
  const park = makePark([ride("near1", 50, 0), ride("near2", 60, 10), ride("near3", 70, 0), ride("far", 1200, 0, { wait:40, thrill:1 })]);
  const ctx = buildContext(baseInput(park, { mustRideIds:["far"], budgetEnd: 540 + 150 }));
  const best = beamSearch(ctx);
  assert(best.ids.includes("far"), JSON.stringify(best.ids));
  assert(best.complete);
});

test("beam search puts the meal inside its window", () => {
  const park = randomPark(20, 11);
  const ctx = buildContext(baseInput(park, { prefs:{ food:"eat-early" } }));
  const best = beamSearch(ctx);
  const m = best.timeline.find(t => ctx.byId.get(t.id).kind === "meal");
  assert(m, "meal missing");
  assert(m.start >= 660 && m.start <= 750, `meal starts ${m.start}`);
});

test("family friendly skips thrill-5 rides when alternatives exist", () => {
  const stops = [ride("big", 30, 0, { thrill:5, wait:0 })];
  for(let i = 0; i < 8; i++) stops.push(ride(`k${i}`, 100 + i * 40, 50, { thrill:1 }));
  const ctx = buildContext(baseInput(makePark(stops), { prefs:{ thrill:"easy" } }));
  assert(!beamSearch(ctx).ids.includes("big"));
});

test("beam search respects the locked next stop", () => {
  const ctx = buildContext(baseInput(ringPark(), { lockedNextId:"r7" }));
  assertEqual(beamSearch(ctx).ids[0], "r7");
});

test("nearestRidePlan always walks to the closest ride that fits", () => {
  const park = makePark([ride("a", 100, 0), ride("b", 50, 0), ride("c", 400, 0)]);
  const ev = nearestRidePlan(baseInput(park));
  assertEqual(ev.ids, ["b", "a", "c"]);
});

test("beam search scores at least as well as nearest-ride on every fixture", () => {
  for(const park of [ringPark(16), randomPark(30, 5), randomPark(40, 9)]){
    const input = baseInput(park);
    const beam = beamSearch(buildContext(input));
    const greedy = nearestRidePlan(input);
    const greedyInBeamTerms = evaluate(greedy.ids, buildContext(input));
    assert(beam.score >= greedyInBeamTerms.score, `beam ${beam.score} < nearest ${greedyInBeamTerms.score}`);
  }
});
