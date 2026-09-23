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
    "hollywood-studios": {"id": "288747d1-8b4f-4a64-867e-ea7c9b27bad8", "entrance": (28.3584, -81.5587)},
    "animal-kingdom": {"id": "1c84a229-8862-4648-9c71-378ddd2c7693", "entrance": (28.3554, -81.5901)},
    "disneyland": {"id": "7340550b-c14d-4def-80bb-acdb51d49a66", "entrance": (33.8096, -117.9190)},
    "cedar-point": {"id": "c8299e1a-0098-4677-8ead-dd0da204f8dc", "entrance": (41.4798, -82.6832)},
    "kings-island": {"id": "694e1f6e-d6a2-4c86-9749-5da1a9cb8924", "entrance": (39.3450, -84.2688)},
}

# Attractions allowed to snap farther than MAX_SNAP_M (e.g. reached only by boat).
# Add an ID here only after checking it on the map.
SNAP_EXCEPTIONS = {
    # Conservation Station is reached only by the Wildlife Express train.
    "animal-kingdom": {"6fbe6d02-4057-43bb-80a3-047b1e8a50ca", "d5dfc051-f951-40ac-8774-3e9961331ab9"},
}


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
            pid: {"node": index[n], "snapM": round(d, 1), "kind": kind,
                  **({"exception": True} if pid in SNAP_EXCEPTIONS.get(slug, set()) else {})}
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
