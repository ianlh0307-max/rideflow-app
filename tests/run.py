#!/usr/bin/env python3
"""Run RideFlow's browser tests in headless Chrome. Needs the dev server on :8765.

Usage: python3 tests/run.py [test-file-name]
"""
import html
import re
import subprocess
import sys

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
url = "http://127.0.0.1:8765/tests/run.html?headless=1"
if len(sys.argv) > 1:
    url += f"&only={sys.argv[1]}"

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
