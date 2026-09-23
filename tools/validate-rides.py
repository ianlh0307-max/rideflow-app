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
