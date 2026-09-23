# RideFlow: Walking-Path Routing & Day Planner — Design

**Date:** 2026-09-23
**Status:** Draft for review
**Scope:** Replace RideFlow's route builder with a search-based day planner that uses real park walkways, curated ride details, and every onboarding preference, and show routes that follow actual paths.

## 1. Goal

Fit the most rides the guest will enjoy into the time they have.

"Enjoy" is defined by the onboarding answers: thrill level, walking style, group size, food plan and must-rides. "Time they have" is the smaller of their chosen hours and the park's closing time. Walking time comes from real walkways, not straight lines.

### Problems this fixes

- Routes zigzag across the park. Distance is measured in raw GPS degrees and weighted too lightly to matter against ride scores.
- Chosen park hours are ignored by the route builder; they only feed War Room numbers.
- Thrill level is guessed from ride names ("mountain", "coaster"), so rides like Tron or Seven Dwarfs Mine Train are misclassified.
- The route line cuts through buildings and lagoons.

### Out of scope (this version)

- Predictive wait forecasting (plans assume current waits; re-planning absorbs changes).
- Lightning Lane, single rider, virtual queues.
- Riding the same attraction twice.
- Accounts, saved days, multi-park days.

## 2. Decisions made during design

| Decision | Choice |
|---|---|
| Route objective | Maximize enjoyment within the time budget, weighing all onboarding answers |
| Ride details source | Curated per-park file, drafted by Claude, reviewed by the owner |
| Re-planning | Re-plan on every refresh and check-off; the next stop is locked |
| Location | Phone GPS with fallback to last checked-off ride / park entrance |
| Planner algorithm | Search-based (approach 3): beam search to build, simulated annealing to refine |
| Project location | `~/RideFlow`, git-tracked, plain static files, no build step |
| Test runner | In-browser (`tests/run.html`); Node is not installed on this machine |

## 3. Project structure

```
~/RideFlow/
  index.html                  page layout + styles
  js/
    app.js                    screens, events, map drawing, data fetching (moved out of index.html)
    walkgraph.js              walkway graph: shortest walking time + path geometry
    planner.js                enjoyment scoring, beam search, simulated annealing (pure; no DOM, no network)
    planner-worker.js         runs planner.js off the main thread
  data/
    walkways/<park-slug>.json one per park
    rides/<park-slug>.json    curated ride details, one per park
  tools/
    build-walkways.py         one-time OpenStreetMap walkway download + graph build
  tests/
    run.html                  in-browser test runner
    planner.test.js
    walkgraph.test.js
    fixtures/                 small fake parks with known answers
  docs/specs/                 this document
  archive/index.original.html the pre-redesign original
```

`js/*.js` are ES modules loaded with `<script type="module">`, so the site must be served over HTTP (it already is) rather than opened as a file.

Park slugs: `magic-kingdom`, `epcot`, `hollywood-studios`, `animal-kingdom`, `disneyland`, `cedar-point`, `kings-island`.

### Unit boundaries

- **`walkgraph.js`** — `loadWalkGraph(json)` → graph; `nearestNode(graph, lat, lng)`; `walkMatrix(graph, stops, speedMpm)` → minutes between every pair of stops; `pathBetween(graph, a, b)` → `[[lat,lng], …]` for drawing. No knowledge of rides or preferences.
- **`planner.js`** — `planDay({ stops, matrix, prefs, now, budgetEnd, mustRides, lockedNextId, previousPlan, seed })` → `{ plan, score, warnings, reason }`. No DOM, no fetch, no `Date.now()` (time is passed in), deterministic for a given seed.
- **`app.js`** — owns state, fetching, the worker, and rendering. The only unit that touches the page or network.

## 4. Data

### 4.1 Walkways (`tools/build-walkways.py`)

Run once per park (and whenever maps should be refreshed). Output is committed to the repo.

1. Compute the park bounding box from ThemeParks.wiki `/entity/{parkId}/children` locations, plus a 150 m margin.
2. Query Overpass for ways with `highway` in `footway, pedestrian, path, steps, living_street, corridor`. Exclude `access=private|no` and all `highway=service` (backstage roads). The script tries `overpass-api.de`, then `maps.mail.ru/osm/tools/overpass`, with a descriptive User-Agent (`RideFlow/0.1 (walkway build)`).
3. Build an undirected graph; edge weight is geodesic metres. `steps` edges are weighted ×1.3.
4. Keep only the largest connected component.
5. Collapse chains of degree-2 nodes into single edges that store their intermediate geometry, shrinking the file while keeping drawable shapes.
6. Snap every attraction, show, restaurant, and the park entrance to the nearest graph node; record the snap distance. Fail the build if any attraction snaps farther than 60 m (warn above 30 m).
7. Write `data/walkways/<slug>.json`:

```json
{
  "park": "magic-kingdom",
  "builtAt": "2026-09-23T12:00:00Z",
  "source": "OpenStreetMap contributors (ODbL)",
  "nodes": [[28.41771, -81.58121], ...],
  "edges": [[0, 1, 42.7, [[28.4178, -81.5811], ...]], ...],
  "anchors": { "<themeparks-entity-id>": { "node": 123, "snapM": 7.2 }, "entrance": { "node": 5, "snapM": 3.1 } }
}
```

Target size: ≤ 250 KB per park.

Park entrances are listed in the script (a coordinate per park) since ThemeParks.wiki does not provide them.

### 4.2 Ride details (`data/rides/<slug>.json`)

Keyed by ThemeParks.wiki entity ID (stable across renames). The name is included for human review only.

```json
{
  "<attraction-entity-id>": {
    "name": "Space Mountain",
    "type": "coaster",
    "thrill": 4,
    "popularity": 3,
    "kidFriendly": false,
    "minHeightIn": 44,
    "durationMin": 3
  }
}
```

- `type`: `coaster | dark-ride | water | show | spinner | transport | walkthrough | play-area | simulator`
- `thrill`: 1–5. `popularity`: 1–3 (3 = headliner). `minHeightIn`: `null` if none.
- Claude drafts all 7 parks. Durations and heights come from Claude's knowledge and must be reviewed: Claude publishes a single review page listing every ride with its fields for the owner to skim and correct.
- Unmatched attractions (e.g. a new ride) fall back to the existing name-keyword heuristics with `thrill: 3, popularity: 1, durationMin: 5` and are logged once to the console as `[RideFlow] missing ride details: <name> <id>`.

### 4.3 Live data additions

- Park hours: `GET /v1/entity/{parkId}/schedule` → today's `OPERATING` closing time. On failure, there is no closing cap.
- Show times: `liveData[].showtimes` where present. Shows are planned only at a listed start time (arrive ≥ 5 min before); a show with no showtimes is treated like an attraction with `durationMin`.

## 5. Scoring model

### 5.1 Enjoyment points per ride

Base points by thrill preference × ride thrill:

| Preference | T1 | T2 | T3 | T4 | T5 |
|---|---|---|---|---|---|
| `easy` (Family friendly) | 60 | 60 | 35 | 10 | 0 |
| `balanced` | 35 | 50 | 60 | 55 | 40 |
| `extreme` (Big thrills) | 15 | 25 | 45 | 60 | 60 |

Adjustments:
- Popularity: +0 / +12 / +25 for popularity 1 / 2 / 3.
- Family friendly and `minHeightIn ≥ 44`: points × 0.33.
- Walking style `max` (Max rides): +10 flat per ride.
- Group size ≥ 6 and `kidFriendly`: +8.

### 5.2 Time cost per stop

`walk(prev → stop) + wait + durationMin + 3` (load/unload), in minutes.

- `wait`: current `STANDBY` wait; `null` → 0.
- Walking speed: 75 m/min × 0.85 if group ≥ 6 × 0.9 if thrill = `easy`.

### 5.3 Walking penalty

Walking minutes subtract points: × 1.6 (`low` / Minimize walking), × 1.0 (`balanced`), × 0.8 (`max`).

### 5.4 Meal

- One meal block: `estimateFoodDelay(restaurant) + 40` minutes.
- Window: `eat-early` starts 11:00–12:30, or within the first 2 hours if the plan starts after 11:00. `eat-late` starts 13:30–15:00. `skip-food`: no meal.
- If the window has already passed when planning, the meal is dropped and the Food banner says so.
- Restaurant choice is part of the search. Family friendly excludes `servesAlcohol` venues (existing rule).

### 5.5 Time budget

`budgetEnd = min(planStart + parkHours, parkClose)`. `planStart` is launch time and does not move on re-plans; re-plans spend only the remaining budget.

### 5.6 Day score

`score = Σ enjoyment(planned rides) − walkPenalty × Σ walkMinutes`

A plan is **valid** if it ends by `budgetEnd`, contains the meal (when required and its window is reachable), and starts with `lockedNextId` if one is set. A plan is **complete** if it is valid and contains every must-ride. Complete plans always beat incomplete ones; among equals, higher score wins.

## 6. Search

### 6.1 Walk matrix

Before searching, `walkMatrix` computes walking minutes between all candidate stops (open attractions, reachable shows, candidate restaurants, and the start point) using Dijkstra from each stop's anchor node. Magic Kingdom is about 60 stops and 3,600 pairs, with a target of < 50 ms. Restaurant candidates are limited to the 12 best-scoring by `estimateFoodDelay` to keep the matrix small.

Start point, in priority order:
1. GPS fix with accuracy ≤ 50 m inside the park bounding box, snapped to the nearest node.
2. The last checked-off stop.
3. The park entrance.

### 6.2 Stage 1: Beam search

- State: `(sequence, clock, points, walkMinutes, visitedSet, mealDone)`.
- Start: the locked next stop, if any, is forced as step 1.
- Expand: every unvisited open stop that fits before `budgetEnd`, respecting the meal window and show start times.
- Rank: `points − walkPenalty·walkMinutes + optimisticRemaining`, where `optimisticRemaining` = the sum of the best remaining enjoyment values that could fit in the remaining minutes, assuming zero walking. Must-rides not yet in the sequence add a large bonus (1000) so complete plans surface.
- Beam width: 200. Terminate when no state can be expanded. The result is the best complete plan, or the best valid plan if none is complete.

### 6.3 Stage 2: Simulated annealing

- Start from the beam result. Seeded PRNG (mulberry32); seed = hash(park slug + ISO date + planStart).
- Moves (chosen uniformly): swap two stops · relocate one stop · reverse a segment (2-opt) · drop a non-must ride · insert an unplanned ride · replace a planned ride with an unplanned one · change restaurant.
- The locked first stop is never moved. Invalid neighbours are rejected.
- Temperature: geometric cooling from T₀ = 20 to 0.5.
- Time limit: 300 ms wall clock (checked every 256 iterations), then return the best plan seen.

### 6.4 Stability rule

On re-plan with an existing plan:
1. Re-time the existing plan's remaining stops with new waits (dropping stops that closed or no longer fit).
2. Run the search.
3. Adopt the new plan only if its score is ≥ 3% higher than the re-timed old plan, or the old plan became invalid or incomplete.
4. If adopted, `reason` names the biggest driver: a wait drop/rise ≥ 10 min on a planned or newly added ride, a ride closing, or a preference change.

### 6.5 Locked next stop

- Set when a plan is first shown; cleared when the guest checks it off (the next stop becomes locked) or it closes.
- If the locked stop goes down, it unlocks, the search re-runs, and the Next up card says "<Ride> is temporarily closed."

### 6.6 Threading

`planner-worker.js` runs `walkMatrix` + `planDay` in a Web Worker. `app.js` posts inputs and renders on reply. If a newer request arrives, stale replies are ignored (request id).

## 7. UI changes

### Map
- The route is drawn along `pathBetween` geometry for each leg. The leg from the start point to the next stop uses the full neon style; later legs use about 45% opacity.
- GPS: a pulsing cyan "you are here" dot plus an accuracy circle when accuracy > 20 m. A small locate button re-centres the map on it.
- Stops whose position changed in the latest re-plan flash once.

### Next up card
- Sub-line: "6 min walk · 15 min wait" (or "No wait").
- The re-plan reason, when present, shown under the ride name.
- Must-ride warning: "<Ride> doesn't fit in your remaining 1h 40m", with a link to Settings.

### Route list
- Each row shows the estimated arrival time (`~10:40`).
- Footer: "11 rides planned · ends ~4:15 PM · 2.1 mi walking".

### Onboarding
- The hours step shows the end time live: "6 hours → until about 4:15 PM", capped at park close with a note when the cap applies.
- On launch, one plain-language line before the browser's location prompt: "RideFlow uses your location to plan walks from where you are." Declining changes nothing else.

### War Room
- Time saved: `planner total wait+walk minutes` vs a baseline "nearest open ride next" plan over the same budget, in hours.
- At this pace: the planner's ride count.
- Walking: the plan's total distance in miles and minutes (replaces the fixed "Excellent").

### Settings
- Hours, thrill level, walking style, and food plan are editable in place (same controls as onboarding). Changing one re-plans immediately; the locked next stop is kept.
- "Start over with a new park" remains.

## 8. Error handling

| Situation | Behaviour |
|---|---|
| Walkway file fails to load | Use straight-line metres × 1.35 for the matrix; draw straight legs; note "Walking times are estimates." |
| GPS denied, unavailable, or accuracy > 50 m | Use the fallback start point silently. |
| GPS fix outside the park bounding box | Start from the entrance; note "Planning from the park entrance." |
| Attraction missing from ride details | Heuristic fallback + one console log. |
| Must-ride cannot fit | Plan without it; show a warning with a Settings link. |
| Search hits the time limit | Return the best valid plan found (the beam result guarantees one exists if any valid plan does). |
| No valid plan (e.g. 5 min left) | Next up: "Not enough time left for another ride"; route list empty state. |
| Schedule endpoint fails | No closing cap. |
| Live data refresh fails | Keep the current plan; existing "Couldn't refresh" message. |
| Worker unavailable | Run the planner on the main thread with a 150 ms limit. |

## 9. Testing

### 9.1 In-browser test runner

`tests/run.html` loads the test modules and prints pass/fail. There are no dependencies: a ~40-line `test()`/`assert` helper lives in the runner.

### 9.2 Planner tests (fixtures: small fake parks)

- Never exceeds `budgetEnd`.
- Includes all must-rides when feasible; warns when not.
- The meal starts within its window; no meal for `skip-food`.
- Family friendly never plans thrill-5 rides when alternatives exist.
- `low` walking walks fewer minutes than `max` on the same fixture.
- Deterministic: same inputs + seed → identical plan.
- The locked next stop is always first.
- Stability: a re-plan with a < 3% better alternative keeps the old plan.
- Beats a greedy "nearest open ride" baseline on score for every fixture.
- Performance: a synthetic 60-stop park plans within 350 ms total in Chrome.

### 9.3 Walkgraph tests

- Walking distance ≥ straight-line distance for random pairs; ≤ 3× on the real Magic Kingdom graph.
- Every attraction anchor has `snapM ≤ 30` (warnings allowed up to 60).
- `pathBetween` starts and ends at the requested anchors.

### 9.4 Manual checks in Chrome

- Plan real days at Magic Kingdom, EPCOT, and one closed park; visually confirm routes follow paths and don't cross themselves.
- Simulate GPS (DevTools sensors) inside, outside, and denied.
- Check off rides; confirm the next stop locks and re-plans are calm.
- Phone layout at 390 px.

## 10. Attribution & usage notes

- Walkway data © OpenStreetMap contributors, ODbL; credited in the map attribution and the data files.
- Overpass is used only by the offline build script, never by the app at runtime.
- Map tiles are still OpenStreetMap's public servers (dev only). Moving to a keyed tile provider before launch is tracked separately.
