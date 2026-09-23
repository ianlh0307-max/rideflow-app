// Turns an app plan request into planner input (walking matrix included),
// runs the planner, and returns walkway-shaped legs for the map.
// Shared by the worker and the main-thread fallback.
import { nearestNode, walkMatrix, straightMatrix, pathBetween } from "./walkgraph.js";
import { planDay, nearestRidePlan, walkSpeed } from "./planner.js";

export function runPlanRequest(graph, request){
  const speed = walkSpeed(request.plannerInput.prefs);
  const points = [request.start, ...request.stops];

  let nodes = null;
  let matrix;
  if(graph){
    nodes = points.map(p => Number.isInteger(p.node) ? p.node : nearestNode(graph, p.lat, p.lng).node);
    matrix = walkMatrix(graph, nodes, speed);
  }else{
    matrix = straightMatrix(points.map(p => [p.lat, p.lng]), speed);
  }

  const stops = request.stops.map((s, i) => ({ ...s, idx: i + 1 }));
  const input = { ...request.plannerInput, stops, matrix, startIdx: 0 };
  const result = planDay(input);
  const baseline = nearestRidePlan(input);

  const byId = new Map(stops.map(s => [s.id, s]));
  const legs = [];
  let prev = 0;
  for(const id of result.plan.ids){
    const s = byId.get(id);
    legs.push(graph
      ? pathBetween(graph, nodes[prev], nodes[s.idx])
      : [[points[prev].lat, points[prev].lng], [s.lat, s.lng]]);
    prev = s.idx;
  }

  return {
    result,
    baseline: { rides: baseline.rides, waitWalkMin: baseline.waitMin + baseline.walkMin },
    legs,
    estimated: !graph
  };
}
