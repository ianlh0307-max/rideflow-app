import { test, assert, assertEqual } from "./harness.js";
import { FIXTURE_GRAPH } from "./fixtures/graph.js";
import { loadWalkGraph } from "../js/walkgraph.js";
import { runPlanRequest } from "../js/plan-request.js";

const N = FIXTURE_GRAPH.nodes;
const request = () => ({
  start: { lat: N[0][0], lng: N[0][1], node: 0, source: "entrance" },
  stops: [
    { id: "ride-b", name: "B", kind: "ride", lat: N[3][0], lng: N[3][1], node: 3, wait: 5, duration: 3, thrill: 3, popularity: 2, kidFriendly: true, minHeightIn: null }
  ],
  plannerInput: {
    prefs: { thrill: "balanced", walking: "balanced", groupSize: 4, food: "skip-food" },
    now: 540, planStart: 540, budgetEnd: 900, mustRideIds: [], lockedNextId: null,
    previousPlan: null, previousWaits: {}, seed: 1, maxIterations: 2000, timeLimitMs: 5000, beamWidth: 50
  }
});

test("runPlanRequest routes along walkways and returns one leg per stop", () => {
  const out = runPlanRequest(loadWalkGraph(FIXTURE_GRAPH), request());
  assertEqual(out.result.plan.ids, ["ride-b"]);
  assertEqual(out.legs.length, 1);
  assertEqual(out.legs[0].length, 5);
  assertEqual(out.estimated, false);
});

test("runPlanRequest falls back to straight lines without a graph", () => {
  const out = runPlanRequest(null, request());
  assertEqual(out.estimated, true);
  assertEqual(out.legs[0], [[N[0][0], N[0][1]], [N[3][0], N[3][1]]]);
});

test("runPlanRequest snaps stops without a node to the nearest walkway", () => {
  const req = request();
  delete req.stops[0].node;
  const out = runPlanRequest(loadWalkGraph(FIXTURE_GRAPH), req);
  assertEqual(out.legs[0].length, 5);
});

test("runPlanRequest reports a baseline for the War Room", () => {
  const out = runPlanRequest(loadWalkGraph(FIXTURE_GRAPH), request());
  assertEqual(out.baseline.rides, 1);
  assert(out.baseline.waitWalkMin > 0);
});
