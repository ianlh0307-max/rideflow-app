# RideFlow

A real-time theme-park day planner: it fits the most rides you'll enjoy into the time you have,
routing along real park walkways with live wait times.

**Live site:** https://ianlh0307-max.github.io/rideflow-app/

## Run locally

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open http://127.0.0.1:8765/index.html. (The app uses ES modules, so it must be served, not opened as a file.)

## Tests

With the server running: `python3 tests/run.py` (headless Chrome), or open `/tests/run.html` in Chrome to include the timing tests.

## Data

- Live waits: [ThemeParks.wiki](https://themeparks.wiki)
- Walkways: `tools/build-walkways.py` — © OpenStreetMap contributors (ODbL)
- Map tiles: [Stadia Maps](https://stadiamaps.com) — register the site's domain in the Stadia dashboard
