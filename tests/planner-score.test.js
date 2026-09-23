import { test, assert, assertEqual, assertClose } from "./harness.js";
import { ride, meal, makePark, baseInput } from "./fixtures/parks.js";
import { enjoyment, walkSpeed, mealWindow, buildContext, evaluate, LOAD_UNLOAD_MIN, MEAL_MIN } from "../js/planner.js";

const P = (o = {}) => ({ thrill:"balanced", walking:"balanced", groupSize:4, food:"skip-food", ...o });

test("enjoyment uses the thrill table", () => {
  assertEqual(enjoyment({ kind:"ride", thrill:5, popularity:1 }, P({ thrill:"easy" })), 0);
  assertEqual(enjoyment({ kind:"ride", thrill:3, popularity:1 }, P()), 60);
  assertEqual(enjoyment({ kind:"ride", thrill:4, popularity:1 }, P({ thrill:"extreme" })), 60);
});

test("enjoyment adds popularity, max-rides and big-group bonuses", () => {
  assertEqual(enjoyment({ kind:"ride", thrill:3, popularity:3 }, P()), 85);
  assertEqual(enjoyment({ kind:"ride", thrill:3, popularity:1 }, P({ walking:"max" })), 70);
  assertEqual(enjoyment({ kind:"ride", thrill:3, popularity:1, kidFriendly:true }, P({ groupSize:6 })), 68);
});

test("family friendly cuts rides with a 44 in+ height minimum to a third", () => {
  assertClose(enjoyment({ kind:"ride", thrill:2, popularity:1, minHeightIn:44 }, P({ thrill:"easy" })), 19.8, 1e-9);
});

test("meals are worth zero enjoyment points", () => {
  assertEqual(enjoyment({ kind:"meal" }, P()), 0);
});

test("walkSpeed slows for big groups and family friendly", () => {
  assertEqual(walkSpeed(P()), 75);
  assertClose(walkSpeed(P({ groupSize:6, thrill:"easy" })), 75 * 0.85 * 0.9, 1e-9);
});

test("mealWindow per food plan", () => {
  assertEqual(mealWindow(P({ food:"eat-early" }), 540), [660, 750]);
  assertEqual(mealWindow(P({ food:"eat-early" }), 720), [720, 840]);
  assertEqual(mealWindow(P({ food:"eat-late" }), 540), [810, 900]);
  assertEqual(mealWindow(P({ food:"skip-food" }), 540), null);
});

test("meal window already passed at launch: meal dropped, not required (Review Focus 4)", () => {
  const park = makePark([ride("a", 100, 0), meal("m", 50, 0)]);
  const ctx = buildContext(baseInput(park, { now: 13 * 60, planStart: 13 * 60, prefs:{ food:"eat-early" } }));
  assertEqual(ctx.mealWin, [780, 900]);
  const late = buildContext(baseInput(park, { now: 16 * 60, planStart: 13 * 60, budgetEnd: 20 * 60, prefs:{ food:"eat-early" } }));
  assertEqual(late.mealWin, null);
  assertEqual(late.mealStatus, "window-passed");
  assert(evaluate(["a"], late).valid, "rides-only plan should be valid");
});

test("evaluate times a ride: walk + wait + duration + load/unload", () => {
  const park = makePark([ride("a", 750, 0, { wait:20, duration:5 })]);
  const ctx = buildContext(baseInput(park));
  const ev = evaluate(["a"], ctx);
  assert(ev.valid);
  assertEqual(ev.timeline[0].arrive, 540 + 10);
  assertEqual(ev.timeline[0].start, 570);
  assertEqual(ev.end, 570 + 5 + LOAD_UNLOAD_MIN);
  assertClose(ev.score, 60 - 10, 1e-9);
});

test("evaluate rejects plans that run past the budget", () => {
  const park = makePark([ride("a", 0, 0, { wait:50 })]);
  const ctx = buildContext(baseInput(park, { budgetEnd: 540 + 30 }));
  assert(!evaluate(["a"], ctx).valid);
});

test("evaluate rejects duplicate stops", () => {
  const park = makePark([ride("a", 10, 0)]);
  assert(!evaluate(["a", "a"], buildContext(baseInput(park))).valid);
});

test("shows start at the next listed time at least 5 min after arrival", () => {
  const park = makePark([ride("s", 0, 0, { kind:"show", duration:20, showtimes:[542, 600] })]);
  const ev = evaluate(["s"], buildContext(baseInput(park)));
  assertEqual(ev.timeline[0].start, 600);
  assertEqual(ev.end, 620);
});

test("a meal waits for its window and counts line + 40 min", () => {
  const park = makePark([meal("m", 0, 0, { mealDelay:15 })]);
  const ctx = buildContext(baseInput(park, { prefs:{ food:"eat-early" } }));
  const ev = evaluate(["m"], ctx);
  assert(ev.valid);
  assertEqual(ev.timeline[0].start, 660);
  assertEqual(ev.end, 660 + 15 + MEAL_MIN);
});

test("a required meal makes a meal-less plan invalid", () => {
  const park = makePark([ride("a", 10, 0), meal("m", 0, 0)]);
  const ctx = buildContext(baseInput(park, { prefs:{ food:"eat-early" } }));
  assert(!evaluate(["a"], ctx).valid);
});

test("the locked next stop must come first", () => {
  const park = makePark([ride("a", 10, 0), ride("b", 20, 0)]);
  const ctx = buildContext(baseInput(park, { lockedNextId:"b" }));
  assert(!evaluate(["a", "b"], ctx).valid);
  assert(evaluate(["b", "a"], ctx).valid);
});

test("must-ride bookkeeping: complete, missing and unavailable", () => {
  const park = makePark([ride("a", 10, 0), ride("b", 20, 0)]);
  const ctx = buildContext(baseInput(park, { mustRideIds:["b", "closed-ride"] }));
  assertEqual(ctx.mustIds, ["b"]);
  assertEqual(ctx.unavailableMust, ["closed-ride"]);
  assert(!evaluate(["a"], ctx).complete);
  assert(evaluate(["a", "b"], ctx).complete);
});

test("budget already over: context has no meal and the empty plan is valid", () => {
  const park = makePark([ride("a", 10, 0), meal("m", 0, 0)]);
  const ctx = buildContext(baseInput(park, { now: 17 * 60, budgetEnd: 16 * 60, prefs:{ food:"eat-late" } }));
  assertEqual(ctx.mealWin, null);
  assert(evaluate([], ctx).valid);
  assert(!evaluate(["a"], ctx).valid);
});
