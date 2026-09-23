// A tiny walkway network: a U-shaped path 0→1→2→3 plus an unreachable node 4.
// Edge 1→2 bends through one intermediate point.
import { metersBetween } from "../../js/walkgraph.js";

const N = [[28.000, -81.000], [28.000, -80.999], [28.001, -80.999], [28.001, -81.000], [28.002, -81.000]];
const bend = [28.0005, -80.9992];
const m = (a, b) => metersBetween(a, b);

export const FIXTURE_GRAPH = {
  park: "fixture",
  nodes: N,
  edges: [
    [0, 1, m(N[0], N[1]), []],
    [1, 2, m(N[1], bend) + m(bend, N[2]), [bend]],
    [2, 3, m(N[2], N[3]), []]
  ],
  anchors: { "ride-a": { node: 0, snapM: 3, kind: "attraction" }, "ride-b": { node: 3, snapM: 4, kind: "attraction" } },
  bbox: [27.999, -81.001, 28.003, -80.998]
};
