import { test, assert } from "./harness.js";
import { loadWalkGraph, walkMatrix, metersBetween, pathBetween } from "../js/walkgraph.js";

const SLUGS = ["magic-kingdom", "epcot", "hollywood-studios", "animal-kingdom", "disneyland", "cedar-point", "kings-island"];

for(const slug of SLUGS){
  const json = await fetch(`../data/walkways/${slug}.json`).then(r => r.ok ? r.json() : null);

  test(`${slug}: walkway file loads with nodes, edges, bbox, entrance`, () => {
    assert(json, "file missing");
    assert(json.nodes.length > 100 && json.edges.length > 100, "graph too small");
    assert(Array.isArray(json.bbox) && json.bbox.length === 4, "bbox missing");
    assert(json.anchors.entrance, "entrance anchor missing");
    assert(/OpenStreetMap/.test(json.source), "attribution missing");
  });

  test(`${slug}: every attraction snaps within 60 m`, () => {
    const far = Object.entries(json.anchors).filter(([, a]) => a.kind === "attraction" && !a.exception && a.snapM > 60);
    assert(!far.length, `too far: ${far.map(([id, a]) => `${id} ${a.snapM} m`).join(", ")}`);
  });

  // Spec: ≤ 3× on Magic Kingdom. Other parks have lagoons and rivers (Animal Kingdom's
  // Oasis → Pandora is 3.9×), so they only get a sanity limit that catches broken graphs.
  const maxRatio = slug === "magic-kingdom" ? 3 : 5;
  test(`${slug}: walking is 1–${maxRatio}× straight-line between attractions`, () => {
    const g = loadWalkGraph(json);
    const ids = Object.keys(json.anchors).filter(id => json.anchors[id].kind === "attraction" && !json.anchors[id].exception).slice(0, 12);
    const nodes = ids.map(id => json.anchors[id].node);
    const { meters } = walkMatrix(g, nodes, 75);
    for(let i = 0; i < nodes.length; i++){
      for(let j = i + 1; j < nodes.length; j++){
        const straight = metersBetween(g.nodes[nodes[i]], g.nodes[nodes[j]]);
        if(straight < 40) continue;
        const ratio = meters[i][j] / straight;
        assert(ratio >= 0.999 && ratio <= maxRatio, `${ids[i]} → ${ids[j]} ratio ${ratio.toFixed(2)}`);
      }
    }
  });

  test(`${slug}: path from entrance to an attraction starts and ends at the anchors`, () => {
    const g = loadWalkGraph(json);
    const target = Object.values(json.anchors).find(a => a.kind === "attraction");
    const path = pathBetween(g, json.anchors.entrance.node, target.node);
    assert(path[0] === g.nodes[json.anchors.entrance.node], "path should start at entrance");
    assert(path.at(-1) === g.nodes[target.node], "path should end at the attraction");
  });
}

test("magic-kingdom: walk matrix for 60 stops builds in under 50 ms", async () => {
  const json = await fetch("../data/walkways/magic-kingdom.json").then(r => r.json());
  const g = loadWalkGraph(json);
  const nodes = Object.values(json.anchors).map(a => a.node).slice(0, 60);
  // Best of 3 fresh graphs: measures the algorithm, not a garbage-collection pause.
  let ms = Infinity;
  for(let i = 0; i < 3; i++){
    const fresh = loadWalkGraph(json);
    const t = performance.now();
    walkMatrix(fresh, nodes, 75);
    ms = Math.min(ms, performance.now() - t);
  }
  assert(ms < 50, `took ${ms.toFixed(1)} ms`);
}, { perf: true });
