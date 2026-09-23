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
