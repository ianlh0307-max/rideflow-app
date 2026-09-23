# Walking-Path Routing & Day Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace RideFlow's route builder with a search-based day planner that routes along real park walkways and fits the most enjoyable rides into the guest's time.

**Architecture:** Plain static site, no build step. Walkways are downloaded once per park by a Python script into JSON. Pure ES modules do the work: `walkgraph.js` (shortest paths), `planner.js` (scoring + beam search + simulated annealing), `livedata.js` (park time zones and schedules), and `ridedata.js` (curated ride details). They run inside a Web Worker via `plan-request.js`. `app.js` (today's inline script, moved out of `index.html`) owns the page, fetching and rendering.

**Tech Stack:** HTML/CSS, vanilla JS ES modules, Leaflet 1.9.4 (CDN), Python 3.9 stdlib (tools), headless Chrome for tests. No npm; Node is not installed.

**Spec:** `docs/specs/2026-09-23-walking-path-routing-design.md`

## Global Constraints

- Project root: `~/RideFlow`. All paths below are relative to it.
- Dev server: `python3 -m http.server 8765 --bind 127.0.0.1` run from `~/RideFlow`. ES modules and tests require it; the app is never opened as a `file://` URL.
- Test command: `python3 tests/run.py` (all) or `python3 tests/run.py <name>` (one file, e.g. `planner-day`). It needs the dev server running. Timing tests are skipped headless and run when `http://127.0.0.1:8765/tests/run.html` is opened in normal Chrome.
- No new dependencies: no npm, no pip installs. Python tools use the stdlib only.
- The planner is pure: no DOM, no `fetch`, no `Date.now()`. Time is passed in as minutes since park-local midnight (values may exceed 1440 after midnight).
- Planner constants (verbatim from spec): walking speed 75 m/min (× 0.85 group ≥ 6, × 0.9 thrill `easy`); load/unload 3 min; meal 40 min + restaurant line; walk penalty `low` 1.6 / `balanced` 1.0 / `max` 0.8; beam width 200; annealing T₀ 20 → 0.5; time limit 300 ms (main-thread fallback 150 ms, beam 60); adopt a new plan only if ≥ 3% better; restaurant candidates ≤ 12; straight-line fallback detour × 1.35; GPS usable only if accuracy ≤ 50 m and inside the park bbox; attraction snap warn > 30 m, fail > 60 m.
- Overpass is called only by `tools/build-walkways.py`, with User-Agent `RideFlow/0.1 (walkway build)`. It is never called at runtime.
- Walkway data is credited "© OpenStreetMap contributors (ODbL)" in each data file and in the map attribution.
- Copy: sentence case, plain verbs, no apologies in errors. Times are shown in **park-local** time (`4:15 PM`).
- Commit after every task, with message trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Planning at or after closing time, or with < 15 min left**: the planner returns an empty valid plan and the Next up card says "Not enough time left for another ride" instead of crashing or showing "Route complete". Test in Task 8 (planner) and a check in Task 12 (UI).
2. **The phone is in a different time zone from the park** (planning Disneyland from Florida): every time shown and every meal window uses park-local time. Test in Task 4.
3. **The park closes after midnight** (Halloween events, 1 AM closes): the closing time parses to > 1440 minutes, so the budget isn't negative and the plan isn't empty. Test in Task 4.
4. **The meal window has already passed at launch** (an "eat early" plan started at 1 PM): the meal is dropped with a clear Food banner, and rides are still planned. Test in Task 6 (context) and Task 8 (plan).
5. **A starred must-ride is closed or down**: the rest of the plan builds normally and a warning says "<Ride> is closed right now". Test in Task 8.

---

### Task 1: Move the app script into a module and add the browser test runner

**Files:**
- Create: `js/app.js` (moved from `index.html`'s inline `<script>`)
- Modify: `index.html` (replace inline script with a module tag)
- Create: `tests/harness.js`, `tests/run.html`, `tests/run.py`, `tests/smoke.test.js`

**Interfaces:**
- Produces: `tests/harness.js` exports `test(name, fn, { perf })`, `assert(cond, msg)`, `assertEqual(actual, expected, msg)`, `assertClose(actual, expected, tol, msg)`, `run()`, `realClock`. Every later test file imports from it. `tests/run.html` has a `FILES` array; each later task appends its test file name.
- Produces: `window.showScreen`, `window.toggleMobileMenu`, `window.fetchLiveWaitTimes`, `window.reevaluateRoute`, `window.launchApp` (inline `onclick` handlers and manual debugging need globals; module scope isn't global).

- [ ] **Step 1: Start the dev server (leave it running for the whole plan)**

```bash
cd ~/RideFlow && python3 -m http.server 8765 --bind 127.0.0.1
```

- [ ] **Step 2: Write the test harness**

`tests/harness.js`:

```js
// Minimal browser test harness: register tests, run them, report to tests/run.html.
const tests = [];

// Headless Chrome with a virtual time budget freezes performance.now() during sync code.
export const realClock = (() => {
  const t = performance.now();
  let x = 0;
  for(let i = 0; i < 3e6; i++) x += i;
  return performance.now() - t > 0 && x > 0;
})();

export function test(name, fn, { perf = false } = {}){
  tests.push({ name, fn, perf });
}

export function assert(cond, msg = "assertion failed"){
  if(!cond) throw new Error(msg);
}

export function assertEqual(actual, expected, msg = "values differ"){
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if(a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

export function assertClose(actual, expected, tol, msg = "values not close"){
  if(!(Math.abs(actual - expected) <= tol)) throw new Error(`${msg}: expected ${expected} ± ${tol}, got ${actual}`);
}

export async function run(){
  const results = [];
  for(const t of tests){
    if(t.perf && !realClock){
      results.push({ name:t.name, status:"skip", note:"timing test; open tests/run.html in Chrome to run it" });
      continue;
    }
    try{
      await t.fn();
      results.push({ name:t.name, status:"pass" });
    }catch(err){
      results.push({ name:t.name, status:"fail", note:err.message });
    }
  }
  const count = status => results.filter(r => r.status === status).length;
  return { results, passed:count("pass"), failed:count("fail"), skipped:count("skip") };
}
```

`tests/run.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>RideFlow tests</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;background:#0a0c11;color:#e8ecf4;padding:24px}
  .pass{color:#aeff00} .fail{color:#ff5a5a} .skip{color:#8b95a7}
  pre{white-space:pre-wrap}
</style>
</head>
<body>
<h1>RideFlow tests</h1>
<pre id="summary">RUNNING</pre>
<pre id="failures"></pre>
<ul id="results"></ul>
<script type="module">
import { run } from "./harness.js";

// Each task appends its test file (without ".test.js").
const FILES = ["smoke"];

const only = new URLSearchParams(location.search).get("only");
for(const name of FILES.filter(f => !only || f === only)){
  await import(`./${name}.test.js`);
}

const { results, passed, failed, skipped } = await run();
document.getElementById("results").innerHTML = results.map(r =>
  `<li class="${r.status}">${r.status.toUpperCase()} ${r.name}${r.note ? ` — ${r.note}` : ""}</li>`
).join("");
document.getElementById("failures").textContent = results
  .filter(r => r.status === "fail")
  .map(r => `FAIL: ${r.name} — ${r.note}`)
  .join("\n");
document.getElementById("summary").textContent =
  `${failed ? "FAIL" : "PASS"} ${passed} passed, ${failed} failed, ${skipped} skipped`;
</script>
</body>
</html>
```

`tests/run.py`:

```python
#!/usr/bin/env python3
"""Run RideFlow's browser tests in headless Chrome. Needs the dev server on :8765.

Usage: python3 tests/run.py [test-file-name]
"""
import html
import re
import subprocess
import sys

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
url = "http://127.0.0.1:8765/tests/run.html"
if len(sys.argv) > 1:
    url += f"?only={sys.argv[1]}"

out = subprocess.run(
    [CHROME, "--headless=new", "--disable-gpu", "--virtual-time-budget=120000", "--dump-dom", url],
    capture_output=True, text=True, timeout=240,
).stdout


def block(element_id):
    match = re.search(rf'<pre id="{element_id}">(.*?)</pre>', out, re.S)
    return html.unescape(match.group(1)).strip() if match else ""


failures = block("failures")
if failures:
    print(failures)
summary = block("summary") or "NO RESULT (is the dev server running on :8765?)"
print(summary)
sys.exit(0 if summary.startswith("PASS") else 1)
```

`tests/smoke.test.js`:

```js
import { test, assertEqual } from "./harness.js";

test("harness runs a passing test", () => {
  assertEqual(1 + 1, 2);
});
```

- [ ] **Step 3: Run the runner to verify it works**

Run: `python3 tests/run.py`
Expected: `PASS 1 passed, 0 failed, 0 skipped`

- [ ] **Step 4: Move the inline script into `js/app.js`**

```bash
cd ~/RideFlow && python3 - <<'EOF'
from pathlib import Path
page = Path("index.html")
s = page.read_text()
start = s.index("<script>\nlet selectedPark")
end = s.index("</script>", start)
Path("js/app.js").write_text(s[start + len("<script>\n"):end].rstrip() + "\n")
page.write_text(s[:start] + '<script type="module" src="js/app.js"></script>' + s[end + len("</script>"):])
EOF
```

Append to the end of `js/app.js`:

```js

// index.html's inline onclick handlers call these; module scope isn't global.
Object.assign(window, { showScreen, toggleMobileMenu, fetchLiveWaitTimes, reevaluateRoute, launchApp });
```

- [ ] **Step 5: Verify the app still works**

Open `http://127.0.0.1:8765/index.html` in Chrome. Pick Magic Kingdom, click through the setup, then **Build my route**.
Expected: the map shows numbered route pins, the Next up card shows a ride, the War Room and Settings nav buttons switch screens, and the DevTools console has no errors.

- [ ] **Step 6: Commit**

```bash
git add index.html js/app.js tests/
git commit -m "Move app script into js/app.js and add browser test runner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Walkway graph module

**Files:**
- Create: `js/walkgraph.js`
- Create: `tests/fixtures/graph.js`
- Test: `tests/walkgraph.test.js`
- Modify: `tests/run.html` (add `"walkgraph"` to `FILES`)

**Interfaces:**
- Produces (all in `js/walkgraph.js`):
  - `DETOUR = 1.35`
  - `metersBetween(a: [lat,lng], b: [lat,lng]) → number`
  - `loadWalkGraph(json) → graph` where `graph = { nodes: [lat,lng][], edges: [a, b, meters, [lat,lng][]][], adj: {to, m, edge}[][], anchors, bbox, trees: Map }`
  - `nearestNode(graph, lat, lng) → { node: number, snapM: number }`
  - `shortestFrom(graph, source) → { dist: Float64Array, prevNode: Int32Array, prevEdge: Int32Array }` (cached per source)
  - `walkMatrix(graph, nodes: number[], speedMpm) → { meters: number[][], minutes: number[][] }`
  - `straightMatrix(points: [lat,lng][], speedMpm) → { meters, minutes }`
  - `pathBetween(graph, fromNode, toNode) → [lat,lng][]`
- Produces: `tests/fixtures/graph.js` exports `FIXTURE_GRAPH` (walkway JSON with 5 nodes; node 4 unreachable).

- [ ] **Step 1: Write the fixture and failing tests**

`tests/fixtures/graph.js`:

```js
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
```

`tests/walkgraph.test.js`:

```js
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
```

Add `"walkgraph"` to `FILES` in `tests/run.html`: `const FILES = ["smoke", "walkgraph"];`

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 tests/run.py walkgraph`
Expected: `NO RESULT` or a failure, because `js/walkgraph.js` doesn't exist and the module import fails.

- [ ] **Step 3: Write `js/walkgraph.js`**

```js
// Walkway graph: real walking distances and path shapes between park locations.
// Graph JSON comes from tools/build-walkways.py (data/walkways/<park>.json).

export const DETOUR = 1.35;           // typical walked/straight ratio, used when paths are unknown
const EARTH_RADIUS_M = 6371000;
const TREE_CACHE_LIMIT = 200;

export function metersBetween(a, b){
  const rad = d => d * Math.PI / 180;
  const x = rad(b[1] - a[1]) * Math.cos(rad((a[0] + b[0]) / 2));
  const y = rad(b[0] - a[0]);
  return EARTH_RADIUS_M * Math.hypot(x, y);
}

export function loadWalkGraph(json){
  const adj = Array.from({ length: json.nodes.length }, () => []);
  json.edges.forEach(([a, b, m], edge) => {
    adj[a].push({ to: b, m, edge });
    adj[b].push({ to: a, m, edge });
  });
  return { nodes: json.nodes, edges: json.edges, adj, anchors: json.anchors || {}, bbox: json.bbox || null, trees: new Map() };
}

export function nearestNode(graph, lat, lng){
  let node = -1;
  let snapM = Infinity;
  graph.nodes.forEach((p, i) => {
    const m = metersBetween(p, [lat, lng]);
    if(m < snapM){ snapM = m; node = i; }
  });
  return { node, snapM };
}

class MinHeap{
  constructor(){ this.keys = []; this.vals = []; }
  get size(){ return this.keys.length; }
  push(key, val){
    const K = this.keys, V = this.vals;
    let i = K.length;
    K.push(key); V.push(val);
    while(i > 0){
      const p = (i - 1) >> 1;
      if(K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = key; V[i] = val;
  }
  pop(){
    const K = this.keys, V = this.vals;
    const topKey = K[0], topVal = V[0];
    const key = K.pop(), val = V.pop();
    if(K.length){
      let i = 0;
      const n = K.length;
      while(true){
        let c = 2 * i + 1;
        if(c >= n) break;
        if(c + 1 < n && K[c + 1] < K[c]) c++;
        if(K[c] >= key) break;
        K[i] = K[c]; V[i] = V[c]; i = c;
      }
      K[i] = key; V[i] = val;
    }
    return [topKey, topVal];
  }
}

export function shortestFrom(graph, source){
  const cached = graph.trees.get(source);
  if(cached) return cached;

  const n = graph.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prevNode = new Int32Array(n).fill(-1);
  const prevEdge = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  dist[source] = 0;
  heap.push(0, source);

  while(heap.size){
    const [d, u] = heap.pop();
    if(d > dist[u]) continue;
    for(const { to, m, edge } of graph.adj[u]){
      const nd = d + m;
      if(nd < dist[to]){
        dist[to] = nd;
        prevNode[to] = u;
        prevEdge[to] = edge;
        heap.push(nd, to);
      }
    }
  }

  if(graph.trees.size >= TREE_CACHE_LIMIT) graph.trees.clear();
  const tree = { dist, prevNode, prevEdge };
  graph.trees.set(source, tree);
  return tree;
}

export function walkMatrix(graph, nodes, speedMpm){
  const meters = nodes.map(from => {
    const { dist } = shortestFrom(graph, from);
    return nodes.map(to => Number.isFinite(dist[to])
      ? dist[to]
      : metersBetween(graph.nodes[from], graph.nodes[to]) * DETOUR);
  });
  return { meters, minutes: meters.map(row => row.map(m => m / speedMpm)) };
}

export function straightMatrix(points, speedMpm){
  const meters = points.map(a => points.map(b => metersBetween(a, b) * DETOUR));
  return { meters, minutes: meters.map(row => row.map(m => m / speedMpm)) };
}

export function pathBetween(graph, from, to){
  if(from === to) return [graph.nodes[from]];
  const { prevNode, prevEdge } = shortestFrom(graph, from);
  if(prevNode[to] === -1) return [graph.nodes[from], graph.nodes[to]];

  const hops = [];
  for(let v = to; v !== from; v = prevNode[v]) hops.push([prevNode[v], v, prevEdge[v]]);
  hops.reverse();

  const coords = [graph.nodes[from]];
  for(const [u, v, e] of hops){
    const [a, , , geom = []] = graph.edges[e];
    coords.push(...(a === u ? geom : [...geom].reverse()), graph.nodes[v]);
  }
  return coords;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 tests/run.py walkgraph`
Expected: `PASS 8 passed, 0 failed, 0 skipped`

- [ ] **Step 5: Commit**

```bash
git add js/walkgraph.js tests/fixtures/graph.js tests/walkgraph.test.js tests/run.html
git commit -m "Add walkway graph module with shortest paths and path geometry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Walkway build script and data for all 7 parks

**Files:**
- Create: `tools/build-walkways.py`
- Create: `data/walkways/{magic-kingdom,epcot,hollywood-studios,animal-kingdom,disneyland,cedar-point,kings-island}.json` (generated)
- Test: `tests/walkways-data.test.js`
- Modify: `tests/run.html` (add `"walkways-data"`)

**Interfaces:**
- Consumes: `loadWalkGraph`, `walkMatrix`, `metersBetween`, `pathBetween` from Task 2.
- Produces: `data/walkways/<slug>.json` with `{ park, builtAt, source, bbox:[s,w,n,e], nodes, edges, anchors }`. `anchors[<themeparks id>] = { node, snapM, kind }` where `kind ∈ attraction|show|restaurant`, and `anchors.entrance = { node, snapM, kind:"entrance" }`.

- [ ] **Step 1: Write the data tests (fail until data exists)**

`tests/walkways-data.test.js`:

```js
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
    const far = Object.entries(json.anchors).filter(([, a]) => a.kind === "attraction" && a.snapM > 60);
    assert(!far.length, `too far: ${far.map(([id, a]) => `${id} ${a.snapM} m`).join(", ")}`);
  });

  test(`${slug}: walking is 1–3× straight-line between attractions`, () => {
    const g = loadWalkGraph(json);
    const ids = Object.keys(json.anchors).filter(id => json.anchors[id].kind === "attraction").slice(0, 12);
    const nodes = ids.map(id => json.anchors[id].node);
    const { meters } = walkMatrix(g, nodes, 75);
    for(let i = 0; i < nodes.length; i++){
      for(let j = i + 1; j < nodes.length; j++){
        const straight = metersBetween(g.nodes[nodes[i]], g.nodes[nodes[j]]);
        if(straight < 40) continue;
        const ratio = meters[i][j] / straight;
        assert(ratio >= 0.999 && ratio <= 3, `${ids[i]} → ${ids[j]} ratio ${ratio.toFixed(2)}`);
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
  const t = performance.now();
  walkMatrix(g, nodes, 75);
  const ms = performance.now() - t;
  assert(ms < 50, `took ${ms.toFixed(1)} ms`);
}, { perf: true });
```

Add `"walkways-data"` to `FILES`.

- [ ] **Step 2: Run to verify it fails**

Run: `python3 tests/run.py walkways-data`
Expected: FAIL, with "file missing" for every park (the `fetch` returns 404 and `json` is `null`, so the first test fails and later tests throw).

- [ ] **Step 3: Write `tools/build-walkways.py`**

```python
#!/usr/bin/env python3
"""Download a park's walkways from OpenStreetMap and build RideFlow's walk graph.

Usage:
  python3 tools/build-walkways.py magic-kingdom
  python3 tools/build-walkways.py --all

Writes data/walkways/<slug>.json. Walkway data (c) OpenStreetMap contributors, ODbL.
Only this script talks to Overpass; the app never does.
"""
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "walkways"
USER_AGENT = "RideFlow/0.1 (walkway build)"
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
THEMEPARKS_CHILDREN = "https://api.themeparks.wiki/v1/entity/{}/children"
WALK_TYPES = "footway|pedestrian|path|steps|living_street|corridor"
MARGIN_M = 150
STEPS_FACTOR = 1.3
WARN_SNAP_M = 30
MAX_SNAP_M = 60
PLACE_KINDS = {"ATTRACTION": "attraction", "SHOW": "show", "RESTAURANT": "restaurant"}

# Entrance coordinates are hand-picked (ThemeParks.wiki has none). Verify in Step 5.
PARKS = {
    "magic-kingdom": {"id": "75ea578a-adc8-4116-a54d-dccb60765ef9", "entrance": (28.4162, -81.5812)},
    "epcot": {"id": "47f90d2c-e191-4239-a466-5892ef59a88b", "entrance": (28.3772, -81.5493)},
    "hollywood-studios": {"id": "288747d1-8b4f-4a64-867e-ea7c9b27bad8", "entrance": (28.3578, -81.5573)},
    "animal-kingdom": {"id": "1c84a229-8862-4648-9c71-378ddd2c7693", "entrance": (28.3589, -81.5870)},
    "disneyland": {"id": "7340550b-c14d-4def-80bb-acdb51d49a66", "entrance": (33.8105, -117.9190)},
    "cedar-point": {"id": "c8299e1a-0098-4677-8ead-dd0da204f8dc", "entrance": (41.4798, -82.6832)},
    "kings-island": {"id": "694e1f6e-d6a2-4c86-9749-5da1a9cb8924", "entrance": (39.3450, -84.2688)},
}

# Attractions allowed to snap farther than MAX_SNAP_M (e.g. reached only by boat).
# Add an ID here only after checking it on the map.
SNAP_EXCEPTIONS = {}


def fetch_json(url, data=None, timeout=120):
    request = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def meters(a, b):
    lat1, lng1, lat2, lng2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    x = (lng2 - lng1) * math.cos((lat1 + lat2) / 2)
    return 6371000 * math.hypot(x, lat2 - lat1)


def park_places(park_id):
    """Attractions, shows and restaurants with coordinates, minus far-off outliers."""
    children = fetch_json(THEMEPARKS_CHILDREN.format(park_id))["children"]
    places = [
        c for c in children
        if c.get("entityType") in PLACE_KINDS and (c.get("location") or {}).get("latitude")
    ]
    lats = sorted(c["location"]["latitude"] for c in places)
    lngs = sorted(c["location"]["longitude"] for c in places)
    middle = (lats[len(lats) // 2], lngs[len(lngs) // 2])
    return [c for c in places if meters(middle, point_of(c)) < 3000]


def point_of(place):
    return (place["location"]["latitude"], place["location"]["longitude"])


def bbox_for(points, margin_m):
    lats = [p[0] for p in points]
    lngs = [p[1] for p in points]
    dlat = margin_m / 111320
    dlng = margin_m / (111320 * math.cos(math.radians(sum(lats) / len(lats))))
    return (min(lats) - dlat, min(lngs) - dlng, max(lats) + dlat, max(lngs) + dlng)


def fetch_walkways(bbox):
    s, w, n, e = bbox
    query = (
        f'[out:json][timeout:90];'
        f'way["highway"~"^({WALK_TYPES})$"]["access"!~"^(private|no)$"]'
        f'({s:.6f},{w:.6f},{n:.6f},{e:.6f});out geom;'
    )
    body = urllib.parse.urlencode({"data": query}).encode()
    last_error = None
    for url in OVERPASS:
        for _ in range(2):
            try:
                return fetch_json(url, data=body)["elements"]
            except Exception as err:  # network errors, 429/504, bad JSON
                last_error = err
                print(f"  {url} failed ({err}); retrying", file=sys.stderr)
                time.sleep(5)
    raise SystemExit(f"Overpass unavailable: {last_error}")


def build_graph(ways):
    coord = {}
    adj = defaultdict(dict)
    for way in ways:
        ids, geom = way["nodes"], way["geometry"]
        factor = STEPS_FACTOR if way["tags"].get("highway") == "steps" else 1.0
        for i in range(len(ids) - 1):
            a, b = ids[i], ids[i + 1]
            pa = (geom[i]["lat"], geom[i]["lon"])
            pb = (geom[i + 1]["lat"], geom[i + 1]["lon"])
            coord[a], coord[b] = pa, pb
            if a == b:
                continue
            m = meters(pa, pb) * factor
            if m < adj[a].get(b, math.inf):
                adj[a][b] = m
                adj[b][a] = m
    return coord, adj


def largest_component(adj):
    seen, best = set(), set()
    for start in adj:
        if start in seen:
            continue
        component = {start}
        queue = deque([start])
        seen.add(start)
        while queue:
            u = queue.popleft()
            for v in adj[u]:
                if v not in seen:
                    seen.add(v)
                    component.add(v)
                    queue.append(v)
        if len(component) > len(best):
            best = component
    return best


def collapse(adj, keep):
    """Merge chains of plain path points into single edges between junctions."""
    junctions = {n for n in adj if len(adj[n]) != 2 or n in keep}
    if not junctions:
        junctions = {next(iter(adj))}
    edges, used = [], set()
    for start in junctions:
        for first in adj[start]:
            if (start, first) in used:
                continue
            path, total = [start, first], adj[start][first]
            used.update({(start, first), (first, start)})
            prev, cur = start, first
            while cur not in junctions:
                step = next(n for n in adj[cur] if n != prev)
                total += adj[cur][step]
                used.update({(cur, step), (step, cur)})
                prev, cur = cur, step
                path.append(cur)
            if path[0] != path[-1]:
                edges.append((path[0], path[-1], total, path[1:-1]))
    return junctions, edges


def build(slug):
    park = PARKS[slug]
    print(f"{slug}: fetching places")
    places = park_places(park["id"])
    points = [point_of(c) for c in places] + [park["entrance"]]
    bbox = bbox_for(points, MARGIN_M)

    print(f"{slug}: fetching walkways")
    coord, adj = build_graph(fetch_walkways(bbox))
    component = largest_component(adj)
    adj = {n: {m: w for m, w in adj[n].items() if m in component} for n in component}
    candidates = list(component)

    def snap(point):
        node = min(candidates, key=lambda n: meters(point, coord[n]))
        return node, meters(point, coord[node])

    raw_anchors, problems = {}, []
    for place in places:
        node, dist = snap(point_of(place))
        kind = PLACE_KINDS[place["entityType"]]
        raw_anchors[place["id"]] = (node, dist, kind)
        if kind == "attraction" and dist > WARN_SNAP_M:
            label = f"{place['name']} ({place['id']}) snaps {dist:.0f} m"
            if dist > MAX_SNAP_M and place["id"] not in SNAP_EXCEPTIONS.get(slug, set()):
                problems.append(label)
            else:
                print(f"  warning: {label}")
    node, dist = snap(park["entrance"])
    raw_anchors["entrance"] = (node, dist, "entrance")
    if dist > MAX_SNAP_M:
        problems.append(f"entrance snaps {dist:.0f} m; fix PARKS['{slug}']['entrance']")
    if problems:
        raise SystemExit(f"{slug}: build failed:\n  " + "\n  ".join(problems))

    junctions, edges = collapse(adj, {a[0] for a in raw_anchors.values()})
    order = sorted(junctions)
    index = {n: i for i, n in enumerate(order)}
    rnd = lambda p: [round(p[0], 6), round(p[1], 6)]

    out = {
        "park": slug,
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "Walkways (c) OpenStreetMap contributors, ODbL",
        "bbox": [round(v, 6) for v in bbox],
        "nodes": [rnd(coord[n]) for n in order],
        "edges": [[index[a], index[b], round(m, 1), [rnd(coord[x]) for x in mid]] for a, b, m, mid in edges],
        "anchors": {
            pid: {"node": index[n], "snapM": round(d, 1), "kind": kind}
            for pid, (n, d, kind) in raw_anchors.items()
        },
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{slug}.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    lat, lng = coord[raw_anchors["entrance"][0]]
    print(f"{slug}: {len(out['nodes'])} nodes, {len(out['edges'])} edges, "
          f"{path.stat().st_size // 1024} KB")
    print(f"  entrance check: https://www.openstreetmap.org/?mlat={lat}&mlon={lng}#map=19/{lat}/{lng}")


if __name__ == "__main__":
    targets = list(PARKS) if sys.argv[1:] == ["--all"] else sys.argv[1:]
    if not targets or any(t not in PARKS for t in targets):
        raise SystemExit(f"usage: build-walkways.py <{'|'.join(PARKS)}> | --all")
    for i, slug in enumerate(targets):
        if i:
            time.sleep(10)  # be polite to the public Overpass servers
        build(slug)
```

- [ ] **Step 4: Build all parks**

Run: `python3 tools/build-walkways.py --all`
Expected: for each park, a line like `magic-kingdom: 1400 nodes, 1800 edges, 150 KB` followed by an entrance-check URL. Files over 250 KB mean the collapse step isn't working; stop and investigate.

If a park fails with "snaps N m", open that attraction's coordinates on openstreetmap.org:
- If it's reached only by boat or sits inside a building with no mapped path, add its ID to `SNAP_EXCEPTIONS` (for example `SNAP_EXCEPTIONS = {"magic-kingdom": {"<id>"}}`) and rebuild that park.
- If it's an entrance problem, adjust the `PARKS` entrance coordinate.

- [ ] **Step 5: Verify each entrance by eye**

Open each printed entrance-check URL.
Expected: the marker sits at the park's main gate or turnstiles. If it doesn't, move the `PARKS[slug]["entrance"]` coordinate to the gate and rebuild that park with `python3 tools/build-walkways.py <slug>`.

- [ ] **Step 6: Run the data tests**

Run: `python3 tests/run.py walkways-data`
Expected: `PASS 28 passed, 0 failed, 1 skipped` (the skip is the timing test). Then open `http://127.0.0.1:8765/tests/run.html?only=walkways-data` in Chrome and confirm the timing test passes too.

- [ ] **Step 7: Commit**

```bash
git add tools/build-walkways.py data/walkways/ tests/walkways-data.test.js tests/run.html
git commit -m "Add walkway build script and walk graphs for all 7 parks

Walkway data (c) OpenStreetMap contributors, ODbL.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Park-local time, schedules and show times

**Files:**
- Create: `js/livedata.js`
- Test: `tests/livedata.test.js`
- Modify: `tests/run.html` (add `"livedata"`)

**Interfaces:**
- Produces (all in `js/livedata.js`):
  - `parkClock(date: Date, timeZone) → { date: "YYYY-MM-DD", minutes: number }`
  - `isoToParkMinutes(iso, timeZone, parkDate) → number` (minutes since `parkDate` midnight in park time; +1440 per day after)
  - `closingMinutes(scheduleJson, timeZone, parkDate) → number | null`
  - `showtimeMinutes(showtimes, timeZone, parkDate) → number[]` (sorted)
  - `minutesToClock(minutes) → "4:15 PM"`
  - `formatDuration(minutes) → "1h 40m" | "25 min"`

- [ ] **Step 1: Write the failing tests** (includes Review Focus 2 and 3)

`tests/livedata.test.js`:

```js
import { test, assertEqual } from "./harness.js";
import { parkClock, isoToParkMinutes, closingMinutes, showtimeMinutes, minutesToClock, formatDuration } from "../js/livedata.js";

test("parkClock uses the park's time zone, not the phone's (Disneyland from Florida)", () => {
  const noonInAnaheim = new Date("2026-09-23T19:00:00Z");
  assertEqual(parkClock(noonInAnaheim, "America/Los_Angeles"), { date:"2026-09-23", minutes:720 });
  assertEqual(parkClock(noonInAnaheim, "America/New_York"), { date:"2026-09-23", minutes:900 });
});

test("isoToParkMinutes handles offsets and the next day", () => {
  assertEqual(isoToParkMinutes("2026-09-23T14:30:00-04:00", "America/New_York", "2026-09-23"), 870);
  assertEqual(isoToParkMinutes("2026-09-24T00:30:00-04:00", "America/New_York", "2026-09-23"), 1470);
});

test("closingMinutes: a 1 AM close is 25:00, not 1:00 (after-midnight close)", () => {
  const schedule = { schedule: [
    { date:"2026-09-23", type:"OPERATING", openingTime:"2026-09-23T09:00:00-04:00", closingTime:"2026-09-24T01:00:00-04:00" },
    { date:"2026-09-24", type:"OPERATING", openingTime:"2026-09-24T09:00:00-04:00", closingTime:"2026-09-24T22:00:00-04:00" }
  ]};
  assertEqual(closingMinutes(schedule, "America/New_York", "2026-09-23"), 1500);
});

test("closingMinutes picks the latest OPERATING close and ignores ticketed events", () => {
  const schedule = { schedule: [
    { date:"2026-09-23", type:"OPERATING", closingTime:"2026-09-23T18:00:00-04:00" },
    { date:"2026-09-23", type:"TICKETED_EVENT", closingTime:"2026-09-23T23:59:00-04:00" }
  ]};
  assertEqual(closingMinutes(schedule, "America/New_York", "2026-09-23"), 1080);
});

test("closingMinutes returns null when there is no schedule for today", () => {
  assertEqual(closingMinutes({ schedule: [] }, "America/New_York", "2026-09-23"), null);
  assertEqual(closingMinutes(null, "America/New_York", "2026-09-23"), null);
});

test("showtimeMinutes converts and sorts start times", () => {
  const showtimes = [
    { type:"Performance Time", startTime:"2026-09-23T15:00:00-04:00" },
    { type:"Performance Time", startTime:"2026-09-23T11:30:00-04:00" },
    { type:"Performance Time" }
  ];
  assertEqual(showtimeMinutes(showtimes, "America/New_York", "2026-09-23"), [690, 900]);
});

test("minutesToClock formats park minutes, wrapping past midnight", () => {
  assertEqual(minutesToClock(0), "12:00 AM");
  assertEqual(minutesToClock(615), "10:15 AM");
  assertEqual(minutesToClock(735), "12:15 PM");
  assertEqual(minutesToClock(1500), "1:00 AM");
});

test("formatDuration", () => {
  assertEqual(formatDuration(25), "25 min");
  assertEqual(formatDuration(100), "1h 40m");
  assertEqual(formatDuration(120), "2h 00m");
});
```

Add `"livedata"` to `FILES`.

- [ ] **Step 2: Run to verify it fails**

Run: `python3 tests/run.py livedata`
Expected: `NO RESULT`, because the module is missing.

- [ ] **Step 3: Write `js/livedata.js`**

```js
// Park-local time helpers. Every planner time is "minutes since midnight in the
// park's time zone on the park's date"; times after midnight continue past 1440.

export function parkClock(date, timeZone){
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone, year:"numeric", month:"2-digit", day:"2-digit",
      hour:"2-digit", minute:"2-digit", hourCycle:"h23"
    }).formatToParts(date).map(p => [p.type, p.value])
  );
  return { date:`${parts.year}-${parts.month}-${parts.day}`, minutes:Number(parts.hour) * 60 + Number(parts.minute) };
}

export function isoToParkMinutes(iso, timeZone, parkDate){
  const clock = parkClock(new Date(iso), timeZone);
  const dayOffset = Math.round((Date.parse(clock.date) - Date.parse(parkDate)) / 86400000);
  return clock.minutes + dayOffset * 1440;
}

export function closingMinutes(scheduleJson, timeZone, parkDate){
  const today = (scheduleJson?.schedule || [])
    .filter(s => s.date === parkDate && s.type === "OPERATING" && s.closingTime);
  if(!today.length) return null;
  return Math.max(...today.map(s => isoToParkMinutes(s.closingTime, timeZone, parkDate)));
}

export function showtimeMinutes(showtimes, timeZone, parkDate){
  return (showtimes || [])
    .filter(s => s.startTime)
    .map(s => isoToParkMinutes(s.startTime, timeZone, parkDate))
    .sort((a, b) => a - b);
}

export function minutesToClock(minutes){
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hour24 = Math.floor(m / 60);
  const suffix = hour24 >= 12 ? "PM" : "AM";
  return `${hour24 % 12 || 12}:${String(m % 60).padStart(2, "0")} ${suffix}`;
}

export function formatDuration(minutes){
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m} min`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 tests/run.py livedata`
Expected: `PASS 8 passed, 0 failed, 0 skipped`

- [ ] **Step 5: Commit**

```bash
git add js/livedata.js tests/livedata.test.js tests/run.html
git commit -m "Add park-local time, schedule and showtime helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Curated ride details for all 7 parks

**Files:**
- Create: `js/ridedata.js`
- Create: `tools/draft-rides.py`, `tools/validate-rides.py`, `tools/rides-review.py`
- Create: `data/rides/<slug>.json` × 7, `docs/rides-review.html` (generated)
- Test: `tests/ridedata.test.js`
- Modify: `tests/run.html` (add `"ridedata"`)

**Interfaces:**
- Produces: `rideDetailsFor(details, ride) → { type, thrill, popularity, kidFriendly, minHeightIn, durationMin }` and `fallbackDetails(name, type) → same shape`. `ride` has `{ id, name, type }`.
- Produces: `data/rides/<slug>.json` = `{ "<themeparks id>": { name, type, thrill, popularity, kidFriendly, minHeightIn, durationMin } }`.

- [ ] **Step 1: Write the failing tests**

`tests/ridedata.test.js`:

```js
import { test, assert, assertEqual } from "./harness.js";
import { rideDetailsFor, fallbackDetails } from "../js/ridedata.js";

const SLUGS = ["magic-kingdom", "epcot", "hollywood-studios", "animal-kingdom", "disneyland", "cedar-point", "kings-island"];
const TYPES = ["coaster", "dark-ride", "water", "show", "spinner", "transport", "walkthrough", "play-area", "simulator"];

test("rideDetailsFor returns curated details when present", () => {
  const details = { "abc": { name:"Space Mountain", type:"coaster", thrill:4, popularity:3, kidFriendly:false, minHeightIn:44, durationMin:3 } };
  assertEqual(rideDetailsFor(details, { id:"abc", name:"Space Mountain", type:"ride" }).thrill, 4);
});

test("rideDetailsFor falls back for unknown rides", () => {
  const d = rideDetailsFor({}, { id:"new-1", name:"Brand New Coaster", type:"ride" });
  assertEqual(d.type, "coaster");
  assertEqual(d.popularity, 1);
});

test("fallbackDetails defaults to thrill 3, popularity 1, 5 min", () => {
  assertEqual(fallbackDetails("Mystery Ride", "ride"), { type:"dark-ride", thrill:3, popularity:1, kidFriendly:true, minHeightIn:null, durationMin:5 });
});

test("fallbackDetails recognises shows and kiddie rides", () => {
  assertEqual(fallbackDetails("Country Bear Musical Jamboree", "ride").type, "show");
  assertEqual(fallbackDetails("Dumbo the Flying Elephant", "ride").thrill, 1);
  assertEqual(fallbackDetails("Street Party", "show").type, "show");
});

for(const slug of SLUGS){
  const json = await fetch(`../data/rides/${slug}.json`).then(r => r.ok ? r.json() : null);
  test(`${slug}: ride details are complete and in range`, () => {
    assert(json, "file missing");
    const entries = Object.entries(json);
    assert(entries.length >= 8, "suspiciously few rides");
    for(const [id, d] of entries){
      const where = `${d.name} (${id})`;
      assert(!d.needsReview, `${where} still needs review`);
      assert(TYPES.includes(d.type), `${where} bad type ${d.type}`);
      assert(Number.isInteger(d.thrill) && d.thrill >= 1 && d.thrill <= 5, `${where} bad thrill`);
      assert([1, 2, 3].includes(d.popularity), `${where} bad popularity`);
      assert(typeof d.kidFriendly === "boolean", `${where} bad kidFriendly`);
      assert(d.minHeightIn === null || (d.minHeightIn >= 32 && d.minHeightIn <= 60), `${where} bad height`);
      assert(d.durationMin > 0 && d.durationMin <= 60, `${where} bad duration`);
    }
  });
}
```

Add `"ridedata"` to `FILES`.

- [ ] **Step 2: Run to verify it fails**

Run: `python3 tests/run.py ridedata`
Expected: `NO RESULT` (module missing).

- [ ] **Step 3: Write `js/ridedata.js`**

```js
// Curated ride details (data/rides/<park>.json) with a name-based fallback for
// attractions the file doesn't know about yet.

const warned = new Set();

export function rideDetailsFor(details, ride){
  const curated = details?.[ride.id];
  if(curated) return curated;
  if(!warned.has(ride.id)){
    warned.add(ride.id);
    console.warn(`[RideFlow] missing ride details: ${ride.name} ${ride.id}`);
  }
  return fallbackDetails(ride.name, ride.type);
}

export function fallbackDetails(name, type){
  const n = String(name || "").toLowerCase();
  const has = (...words) => words.some(w => n.includes(w));

  if(type === "show" || has("show", "theater", "theatre", "philharmagic", "presents", "jamboree", "hall of", "musical")){
    return { type:"show", thrill:1, popularity:1, kidFriendly:true, minHeightIn:null, durationMin:15 };
  }
  if(has("coaster", "mountain", "tower", "thunder", "dragster", "force", "drop")){
    return { type:"coaster", thrill:4, popularity:1, kidFriendly:false, minHeightIn:44, durationMin:3 };
  }
  if(has("dumbo", "carousel", "carrousel", "small world", "teacup", "tea cup", "kiddie", "junior", "jr.")){
    return { type:"spinner", thrill:1, popularity:1, kidFriendly:true, minHeightIn:null, durationMin:3 };
  }
  return { type:"dark-ride", thrill:3, popularity:1, kidFriendly:true, minHeightIn:null, durationMin:5 };
}
```

Run: `python3 tests/run.py ridedata`
Expected: the 4 unit tests pass and the 7 per-park tests fail with "file missing".

- [ ] **Step 4: Write `tools/draft-rides.py`**

```python
#!/usr/bin/env python3
"""Create or update data/rides/<slug>.json with every current attraction and show.

Existing entries are kept untouched. New entries get placeholder values and
"needsReview": true; edit them by hand using the rubric in the implementation plan.

Usage: python3 tools/draft-rides.py --all   (or one slug)
"""
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "rides"
PARKS = {
    "magic-kingdom": "75ea578a-adc8-4116-a54d-dccb60765ef9",
    "epcot": "47f90d2c-e191-4239-a466-5892ef59a88b",
    "hollywood-studios": "288747d1-8b4f-4a64-867e-ea7c9b27bad8",
    "animal-kingdom": "1c84a229-8862-4648-9c71-378ddd2c7693",
    "disneyland": "7340550b-c14d-4def-80bb-acdb51d49a66",
    "cedar-point": "c8299e1a-0098-4677-8ead-dd0da204f8dc",
    "kings-island": "694e1f6e-d6a2-4c86-9749-5da1a9cb8924",
}


def children(park_id):
    url = f"https://api.themeparks.wiki/v1/entity/{park_id}/children"
    request = urllib.request.Request(url, headers={"User-Agent": "RideFlow/0.1 (ride draft)"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read())["children"]


def placeholder(name, entity_type):
    if entity_type == "SHOW":
        return {"type": "show", "thrill": 1, "popularity": 1, "kidFriendly": True, "minHeightIn": None, "durationMin": 20}
    return {"type": "dark-ride", "thrill": 3, "popularity": 1, "kidFriendly": True, "minHeightIn": None, "durationMin": 5}


def draft(slug):
    path = OUT_DIR / f"{slug}.json"
    existing = json.loads(path.read_text()) if path.exists() else {}
    added = 0
    for c in children(PARKS[slug]):
        if c.get("entityType") not in ("ATTRACTION", "SHOW") or c["id"] in existing:
            continue
        existing[c["id"]] = {"name": c["name"].strip(), **placeholder(c["name"], c["entityType"]), "needsReview": True}
        added += 1
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ordered = dict(sorted(existing.items(), key=lambda kv: kv[1]["name"].lower()))
    path.write_text(json.dumps(ordered, indent=2, ensure_ascii=False) + "\n")
    print(f"{slug}: {len(ordered)} entries ({added} new)")


if __name__ == "__main__":
    targets = list(PARKS) if sys.argv[1:] == ["--all"] else sys.argv[1:]
    if not targets or any(t not in PARKS for t in targets):
        raise SystemExit(f"usage: draft-rides.py <{'|'.join(PARKS)}> | --all")
    for slug in targets:
        draft(slug)
```

Run: `python3 tools/draft-rides.py --all`
Expected: 7 lines like `magic-kingdom: 43 entries (43 new)`.

- [ ] **Step 5: Curate every entry**

Edit each `data/rides/<slug>.json`. For every entry, set the fields from your knowledge of the attraction using this rubric, then **delete `"needsReview": true`**:

- **type**: `coaster` (any roller coaster) · `dark-ride` (indoor vehicle ride through scenes) · `water` (you may get wet: log flumes, rapids, water coasters) · `show` (theater, stage, parade, street entertainment, character meet) · `spinner` (flat spinning ride: Dumbo, teacups, Astro Orbiter, carousels) · `transport` (railroads, PeopleMover, skyliner-style) · `walkthrough` (trails, treehouses, exhibits) · `play-area` (playgrounds, splash pads) · `simulator` (motion-base: Star Tours, Soarin', Mission: SPACE).
- **thrill** 1–5:
  - 1 = gentle, no drops or speed (carousels, "it's a small world", trains, shows)
  - 2 = mild: slow dark rides with small dips, kiddie spinners (Peter Pan's Flight, Haunted Mansion, Dumbo)
  - 3 = moderate: family coasters, water rides with one drop, simulators (Seven Dwarfs Mine Train, Tiana's Bayou Adventure, Soarin')
  - 4 = intense: major coasters and drops (Space Mountain, TRON Lightcycle / Run, Big Thunder Mountain, Tower of Terror, Expedition Everest, Guardians of the Galaxy: Cosmic Rewind)
  - 5 = extreme: hyper/giga coasters, inversions at speed, free-falls (Millennium Force, Top Thrill 2, Steel Vengeance, Maverick, Diamondback, Orion, Banshee)
- **popularity** 1–3: 3 = the park's 4–6 headliners people plan their day around; 2 = well-loved regulars; 1 = everything else.
- **kidFriendly**: `true` if it has no height requirement and most young kids enjoy it.
- **minHeightIn**: the posted minimum height in inches, or `null`.
- **durationMin**: ride or show length, excluding the queue. If unsure, use the type default: coaster 3 · dark-ride 5 · water 8 · show 20 · spinner 2 · transport 15 · walkthrough 10 · play-area 15 · simulator 5.
- **Street entertainment and character meets** that show up as SHOW entities: `type:"show"`, `thrill:1`, `popularity:1`, `durationMin` 10–15.

- [ ] **Step 6: Write `tools/validate-rides.py` and run it**

```python
#!/usr/bin/env python3
"""Check data/rides/*.json: required fields, value ranges, no needsReview left."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TYPES = {"coaster", "dark-ride", "water", "show", "spinner", "transport", "walkthrough", "play-area", "simulator"}
problems = []
for path in sorted((ROOT / "data" / "rides").glob("*.json")):
    for rid, d in json.loads(path.read_text()).items():
        where = f"{path.stem}: {d.get('name')} ({rid})"
        if d.get("needsReview"):
            problems.append(f"{where}: still needs review")
        if d.get("type") not in TYPES:
            problems.append(f"{where}: bad type {d.get('type')}")
        if d.get("thrill") not in (1, 2, 3, 4, 5):
            problems.append(f"{where}: bad thrill")
        if d.get("popularity") not in (1, 2, 3):
            problems.append(f"{where}: bad popularity")
        if not isinstance(d.get("kidFriendly"), bool):
            problems.append(f"{where}: bad kidFriendly")
        h = d.get("minHeightIn")
        if h is not None and not (32 <= h <= 60):
            problems.append(f"{where}: bad minHeightIn")
        if not (0 < (d.get("durationMin") or 0) <= 60):
            problems.append(f"{where}: bad durationMin")
print("\n".join(problems) or "All ride details valid.")
sys.exit(1 if problems else 0)
```

Run: `python3 tools/validate-rides.py`
Expected: `All ride details valid.`

- [ ] **Step 7: Write `tools/rides-review.py` and generate the review page**

```python
#!/usr/bin/env python3
"""Write docs/rides-review.html: one table per park for the owner to skim."""
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TITLES = {"magic-kingdom": "Magic Kingdom", "epcot": "EPCOT", "hollywood-studios": "Hollywood Studios",
          "animal-kingdom": "Animal Kingdom", "disneyland": "Disneyland", "cedar-point": "Cedar Point",
          "kings-island": "Kings Island"}
sections = []
for slug, title in TITLES.items():
    rides = json.loads((ROOT / "data" / "rides" / f"{slug}.json").read_text())
    rows = "".join(
        f"<tr><td>{html.escape(d['name'])}</td><td>{d['type']}</td><td>{d['thrill']}</td>"
        f"<td>{d['popularity']}</td><td>{'yes' if d['kidFriendly'] else 'no'}</td>"
        f"<td>{d['minHeightIn'] or '—'}</td><td>{d['durationMin']}</td></tr>"
        for d in sorted(rides.values(), key=lambda d: d["name"].lower())
    )
    sections.append(f"<h2>{title} <small>({len(rides)})</small></h2><table><thead><tr><th>Ride</th><th>Type</th>"
                    f"<th>Thrill 1–5</th><th>Popularity 1–3</th><th>Kid-friendly</th><th>Min height (in)</th>"
                    f"<th>Length (min)</th></tr></thead><tbody>{rows}</tbody></table>")
page = f"""<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>RideFlow ride details review</title>
<style>body{{font:14px/1.5 system-ui;background:#0a0c11;color:#e8ecf4;padding:24px;max-width:1000px;margin:auto}}
table{{border-collapse:collapse;width:100%;margin-bottom:32px}}th,td{{text-align:left;padding:6px 10px;border-bottom:1px solid #222834}}
th{{color:#8b95a7;font-weight:600}}small{{color:#8b95a7;font-weight:400}}</style></head><body>
<h1>Ride details review</h1><p>Skim for wrong thrill levels, heights or lengths and tell Claude what to change.</p>
{''.join(sections)}</body></html>"""
(ROOT / "docs" / "rides-review.html").write_text(page)
print("Wrote docs/rides-review.html")
```

Run: `python3 tools/rides-review.py`, then open `http://127.0.0.1:8765/docs/rides-review.html`.
Expected: 7 tables, and every row has values.

- [ ] **Step 8: Run tests**

Run: `python3 tests/run.py ridedata`
Expected: `PASS 11 passed, 0 failed, 0 skipped`

- [ ] **Step 9: Commit**

```bash
git add js/ridedata.js tools/draft-rides.py tools/validate-rides.py tools/rides-review.py data/rides/ docs/rides-review.html tests/ridedata.test.js tests/run.html
git commit -m "Add curated ride details for all 7 parks and review page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Ask the owner to review**

Tell the owner that `http://127.0.0.1:8765/docs/rides-review.html` is ready to skim. Apply any corrections in a follow-up commit (re-run Steps 6–8). Don't block later tasks on this review.

---

### Task 6: Planner scoring and plan evaluation

**Files:**
- Create: `js/planner.js` (scoring, context, evaluation)
- Create: `tests/fixtures/parks.js`
- Test: `tests/planner-score.test.js`
- Modify: `tests/run.html` (add `"planner-score"`)

**Interfaces:**
- Stop (planner input): `{ id, name, kind: "ride"|"show"|"meal", idx, wait, duration, thrill, popularity, kidFriendly, minHeightIn, showtimes?: number[], mealDelay?: number }`. `idx` indexes the matrix; index 0 is the start point.
- Produces (in `js/planner.js`): constants `BASE_POINTS`, `POPULARITY_BONUS`, `WALK_PENALTY`, `LOAD_UNLOAD_MIN`, `MEAL_MIN`, `SHOW_ARRIVE_EARLY_MIN`, `MUST_RIDE_WEIGHT`, `ADOPT_MARGIN`; `enjoyment(stop, prefs)`, `walkSpeed(prefs)`, `mealWindow(prefs, planStart) → [start,end] | null`, `buildContext(input) → ctx`, `stopTimes(stop, arrive, ctx) → {start,end} | null`, `evaluate(ids, ctx) → Evaluation`, `objective(ev)`, `isBetter(a, b)`.
- `Evaluation = { ids, valid, complete, mustCount, score, points, walkMin, walkMeters, waitMin, end, rides, timeline: [{ id, arrive, start, end, walkMin, waitMin, points }] }`
- `ctx = { byId, points, rides, meals, matrix, startIdx, prefs, now, budgetEnd, mealWin, mealStatus, mustIds, mustSet, unavailableMust, lockedId, lockDropped, penalty }`. `mealStatus ∈ "planned"|"skipped"|"window-passed"|"no-time"|"no-restaurant"`.
- Produces: `tests/fixtures/parks.js` exports `ride(id, x, y, opts)`, `meal(id, x, y, opts)`, `makePark(stops, opts)`, `baseInput(park, overrides)`, `ringPark(n, radius)`, `randomPark(n, seed)`.

- [ ] **Step 1: Write the fixture module**

`tests/fixtures/parks.js`:

```js
// Tiny fake parks for planner tests. Positions are metres on a flat plane;
// walking minutes = metres / 75. Matrix index 0 is the start point.

export function ride(id, x, y, o = {}){
  return {
    id, name: o.name || id, kind: o.kind || "ride", x, y,
    wait: o.wait ?? 10, duration: o.duration ?? 5, thrill: o.thrill ?? 3, popularity: o.popularity ?? 1,
    kidFriendly: o.kidFriendly ?? false, minHeightIn: o.minHeightIn ?? null, showtimes: o.showtimes
  };
}

export function meal(id, x, y, o = {}){
  return { id, name: o.name || id, kind: "meal", x, y, mealDelay: o.mealDelay ?? 10 };
}

export function makePark(stops, { start = [0, 0], speed = 75 } = {}){
  const points = [start, ...stops.map(s => [s.x, s.y])];
  const meters = points.map(a => points.map(b => Math.hypot(a[0] - b[0], a[1] - b[1])));
  stops.forEach((s, i) => { s.idx = i + 1; });
  return { stops, matrix: { meters, minutes: meters.map(r => r.map(m => m / speed)) }, startIdx: 0 };
}

export function baseInput(park, over = {}){
  return {
    ...park,
    now: 9 * 60, planStart: 9 * 60, budgetEnd: 15 * 60,
    mustRideIds: [], lockedNextId: null, previousPlan: null, previousWaits: {},
    seed: 42, maxIterations: 20000, timeLimitMs: 10000, beamWidth: 200,
    ...over,
    prefs: { thrill: "balanced", walking: "balanced", groupSize: 4, food: "skip-food", ...(over.prefs || {}) }
  };
}

export function ringPark(n = 16, radius = 400){
  const stops = [];
  for(let i = 0; i < n; i++){
    const a = (i / n) * Math.PI * 2;
    stops.push(ride(`r${i}`, Math.cos(a) * radius, Math.sin(a) * radius + radius, {
      thrill: 1 + (i % 5), popularity: 1 + (i % 3), wait: 5 + (i * 7) % 40
    }));
  }
  return makePark(stops);
}

export function randomPark(n = 30, seed = 7){
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const stops = [];
  for(let i = 0; i < n; i++){
    stops.push(ride(`p${i}`, rnd() * 900 - 450, rnd() * 900, {
      thrill: 1 + Math.floor(rnd() * 5), popularity: 1 + Math.floor(rnd() * 3),
      wait: Math.floor(rnd() * 60), duration: 2 + Math.floor(rnd() * 8)
    }));
  }
  for(let i = 0; i < 4; i++) stops.push(meal(`m${i}`, rnd() * 900 - 450, rnd() * 900, { mealDelay: 5 + i * 5 }));
  return makePark(stops);
}
```

- [ ] **Step 2: Write the failing tests** (includes Review Focus 4)

`tests/planner-score.test.js`:

```js
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
```

Add `"planner-score"` to `FILES`.

- [ ] **Step 3: Run to verify it fails**

Run: `python3 tests/run.py planner-score`
Expected: `NO RESULT` (module missing).

- [ ] **Step 4: Write the scoring half of `js/planner.js`**

```js
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python3 tests/run.py planner-score`
Expected: `PASS 16 passed, 0 failed, 0 skipped`

- [ ] **Step 6: Commit**

```bash
git add js/planner.js tests/fixtures/parks.js tests/planner-score.test.js tests/run.html
git commit -m "Add planner scoring model and plan evaluation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Beam search and the nearest-ride baseline

**Files:**
- Modify: `js/planner.js` (append)
- Test: `tests/planner-search.test.js`
- Modify: `tests/run.html` (add `"planner-search"`)

**Interfaces:**
- Consumes: `buildContext`, `stopTimes`, `evaluate`, `isBetter`, `MUST_RIDE_WEIGHT`, `LOAD_UNLOAD_MIN` (Task 6).
- Produces: `beamSearch(ctx, width = 200) → Evaluation` (best valid plan found; if none is valid, the evaluation of the lock-only or empty plan) and `nearestRidePlan(input) → Evaluation` (greedy "closest ride next", no meal, no must-rides).

- [ ] **Step 1: Write the failing tests**

`tests/planner-search.test.js`:

```js
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
```

Add `"planner-search"` to `FILES`.

- [ ] **Step 2: Run to verify it fails**

Run: `python3 tests/run.py planner-search`
Expected: `NO RESULT`, because `beamSearch` is not exported (the import fails).

- [ ] **Step 3: Append beam search and the baseline to `js/planner.js`**

```js

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 tests/run.py planner-search`
Expected: `PASS 7 passed, 0 failed, 0 skipped`

- [ ] **Step 5: Commit**

```bash
git add js/planner.js tests/planner-search.test.js tests/run.html
git commit -m "Add beam search and nearest-ride baseline to planner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Simulated annealing, stability rule and `planDay`

**Files:**
- Modify: `js/planner.js` (append)
- Test: `tests/planner-day.test.js`
- Modify: `tests/run.html` (add `"planner-day"`)

**Interfaces:**
- Consumes: everything from Tasks 6–7.
- Produces:
  - `mulberry32(seed) → () => number in [0,1)`, `hashSeed(text) → uint32`
  - `anneal(startIds, ctx, { seed, maxIterations = 40000, timeLimitMs = 300, clock }) → Evaluation`
  - `retime(prevIds, ctx) → Evaluation`, `shouldAdopt(oldEval, newEval) → boolean`
  - `planDay(input) → { plan: Evaluation, warnings: {type, id}[], reason: string|null, adopted: boolean, mealStatus, lockDropped: string|null }`
  - `input` = `{ stops, matrix, startIdx, prefs:{thrill,walking,groupSize,food}, now, planStart, budgetEnd, mustRideIds, lockedNextId, previousPlan:{ids, names}|null, previousWaits:{id:wait}, prefsChanged, force, seed, maxIterations, timeLimitMs, beamWidth, clock? }`
  - Warning types: `"must-ride-no-fit"`, `"must-ride-unavailable"`.

- [ ] **Step 1: Write the failing tests** (includes Review Focus 1, 4 and 5)

`tests/planner-day.test.js`:

```js
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
```

Add `"planner-day"` to `FILES`.

- [ ] **Step 2: Run to verify it fails**

Run: `python3 tests/run.py planner-day`
Expected: `NO RESULT` (the missing exports fail the import).

- [ ] **Step 3: Append annealing, stability and `planDay` to `js/planner.js`**

```js

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
  const closed = prev.ids.find(id => !ctx.byId.has(id));
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
  if(ctx.lockedId && !evaluate([ctx.lockedId], { ...ctx, mealWin: null }).valid){
    ctx = { ...ctx, lockDropped: ctx.lockedId, lockedId: null };
  }

  const search = c => {
    const seeded = beamSearch(c, input.beamWidth ?? 200);
    return anneal(seeded.ids, c, {
      seed: input.seed ?? 1,
      maxIterations: input.maxIterations ?? 40000,
      timeLimitMs: input.timeLimitMs ?? 300,
      clock: input.clock
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
    if(!shouldAdopt(old, best)){
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 tests/run.py planner-day`
Expected: `PASS 15 passed, 0 failed, 1 skipped`. Then open `http://127.0.0.1:8765/tests/run.html?only=planner-day` in Chrome.
Expected: 16 passed, including "a 60-stop park plans within 350 ms".

If the timing test fails, lower beam cost first: in `beamSearch`, expand each state only with its 25 best candidate stops, ranked by `points − penalty × walk`. Don't lower `maxIterations`. Re-run.

- [ ] **Step 5: Run the full suite**

Run: `python3 tests/run.py`
Expected: `PASS …, 0 failed`.

- [ ] **Step 6: Commit**

```bash
git add js/planner.js tests/planner-day.test.js tests/run.html
git commit -m "Add simulated annealing, stability rule and planDay

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Plan requests and the planner worker

**Files:**
- Create: `js/plan-request.js`, `js/planner-worker.js`
- Test: `tests/plan-request.test.js`
- Modify: `tests/run.html` (add `"plan-request"`)

**Interfaces:**
- Consumes: `nearestNode`, `walkMatrix`, `straightMatrix`, `pathBetween`, `loadWalkGraph` (Task 2); `planDay`, `nearestRidePlan`, `walkSpeed` (Tasks 6–8).
- Produces: `runPlanRequest(graph | null, request) → { result, baseline: { rides, waitWalkMin }, legs: [lat,lng][][], estimated: boolean }`, where `legs[i]` is the walk into `result.plan.ids[i]`.
- `request = { start: { lat, lng, node?, source, gpsOutside? }, stops: [{ id, name, kind, lat, lng, node?, wait, duration, thrill, popularity, kidFriendly, minHeightIn, showtimes?, mealDelay? }], plannerInput: { prefs, now, planStart, budgetEnd, mustRideIds, lockedNextId, previousPlan, previousWaits, prefsChanged, force, seed, maxIterations, timeLimitMs, beamWidth } }`
- Worker protocol: post `{ type:"graph", json }` once, then `{ type:"plan", id, request }`. The worker replies `{ id, ok:true, ...runPlanRequest(...) }` or `{ id, ok:false, error }`.

- [ ] **Step 1: Write the failing tests**

`tests/plan-request.test.js`:

```js
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
```

Add `"plan-request"` to `FILES`.

- [ ] **Step 2: Run to verify it fails**

Run: `python3 tests/run.py plan-request`
Expected: `NO RESULT`.

- [ ] **Step 3: Write `js/plan-request.js` and `js/planner-worker.js`**

`js/plan-request.js`:

```js
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
```

`js/planner-worker.js`:

```js
// Runs the day planner off the main thread so the page never freezes.
import { loadWalkGraph } from "./walkgraph.js";
import { runPlanRequest } from "./plan-request.js";

let graph = null;

self.onmessage = event => {
  const msg = event.data;
  if(msg.type === "graph"){
    graph = msg.json ? loadWalkGraph(msg.json) : null;
    return;
  }
  if(msg.type === "plan"){
    try{
      self.postMessage({ id: msg.id, ok: true, ...runPlanRequest(graph, msg.request) });
    }catch(err){
      self.postMessage({ id: msg.id, ok: false, error: String(err?.stack || err) });
    }
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 tests/run.py plan-request`
Expected: `PASS 4 passed, 0 failed, 0 skipped`

- [ ] **Step 5: Commit**

```bash
git add js/plan-request.js js/planner-worker.js tests/plan-request.test.js tests/run.html
git commit -m "Add plan request runner and planner web worker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Wire the planner into the app

**Files:**
- Modify: `js/app.js`

**Interfaces:**
- Consumes: `runPlanRequest` (Task 9), `loadWalkGraph` (Task 2), `hashSeed` (Task 8), `parkClock`, `isoToParkMinutes`, `closingMinutes`, `showtimeMinutes`, `minutesToClock`, `formatDuration` (Task 4), `rideDetailsFor` (Task 5), and the worker protocol (Task 9).
- Produces (used by Tasks 11–12): the `planState` object `{ ids, timeline, legs, baseline, estimated, warnings, reason, lockDropped, mealStatus, startSource, gpsOutside, summary:{ rides, end, walkMeters, walkMin, waitMin }, moved:string[] }`; functions `requestPlan({ force, prefsChanged })`, `parkNow()`, `budgetEndMin()`, `currentStops()` (plan stops in order with `arrive`, `start`, `walkMin`, `waitMin`, `score` added); state `gps`, `walkData`, `lockedNextId`, `mustRideIds`, `selectedFoodId`.

- [ ] **Step 1: Add imports, constants and state at the top of `js/app.js`**

Insert at the very top of `js/app.js`:

```js
import { loadWalkGraph } from "./walkgraph.js";
import { runPlanRequest } from "./plan-request.js";
import { hashSeed } from "./planner.js";
import { parkClock, isoToParkMinutes, closingMinutes, showtimeMinutes, minutesToClock, formatDuration } from "./livedata.js";
import { rideDetailsFor } from "./ridedata.js";

```

Replace these existing lines:

```js
let frozenRoute = [];
```
```js
let mustRideNames = [];
let selectedFoodName = null;
```

with:

```js
let mustRideIds = [];
let selectedFoodId = null;
let parkTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let parkDate = null;          // "YYYY-MM-DD" in park time
let parkCloseMin = null;      // park-local minutes; may exceed 1440 after midnight
let parkMetaReady = null;     // Promise from loadParkMeta()
let planStartMin = null;
let walkData = null;          // data/walkways JSON, or null when unavailable
let rideDetails = {};
let gps = null;               // { lat, lng, accuracy }
let lockedNextId = null;
let planRequestId = 0;
let planState = emptyPlanState();
```

After the `PARK_CENTERS` constant, add:

```js
const PARK_SLUGS = {
  "Magic Kingdom":"magic-kingdom", "EPCOT":"epcot", "Hollywood Studios":"hollywood-studios",
  "Animal Kingdom":"animal-kingdom", "Disneyland":"disneyland", "Cedar Point":"cedar-point", "Kings Island":"kings-island"
};
const MEAL_CANDIDATES = 12;

function emptyPlanState(){
  return { ids:[], timeline:[], legs:[], baseline:null, estimated:false, warnings:[], reason:null,
           lockDropped:null, mealStatus:null, startSource:null, gpsOutside:false, summary:null, moved:[] };
}

const planner = createPlannerClient();
```

- [ ] **Step 2: Add park time, park data and the planner client**

Add this block after `renderSettings()`:

```js
/* ---------- Park time and data ---------- */
function parkNow(){
  return isoToParkMinutes(new Date().toISOString(), parkTimeZone, parkDate);
}

function budgetEndMin(){
  return Math.min(planStartMin + userPrefs.parkHours * 60, parkCloseMin ?? Infinity);
}

async function loadParkMeta(park){
  try{
    const json = await fetch(`https://api.themeparks.wiki/v1/entity/${PARK_ENTITY_IDS[park]}/schedule`).then(r => r.json());
    if(json.timezone) parkTimeZone = json.timezone;
    parkDate = parkClock(new Date(), parkTimeZone).date;
    parkCloseMin = closingMinutes(json, parkTimeZone, parkDate);
  }catch(err){
    console.warn("[RideFlow] park schedule unavailable", err);
    parkDate = parkClock(new Date(), parkTimeZone).date;
    parkCloseMin = null;
  }
}

async function loadParkData(){
  const slug = PARK_SLUGS[selectedPark];
  const load = path => fetch(path).then(r => r.ok ? r.json() : null).catch(() => null);
  const [walkways, rides] = await Promise.all([load(`data/walkways/${slug}.json`), load(`data/rides/${slug}.json`)]);
  walkData = walkways;
  rideDetails = rides || {};
  planner.setGraph(walkData);
}

function createPlannerClient(){
  let worker = null;
  let graphJson = null;
  let fallbackGraph;
  const pending = new Map();

  try{
    worker = new Worker(new URL("./planner-worker.js", import.meta.url), { type:"module" });
    worker.onmessage = e => {
      const resolve = pending.get(e.data.id);
      if(resolve){ pending.delete(e.data.id); resolve(e.data); }
    };
    worker.onerror = err => {
      console.error("[RideFlow] planner worker failed; planning on the main thread", err);
      worker = null;
      pending.forEach(resolve => resolve(null));
      pending.clear();
    };
  }catch(err){
    worker = null;
  }

  return {
    setGraph(json){
      graphJson = json;
      fallbackGraph = undefined;
      worker?.postMessage({ type:"graph", json });
    },
    run(request, id){
      if(worker) return new Promise(resolve => { pending.set(id, resolve); worker.postMessage({ type:"plan", id, request }); });
      if(fallbackGraph === undefined) fallbackGraph = graphJson ? loadWalkGraph(graphJson) : null;
      const quick = { ...request, plannerInput:{ ...request.plannerInput, timeLimitMs:150, beamWidth:60 } };
      try{ return Promise.resolve({ id, ok:true, ...runPlanRequest(fallbackGraph, quick) }); }
      catch(err){ return Promise.resolve({ id, ok:false, error:String(err) }); }
    }
  };
}
```

- [ ] **Step 3: Load park meta when a park is picked, and park data on launch**

In the onboarding option click handler, replace:

```js
    if(group.dataset.field === "park") selectedPark = option.dataset.value;
```

with:

```js
    if(group.dataset.field === "park"){
      selectedPark = option.dataset.value;
      parkMetaReady = loadParkMeta(selectedPark);
    }
```

Replace the whole `launchApp` function with:

```js
async function launchApp(){
  userPrefs = {
    groupSize: Number(document.getElementById("groupSizeVal").textContent),
    parkHours: Number(document.getElementById("parkTimeVal").textContent),
    thrill: document.getElementById("thrillPref").value,
    walking: document.getElementById("walkingPref").value
  };
  userFoodPlan = document.getElementById("foodPref").value;

  document.getElementById("onboarding").classList.add("hidden");
  document.getElementById("parkName").textContent = selectedPark;

  await (parkMetaReady ??= loadParkMeta(selectedPark));
  planStartMin = parkNow();
  renderSettings();
  await loadParkData();
  requestLocation();

  fetchLiveWaitTimes();
  setInterval(fetchLiveWaitTimes, 300000);
}
```

Add a placeholder `requestLocation` now so the app runs. Task 11 replaces it:

```js
function requestLocation(){}
```

- [ ] **Step 4: Include shows and park time in live data; key waits by ID**

In `fetchLiveWaitTimes`, directly after the `Promise.all` that loads `data` and `childrenData`, add:

```js
    if(data.timezone) parkTimeZone = data.timezone;
    const nowMin = parkNow();
```

Replace the `const attractions = data.liveData …` block with:

```js
    const attractions = data.liveData
      .filter(r => r.entityType === "ATTRACTION" || (r.entityType === "SHOW" && r.showtimes?.length))
      .map(r => {
        const loc = locationMap[r.id] || {};
        const show = r.entityType === "SHOW";
        return {
          id:r.id,
          name:cleanRideName(r.name),
          type: show ? "show" : "ride",
          is_open:r.status === "OPERATING",
          wait_time:Number(r.queue?.STANDBY?.waitTime ?? 0),
          showtimes: show ? showtimeMinutes(r.showtimes, parkTimeZone, parkDate).filter(t => t > nowMin) : undefined,
          lat:loc.lat,
          lng:loc.lng
        };
      });
```

Replace:

```js
    latestRides = [...attractions, ...restaurants];
    frozenRoute = buildOptimizedRoute(latestRides);

    document.getElementById("nextRetry").classList.add("hidden");
    renderRoute();

    previousWaits = Object.fromEntries(latestRides.map(r => [r.name, r.wait_time]));
```

with:

```js
    latestRides = [...attractions, ...restaurants];

    document.getElementById("nextRetry").classList.add("hidden");
    renderRoute();

    const planned = requestPlan();   // reads the old previousWaits synchronously
    previousWaits = Object.fromEntries(latestRides.map(r => [rideKey(r), r.wait_time]));
    await planned;
```

In `detectLineSpike`, replace `const oldWait = previousWaits[r.name];` with `const oldWait = previousWaits[rideKey(r)];`, and replace the `spikeRisk` line with:

```js
        spikeRisk: jump * 3 + currentWait * 0.35
```

In `updateAI`, replace:

```js
    const oldWait = previousWaits[r.name];
```
with
```js
    const oldWait = previousWaits[rideKey(r)];
```

and replace `previousWaits[droppedRide.name]` with `previousWaits[rideKey(droppedRide)]`.

- [ ] **Step 5: Replace the old route builder with plan requests**

Delete these functions from `js/app.js` entirely: `calculateRideScore`, `distanceBetween`, `pickFoodStop`, `buildOptimizedRoute`, `popularityScore`.

Replace `currentStops` with:

```js
function currentStops(){
  const byId = new Map(latestRides.map(r => [rideKey(r), r]));
  return planState.timeline
    .filter(t => !completedRideKeys.includes(t.id) && byId.has(t.id))
    .map(t => {
      const r = byId.get(t.id);
      return {
        ...r, arrive:t.arrive, start:t.start, walkMin:t.walkMin, waitMin:t.waitMin, score:t.points,
        food_time: r.type === "food" ? `Meal stop around ${minutesToClock(t.start)}` : undefined
      };
    });
}
```

Add the plan request functions after `currentStops`:

```js
function mealCandidates(){
  const open = latestRides.filter(r =>
    r.type === "food" && r.lat && r.lng &&
    !completedRideKeys.includes(rideKey(r)) &&
    !(userPrefs.thrill === "easy" && r.servesAlcohol)
  );
  if(selectedFoodId) return open.filter(r => rideKey(r) === selectedFoodId);
  return open.sort((a, b) => estimateFoodDelay(a) - estimateFoodDelay(b)).slice(0, MEAL_CANDIDATES);
}

function insideBbox(p){
  const b = walkData?.bbox;
  return !!b && p.lat >= b[0] && p.lat <= b[2] && p.lng >= b[1] && p.lng <= b[3];
}

function startPoint(){
  const gpsUsable = gps && gps.accuracy <= 50;
  if(gpsUsable && insideBbox(gps)) return { lat:gps.lat, lng:gps.lng, source:"gps" };

  const last = [...completedRideKeys].reverse()
    .map(key => latestRides.find(r => rideKey(r) === key))
    .find(r => r?.lat && r?.lng);
  if(last) return { lat:last.lat, lng:last.lng, node:walkData?.anchors?.[last.id]?.node, source:"last", gpsOutside:!!gpsUsable };

  const entrance = walkData?.anchors?.entrance;
  if(entrance){
    const [lat, lng] = walkData.nodes[entrance.node];
    return { lat, lng, node:entrance.node, source:"entrance", gpsOutside:!!gpsUsable };
  }
  const [lat, lng] = PARK_CENTERS[selectedPark];
  return { lat, lng, source:"entrance", gpsOutside:!!gpsUsable };
}

function buildPlanRequest({ force, prefsChanged }){
  const mealDone = latestRides.some(r => r.type === "food" && completedRideKeys.includes(rideKey(r)));
  const rides = latestRides.filter(r => r.type !== "food" && r.is_open && r.lat && r.lng && !completedRideKeys.includes(rideKey(r)));
  const node = r => walkData?.anchors?.[r.id]?.node;

  const stops = [
    ...rides.map(r => {
      const d = rideDetailsFor(rideDetails, r);
      return {
        id:rideKey(r), name:r.name, kind: r.type === "show" && r.showtimes?.length ? "show" : "ride",
        lat:r.lat, lng:r.lng, node:node(r), wait:r.wait_time, duration:d.durationMin,
        thrill:d.thrill, popularity:d.popularity, kidFriendly:d.kidFriendly, minHeightIn:d.minHeightIn,
        showtimes:r.showtimes
      };
    }),
    ...(mealDone ? [] : mealCandidates()).map(f => ({
      id:rideKey(f), name:f.name, kind:"meal", lat:f.lat, lng:f.lng, node:node(f), mealDelay:estimateFoodDelay(f)
    }))
  ];

  const remainingPlan = planState.ids.filter(id => !completedRideKeys.includes(id));
  const names = Object.fromEntries(latestRides.map(r => [rideKey(r), r.name]));

  return {
    start: startPoint(),
    stops,
    plannerInput: {
      prefs: { ...userPrefs, food: mealDone ? "skip-food" : userFoodPlan },
      now: parkNow(),
      planStart: planStartMin,
      budgetEnd: budgetEndMin(),
      mustRideIds: mustRideIds.filter(id => !completedRideKeys.includes(id)),
      lockedNextId,
      previousPlan: remainingPlan.length ? { ids:remainingPlan, names } : null,
      previousWaits,
      prefsChanged,
      force,
      seed: hashSeed(`${PARK_SLUGS[selectedPark]}|${parkDate}|${planStartMin}`),
      maxIterations: 40000,
      timeLimitMs: 300,
      beamWidth: 200
    }
  };
}

async function requestPlan({ force = false, prefsChanged = false } = {}){
  if(!latestRides.length || planStartMin === null) return;
  const request = buildPlanRequest({ force, prefsChanged });
  const id = ++planRequestId;
  let reply = await planner.run(request, id);
  if(!reply) reply = await planner.run(request, id);   // worker died; client now plans on the main thread
  if(id !== planRequestId) return;                     // a newer request superseded this one
  if(!reply?.ok){
    console.error("[RideFlow] planner failed:", reply?.error);
    return;
  }
  applyPlan(reply, request);
  renderRoute();
}

function applyPlan(reply, request){
  const { result, legs, baseline, estimated } = reply;
  const prior = planState.ids.filter(id => !completedRideKeys.includes(id));
  planState = {
    ids: result.plan.ids,
    timeline: result.plan.timeline,
    legs, baseline, estimated,
    warnings: result.warnings,
    reason: result.reason,
    lockDropped: result.lockDropped,
    mealStatus: result.mealStatus,
    startSource: request.start.source,
    gpsOutside: !!request.start.gpsOutside,
    summary: { rides:result.plan.rides, end:result.plan.end, walkMeters:result.plan.walkMeters, walkMin:result.plan.walkMin, waitMin:result.plan.waitMin },
    moved: prior.length ? result.plan.ids.filter((id, i) => prior.indexOf(id) !== i) : []
  };
  lockedNextId = result.plan.ids[0] ?? null;
}
```

- [ ] **Step 6: Update actions that used `frozenRoute` or names**

Replace `reevaluateRoute` with:

```js
function reevaluateRoute(){
  requestPlan({ force:true });
  const btn = document.getElementById("reevaluateBtn");
  btn.textContent = "Route updated";
  setTimeout(() => btn.textContent = "Reevaluate route", 1000);
}
```

In `completeRide`, directly after the `completedRideKeys.push(key)` block, add:

```js
  // Checking off the next stop locks the one after it (spec §6.5).
  if(planState.ids[0] === key) lockedNextId = planState.ids[1] ?? null;
```

and replace the `setTimeout` body:

```js
    goNow.classList.remove("done");
    frozenRoute = buildOptimizedRoute(latestRides);
    renderRoute();
```

with:

```js
    goNow.classList.remove("done");
    renderRoute();
    requestPlan();
```

Replace `togglePriorityItem` with:

```js
function togglePriorityItem(key){
  const item = latestRides.find(r => rideKey(r) === key);
  if(item?.type === "food") selectedFoodId = selectedFoodId === key ? null : key;
  else if(mustRideIds.includes(key)) mustRideIds = mustRideIds.filter(id => id !== key);
  else mustRideIds.push(key);
  renderMustRideList(latestRides);
  requestPlan();
}
```

In the document click delegation, replace:

```js
  if(btn.dataset.action === "star") togglePriorityItem(btn.dataset.name);
```
with
```js
  if(btn.dataset.action === "star") togglePriorityItem(btn.dataset.key);
```

In `updateFoodTiming`, replace `const currentFood = frozenRoute.find(r => r.type === "food");` with `const currentFood = currentStops().find(r => r.type === "food");` (Task 12 rewrites this function; this keeps the app running until then).

In `longestWait`, replace `.filter(r => !mustRideNames.includes(r.name))` with `.filter(r => !mustRideIds.includes(rideKey(r)))`.

Confirm nothing else references the deleted names:

```bash
grep -nE "frozenRoute|mustRideNames|selectedFoodName|calculateRideScore|distanceBetween|pickFoodStop|buildOptimizedRoute|popularityScore" js/app.js
```
Expected: no output.

Replace `rideCategory` with:

```js
function rideCategory(ride){
  if(ride.type === "food") return "Food";
  const d = rideDetailsFor(rideDetails, ride);
  if(ride.type === "show" || d.type === "show") return "Shows";
  if(d.thrill >= 4) return "Thrill";
  if(d.kidFriendly && d.thrill <= 2) return "Kids";
  return "Other";
}
```

In `renderMustRideList`, replace the sort-and-group chain:

```js
    .sort((a,b) => popularityScore(b.name) - popularityScore(a.name))
    .forEach(r => groups[rideCategory(r.name)].push(r));
```

with:

```js
    .sort((a, b) => (rideDetailsFor(rideDetails, b).popularity || 0) - (rideDetailsFor(rideDetails, a).popularity || 0) || a.name.localeCompare(b.name))
    .forEach(r => groups[rideCategory(r)].push(r));
```

Then, in the same function, replace:

```js
          const on = mustRideNames.includes(r.name) || selectedFoodName === r.name;
```
with
```js
          const key = rideKey(r);
          const on = mustRideIds.includes(key) || selectedFoodId === key;
```

and in the star button markup replace `data-name="${esc(r.name)}"` with `data-key="${esc(key)}"`.

Restaurants use `rideDetailsFor` only through `rideCategory`, and they return early there, so no warning is logged for them.

- [ ] **Step 7: Verify in Chrome**

Reload `http://127.0.0.1:8765/index.html`, choose Magic Kingdom and build the route.
Expected:
- the route list and map populate
- the DevTools console has no errors, only possible `[RideFlow] missing ride details` warnings
- in the console, `(await import("./js/planner.js")) && document.querySelectorAll("#rideList .row").length` returns a number > 0
- checking off the first ride makes the second ride the Next up stop
- starring a ride adds it to the route within a second

- [ ] **Step 8: Run the full test suite and commit**

Run: `python3 tests/run.py`
Expected: `PASS …, 0 failed`

```bash
git add js/app.js
git commit -m "Plan routes with the search planner on real walkways

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Map legs along walkways, moved-stop flash, GPS

**Files:**
- Modify: `js/app.js`, `index.html` (map markup + CSS)

**Interfaces:**
- Consumes: `planState.legs`, `planState.ids`, `planState.moved`, `planState.estimated`, `planState.gpsOutside`, and `gps` (Task 10).
- Produces: `requestLocation()` (replaces the Task 10 placeholder), `drawYouAreHere()`, `centerOnMe()` (exported on `window`).

- [ ] **Step 1: Add the locate button and CSS**

In `index.html`, inside `.map-wrap` after `<div id="mapStatus" …></div>`, add:

```html
            <button id="locateBtn" class="map-locate hidden" onclick="centerOnMe()" aria-label="Center map on your location">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
            </button>
```

In the `<style>` block, after the `.dot.closed` rule, add:

```css
.pin.moved{animation:pin-flash 1.2s ease-out 1}
@keyframes pin-flash{
  0%{transform:scale(1.5);box-shadow:0 0 0 8px rgba(174,255,0,.5),0 0 30px rgba(174,255,0,.9)}
  100%{transform:scale(1)}
}
.you-dot{
  width:18px;height:18px;border-radius:50%;background:var(--cyan);border:3px solid #fff;
  box-shadow:0 0 0 0 rgba(0,198,255,.6),0 0 16px rgba(0,198,255,.8);animation:you-pulse 2s ease-out infinite;
}
@keyframes you-pulse{
  0%{box-shadow:0 0 0 0 rgba(0,198,255,.6),0 0 16px rgba(0,198,255,.8)}
  100%{box-shadow:0 0 0 14px rgba(0,198,255,0),0 0 16px rgba(0,198,255,.8)}
}
.map-locate{
  position:absolute;top:88px;right:10px;z-index:500;width:34px;height:34px;border-radius:8px;
  display:grid;place-items:center;background:#fff;color:#0a0c11;box-shadow:0 1px 5px rgba(0,0,0,.4);
}
.map-locate svg{width:20px;height:20px}
```

- [ ] **Step 2: Draw legs along walkways, with the next leg bright**

Replace `drawOptimizedRoute` in `js/app.js` with:

```js
function drawOptimizedRoute(){
  if(!parkMap) return;

  routeLayers.forEach(layer => parkMap.removeLayer(layer));
  routeLayers = [];

  const legs = planState.ids
    .map((id, i) => ({ id, coords: planState.legs[i] }))
    .filter(leg => !completedRideKeys.includes(leg.id) && leg.coords?.length >= 2);

  parkMap.invalidateSize();

  if(!legs.length){
    fitToRides();
    return;
  }

  // Next leg: neon tube (haze, glow, core, white-hot centre). Later legs: dim.
  const style = { color:"#aeff00", lineCap:"round", lineJoin:"round", interactive:false };
  const nextLeg = [
    { weight:22, opacity:.08 }, { weight:12, opacity:.2 }, { weight:4, opacity:1 }, { weight:1.5, opacity:.85, color:"#f4ffd6" }
  ];
  const laterLeg = [{ weight:10, opacity:.07 }, { weight:3, opacity:.45 }];

  legs.slice().reverse().forEach((leg, r) => {
    const isNext = r === legs.length - 1;
    (isNext ? nextLeg : laterLeg).forEach(o => routeLayers.push(L.polyline(leg.coords, { ...style, ...o }).addTo(parkMap)));
  });

  parkMap.fitBounds(L.latLngBounds(legs.flatMap(leg => leg.coords)), { padding:[56,56] });
}
```

Legs are drawn in reverse so the bright next leg ends up on top.

In `pinIcon`, add the moved class. Replace:

```js
  const cls = ["pin", ride.type === "food" ? "food" : "", index === 0 ? "first" : ""].join(" ").trim();
```
with
```js
  const moved = planState.moved.includes(rideKey(ride));
  const cls = ["pin", ride.type === "food" ? "food" : "", index === 0 ? "first" : "", moved ? "moved" : ""].join(" ").trim();
```

At the end of `refreshMapMarkers`, add `drawYouAreHere();`.

- [ ] **Step 3: GPS, the you-are-here dot and map notes**

Replace the placeholder `function requestLocation(){}` with:

```js
let youMarker = null;
let youAccuracy = null;

function requestLocation(){
  if(!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    pos => {
      gps = { lat:pos.coords.latitude, lng:pos.coords.longitude, accuracy:pos.coords.accuracy };
      drawYouAreHere();
    },
    () => {
      gps = null;
      drawYouAreHere();
    },
    { enableHighAccuracy:true, maximumAge:30000, timeout:20000 }
  );
}

function drawYouAreHere(){
  if(!parkMap) return;
  youMarker?.remove();
  youAccuracy?.remove();
  youMarker = youAccuracy = null;

  const show = gps && insideBbox(gps);
  document.getElementById("locateBtn").classList.toggle("hidden", !show);
  if(!show) return;

  if(gps.accuracy > 20){
    youAccuracy = L.circle([gps.lat, gps.lng], {
      radius:gps.accuracy, color:"#00c6ff", weight:1, opacity:.5, fillOpacity:.08, interactive:false
    }).addTo(parkMap);
  }
  youMarker = L.marker([gps.lat, gps.lng], {
    icon: L.divIcon({ className:"", html:'<div class="you-dot"></div>', iconSize:[18,18], iconAnchor:[9,9] }),
    zIndexOffset:2000,
    title:"You are here"
  }).addTo(parkMap);
}

function centerOnMe(){
  if(gps && parkMap) parkMap.setView([gps.lat, gps.lng], 18);
}
```

Add `centerOnMe` to the `Object.assign(window, …)` line at the end of the file.

In `updateUI`, replace:

```js
  setMapStatus(anyOpen ? "" : `${selectedPark} is closed right now. The map shows where every ride is.`);
```

with:

```js
  setMapStatus(
    !anyOpen ? `${selectedPark} is closed right now. The map shows where every ride is.`
    : planState.estimated ? "Walking times are estimates."
    : planState.gpsOutside ? "Planning from the park entrance."
    : ""
  );
```

- [ ] **Step 4: Verify in Chrome**

Reload the app and build a Magic Kingdom route.
Expected:
- the route follows walkways (no straight lines across buildings or water)
- the leg to stop 1 is bright and later legs are dim

Then check GPS. In DevTools → More tools → Sensors, set Location to a custom `28.4180, -81.5810` and reload.
Expected: a cyan pulsing dot near the castle hub and the locate button visible; clicking it centres the map there.

Set Location to `40.7128, -74.0060` (New York) and reload.
Expected: no dot, and the note "Planning from the park entrance." appears.

Set Location to "Location unavailable" and reload.
Expected: no dot and no note.

Finally, rename `data/walkways/magic-kingdom.json` temporarily to `_mk.json` and reload.
Expected: the note "Walking times are estimates." and straight legs. Rename it back.

- [ ] **Step 5: Run the tests and commit**

Run: `python3 tests/run.py`
Expected: `PASS …, 0 failed`

```bash
git add index.html js/app.js
git commit -m "Draw routes along walkways and add GPS location

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: On-screen plan details, War Room, onboarding end time, editable Settings

**Files:**
- Modify: `index.html`, `js/app.js`

**Interfaces:**
- Consumes: `planState`, `parkNow()`, `budgetEndMin()`, `requestPlan()`, `minutesToClock`, `formatDuration`, `currentStops()` (Task 10).

- [ ] **Step 1: Add markup**

In `index.html`, in `.next-card` directly after `<p id="navSub">…</p>`, add:

```html
                  <p id="nextMeta" class="next-meta"></p>
                  <p id="planReason" class="plan-reason hidden"></p>
```

After `<p id="routeConfidence">…</p>`, add:

```html
              <div id="planWarnings" class="plan-warnings hidden"></div>
```

After `<div class="list" id="rideList"></div>`, add:

```html
              <p id="routeSummary" class="route-summary"></p>
```

In the onboarding hours step, after `<div class="range-scale"><span>2 hours</span><span>12 hours</span></div>`, add:

```html
      <p class="readout-note" id="endTimeNote"></p>
```

In `.ob-actions`, after the `obNext` button, add:

```html
      <p class="ob-note hidden" id="locationNote">RideFlow uses your location to plan walks from where you are.</p>
```

Replace the Settings `.card.settings-card` contents with:

```html
        <div class="card settings-card">
          <dl class="settings-list">
            <div><dt>Park</dt><dd id="settingsPark">--</dd></div>
            <div><dt>Group size</dt><dd id="settingsGroup">--</dd></div>
          </dl>
          <div class="setting">
            <div class="setting-head"><span>Time in park</span><strong id="settingsHoursOut">--</strong></div>
            <input type="range" id="settingsHours" min="2" max="12" value="6" aria-label="Hours in the park">
          </div>
          <div class="setting">
            <div class="setting-head"><span>Thrill level</span></div>
            <div class="segmented" data-setting="thrill">
              <button type="button" data-value="easy">Family friendly</button>
              <button type="button" data-value="balanced">Balanced</button>
              <button type="button" data-value="extreme">Big thrills</button>
            </div>
          </div>
          <div class="setting">
            <div class="setting-head"><span>Route style</span></div>
            <div class="segmented" data-setting="walking">
              <button type="button" data-value="low">Minimize walking</button>
              <button type="button" data-value="balanced">Balanced</button>
              <button type="button" data-value="max">Max rides</button>
            </div>
          </div>
          <div class="setting">
            <div class="setting-head"><span>Food plan</span></div>
            <div class="segmented" data-setting="food">
              <button type="button" data-value="eat-early">Eat early</button>
              <button type="button" data-value="eat-late">Eat later</button>
              <button type="button" data-value="skip-food">No meal</button>
            </div>
          </div>
          <button class="btn btn-quiet" onclick="location.reload()">Start over with a new park</button>
        </div>
```

Add CSS after the `.settings-list dd` rule:

```css
.next-meta{margin-top:8px;font-size:13px;font-weight:600;color:#b8c7df}
.plan-reason{margin-top:10px;padding:8px 12px;border-radius:var(--r-sm);font-size:13px;background:rgba(0,198,255,.08);border:1px solid rgba(0,198,255,.25);color:#cfeeff}
.plan-warnings{margin-top:12px;display:flex;flex-direction:column;gap:8px}
.plan-warning{padding:10px 12px;border-radius:var(--r-sm);font-size:13px;background:rgba(255,184,0,.08);border:1px solid rgba(255,184,0,.3)}
.plan-warning button{margin-left:6px;color:var(--amber);font-weight:700;text-decoration:underline}
.eta{flex:none;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.route-summary{margin-top:10px;font-size:13px;color:var(--muted)}
.readout-note{margin-top:14px;font-size:14px;color:#b8c7df}
.ob-note{margin-top:12px;font-size:13px;color:var(--muted);text-align:center}
.setting{margin-top:20px}
.setting-head{display:flex;justify-content:space-between;margin-bottom:10px;font-size:14px;color:var(--muted)}
.setting-head strong{color:var(--text)}
.segmented{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.segmented button{
  padding:10px 8px;border-radius:var(--r-sm);font-size:13px;font-weight:600;
  background:linear-gradient(180deg,#181c24,#111318);border:1px solid rgba(255,255,255,.08);
}
.segmented button.selected{border-color:rgba(174,255,0,.55);background:linear-gradient(135deg,rgba(0,82,255,.22),rgba(174,255,0,.08));box-shadow:0 0 18px rgba(174,255,0,.12)}
.settings-card > .btn{margin-top:24px}
```

- [ ] **Step 2: Next up card: walk/wait line, reason, warnings, out-of-time state**

In `updateNavigationMode`, replace the `if(!current){ … return; }` block with:

```js
  const meta = document.getElementById("nextMeta");
  const reasonEl = document.getElementById("planReason");
  const lockedName = planState.lockDropped && latestRides.find(r => rideKey(r) === planState.lockDropped)?.name;
  const reasonText = lockedName ? `${lockedName} is temporarily closed.` : planState.reason;
  reasonEl.textContent = reasonText || "";
  reasonEl.classList.toggle("hidden", !reasonText);
  renderWarnings();

  if(!current){
    check.classList.add("hidden");
    wait.textContent = "";
    meta.textContent = "";
    const outOfTime = planStartMin !== null && budgetEndMin() - parkNow() < 15;

    if(!anyOpen){
      label.textContent = "Park closed";
      main.textContent = `${selectedPark} is closed right now`;
      sub.textContent = "No rides are reporting live waits. Your route builds automatically once rides open, or you can pick another park in Settings.";
    }else if(outOfTime){
      label.textContent = "Time's up";
      main.textContent = "Not enough time left for another ride";
      sub.textContent = "Add time in Settings to keep planning.";
    }else{
      label.textContent = "Route complete";
      main.textContent = "You’ve cleared your route";
      sub.textContent = "Every open ride on your list is done. Star more rides below to keep going.";
    }
    return;
  }
```

At the end of `updateNavigationMode` (after the wait display is set), add:

```js
  const walk = Math.max(1, Math.round(current.walkMin || 0));
  const waitPart = current.type === "food"
    ? `about ${estimateFoodDelay(current)} min in line`
    : current.type === "show" ? `starts ${minutesToClock(current.start)}`
    : current.wait_time > 0 ? `${current.wait_time} min wait` : "no wait";
  meta.textContent = `${walk} min walk · ${waitPart}`;
```

Add `renderWarnings`:

```js
function renderWarnings(){
  const el = document.getElementById("planWarnings");
  const nameOf = id => latestRides.find(r => rideKey(r) === id)?.name || "A must-ride";
  const remaining = formatDuration(Math.max(0, budgetEndMin() - parkNow()));
  el.innerHTML = planState.warnings.map(w => w.type === "must-ride-no-fit"
    ? `<p class="plan-warning">${esc(nameOf(w.id))} doesn’t fit in your remaining ${remaining}.<button type="button" onclick="showScreen('settings', document.querySelectorAll('.nav button')[2])">Add time</button></p>`
    : `<p class="plan-warning">${esc(nameOf(w.id))} is closed right now.</p>`
  ).join("");
  el.classList.toggle("hidden", !planState.warnings.length);
}
```

- [ ] **Step 3: Route list arrival times and summary footer**

In `renderRouteList`, inside the row template, directly before the `<span class="wait …">`, add:

```js
        <span class="eta">~${minutesToClock(r.arrive)}</span>
```

At the end of `renderRouteList` (after `el.innerHTML = …`), add:

```js
  const s = planState.summary;
  document.getElementById("routeSummary").textContent = s && s.rides
    ? `${s.rides} ride${s.rides === 1 ? "" : "s"} planned · ends ~${minutesToClock(s.end)} · ${(s.walkMeters / 1609.34).toFixed(1)} mi walking`
    : "";
```

In the empty branch at the top of `renderRouteList`, also clear it: add `document.getElementById("routeSummary").textContent = "";` before the `return`.

- [ ] **Step 4: Food banner and War Room numbers from the plan**

Replace `updateFoodTiming` with:

```js
function updateFoodTiming(){
  const banner = document.getElementById("foodTimingBanner");
  if(userFoodPlan === "skip-food"){
    banner.className = "banner info";
    banner.textContent = "No meal planned. Your route focuses fully on rides.";
    return;
  }
  const meal = currentStops().find(r => r.type === "food");
  if(meal){
    banner.className = "banner info";
    banner.innerHTML = `Meal stop at <strong>${esc(meal.name)}</strong> around ${minutesToClock(meal.start)}. Expect about ${estimateFoodDelay(meal)} min in line.`;
    return;
  }
  if(latestRides.some(r => r.type === "food" && completedRideKeys.includes(rideKey(r)))){
    banner.className = "banner good";
    banner.textContent = "Meal done. The rest of your day is rides.";
    return;
  }
  const text = {
    "window-passed": "Your meal window has passed, so your plan is rides only.",
    "no-time": "There isn’t time for a meal stop in your remaining plan.",
    "no-restaurant": "No restaurants near your route are available right now."
  }[planState.mealStatus] || "Finding the best meal window…";
  banner.className = "banner warn";
  banner.textContent = text;
}
```

Replace `calculateTimeSaved` with:

```js
// Wait + walk per ride vs a "nearest ride next" day, times the rides you'll do.
function calculateTimeSaved(){
  const s = planState.summary, b = planState.baseline;
  if(!s?.rides || !b?.rides) return "0.0";
  const planPerRide = (s.waitMin + s.walkMin) / s.rides;
  const basePerRide = b.waitWalkMin / b.rides;
  return (Math.max(0, (basePerRide - planPerRide) * s.rides) / 60).toFixed(1);
}
```

In `updateMetrics`, change `calculateTimeSaved(stops)` to `calculateTimeSaved()`.

In `updateAI`, replace the `avgRouteWait` / `projectedRides` lines and the `aiProjection` assignment with:

```js
  const s = planState.summary;
  document.getElementById("aiProjection").innerHTML = s?.rides
    ? `<strong>${s.rides} rides</strong> planned before ${minutesToClock(s.end)}.`
    : "No more rides fit in your remaining time.";
```

In `updateWarRoom`, replace the two `walkScore` / `walkText` lines with:

```js
  const s = planState.summary;
  document.getElementById("walkScore").innerHTML = s ? `${(s.walkMeters / 1609.34).toFixed(1)}<span class="unit">mi</span>` : "--";
  document.getElementById("walkText").textContent = s ? `${Math.round(s.walkMin)} min of walking across your plan.` : "Add more rides to see your walking.";
```

- [ ] **Step 5: Onboarding end time and location note**

In the onboarding `renderStep()` function, add at the end:

```js
  document.getElementById("locationNote").classList.toggle("hidden", obStep !== obSteps.length - 1);
  if(obStep === 2) updateEndTimeNote();
```

Add:

```js
function updateEndTimeNote(){
  const note = document.getElementById("endTimeNote");
  if(!parkDate){
    note.textContent = "";
    parkMetaReady?.then(updateEndTimeNote);
    return;
  }
  const hours = Number(document.getElementById("parkTimeVal").textContent);
  const end = parkNow() + hours * 60;
  note.textContent = parkCloseMin !== null && end > parkCloseMin
    ? `${selectedPark} closes at ${minutesToClock(parkCloseMin)}, so your plan ends then.`
    : `Until about ${minutesToClock(end)}`;
}
```

In the onboarding range `paint` function, add at the end: `if(input.dataset.output === "parkTimeVal") updateEndTimeNote();`

- [ ] **Step 6: Editable Settings**

Replace `renderSettings` with:

```js
function renderSettings(){
  document.getElementById("settingsPark").textContent = selectedPark;
  document.getElementById("settingsGroup").textContent = userPrefs.groupSize === 1 ? "1 person" : `${userPrefs.groupSize} people`;

  const hours = document.getElementById("settingsHours");
  hours.value = userPrefs.parkHours;
  hours.style.setProperty("--fill", ((hours.value - hours.min) / (hours.max - hours.min) * 100) + "%");
  const endText = planStartMin !== null ? ` · until ${minutesToClock(budgetEndMin())}` : "";
  document.getElementById("settingsHoursOut").textContent = `${userPrefs.parkHours} hours${endText}`;

  document.querySelectorAll(".segmented").forEach(group => {
    const value = group.dataset.setting === "food" ? userFoodPlan : userPrefs[group.dataset.setting];
    group.querySelectorAll("button").forEach(b => b.classList.toggle("selected", b.dataset.value === value));
  });
}

document.querySelectorAll(".segmented").forEach(group => {
  group.addEventListener("click", e => {
    const button = e.target.closest("button[data-value]");
    if(!button) return;
    if(group.dataset.setting === "food") userFoodPlan = button.dataset.value;
    else userPrefs[group.dataset.setting] = button.dataset.value;
    renderSettings();
    requestPlan({ prefsChanged:true });
  });
});

const settingsHours = document.getElementById("settingsHours");
settingsHours.addEventListener("input", () => {
  userPrefs.parkHours = Number(settingsHours.value);
  renderSettings();
});
settingsHours.addEventListener("change", () => requestPlan({ prefsChanged:true }));
```

Delete the old settings rows (`settingsHours`, `settingsThrill`, `settingsWalk`, `settingsFood` text setters) if any remain.

- [ ] **Step 7: Verify in Chrome**

Reload, then check each of these:
- Setup step 3 shows "Until about …" and updates as the slider moves.
- The last setup step shows the location note.
- Next up shows "N min walk · M min wait".
- Route rows show `~10:40` times, and the footer reads "11 rides planned · ends ~… · … mi walking".
- Star a closed ride (open the must-ride list, find a "Closed" row, star it). Expected: "<Ride> is closed right now." under Next up.
- Settings → Route style → Minimize walking re-plans within a second, and Next up shows "Updated for your new settings."
- Settings → drag hours to 2. Expected: fewer rides, and a must-ride warning with **Add time** if a starred ride no longer fits.
- In the console, set the budget to now with `planStartMin = parkNow() - userPrefs.parkHours*60 + 5`, then click Reevaluate route. Expected: "Not enough time left for another ride".
- War Room shows real miles, the planned ride count and the time saved.

- [ ] **Step 8: Run tests and commit**

Run: `python3 tests/run.py`
Expected: `PASS …, 0 failed`

```bash
git add index.html js/app.js
git commit -m "Show plan timing, reasons, warnings and editable settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: End-to-end verification

**Files:** none new, unless fixes are needed.

- [ ] **Step 1: Full test suite, headless and in Chrome**

Run: `python3 tests/run.py`
Expected: `PASS …, 0 failed, 2 skipped`

Open `http://127.0.0.1:8765/tests/run.html` in Chrome.
Expected: all pass, including both timing tests.

- [ ] **Step 2: Real parks**

For Magic Kingdom, EPCOT and Cedar Point (Cedar Point may be closed):
- build a route with default answers
- confirm the legs follow walkways, and later legs don't cross back over earlier ones more than once
- confirm the times make sense and the meal lands in its window
- confirm the console has no errors

- [ ] **Step 3: Stability**

With Magic Kingdom open, click **Refresh** three times, 10 seconds apart.
Expected: the Next up stop never changes, and the route list changes only when a reason line appears.

- [ ] **Step 4: Phone layout**

Chrome DevTools device toolbar → iPhone 14 (390 px).
Expected: no horizontal scroll, Next up and route rows readable, Settings segmented buttons fit on one line each.

- [ ] **Step 5: Commit any fixes, then summarize**

```bash
git add -A
git commit -m "Fix issues found in end-to-end verification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Report to the owner:
- what was verified
- screenshots of Magic Kingdom desktop and phone
- the rides review page link
- any SNAP_EXCEPTIONS added
- entrance coordinates that were adjusted
