import { test, assert, assertEqual, assertClose } from "./harness.js";
import { FIXTURE_GRAPH } from "./fixtures/graph.js";
import { DETOUR, metersBetween, loadWalkGraph, nearestNode, shortestFrom, walkMatrix, straightMatrix, pathBetween } from "../js/walkgraph.js";

const g = loadWalkGraph(FIXTURE_GRAPH);
const N = FIXTURE_GRAPH.nodes;

test("metersBetween: 0.001° of latitude is about 111 m", () => {
  assertClose(metersBetween([28, -81], [28.001, -81]), 111.2, 0.5);
});

test("shortestFrom walks around the U instead of cutting across", () => {
  const { dist } = shortestFrom(g, 0);
  const walked = FIXTURE_GRAPH.edges.reduce((sum, e) => sum + e[2], 0);
  assertClose(dist[3], walked, 0.001);
  assert(dist[3] > metersBetween(N[0], N[3]) * 2, "walking should be much longer than straight line");
});

test("pathBetween includes the bend point, in walking order", () => {
  assertEqual(pathBetween(g, 0, 3), [N[0], N[1], [28.0005, -80.9992], N[2], N[3]]);
});

test("pathBetween reversed reverses the bend too", () => {
  assertEqual(pathBetween(g, 3, 0), [N[3], N[2], [28.0005, -80.9992], N[1], N[0]]);
});

test("walkMatrix is symmetric with zero diagonal and minutes = meters / speed", () => {
  const { meters, minutes } = walkMatrix(g, [0, 1, 3], 75);
  assertEqual(meters[1][1], 0);
  assertClose(meters[0][2], meters[2][0], 1e-9);
  assertClose(minutes[0][2], meters[0][2] / 75, 1e-9);
});

test("walkMatrix falls back to straight line × detour for unreachable nodes", () => {
  const { meters } = walkMatrix(g, [0, 4], 75);
  assertClose(meters[0][1], metersBetween(N[0], N[4]) * DETOUR, 0.001);
});

test("nearestNode finds the closest node and its distance", () => {
  const { node, snapM } = nearestNode(g, 28.00095, -81.0);
  assertEqual(node, 3);
  assertClose(snapM, 5.6, 0.5);
});

test("straightMatrix applies the detour factor", () => {
  const { meters, minutes } = straightMatrix([N[0], N[3]], 75);
  assertClose(meters[0][1], metersBetween(N[0], N[3]) * DETOUR, 1e-9);
  assertClose(minutes[0][1], meters[0][1] / 75, 1e-9);
});
