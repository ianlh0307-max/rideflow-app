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
