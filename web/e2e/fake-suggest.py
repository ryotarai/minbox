#!/usr/bin/env python3
"""A stand-in for `claude -p --output-format json --json-schema ...` (reply suggestions).

Reads the prompt on stdin and prints a claude-like result envelope. The suggestions are fixed; the
first carries the number of PERSON messages in the prompt, so tests can tell what it held.
"""
import json
import os
import sys

prompt = sys.stdin.read()
n = prompt.count("[PERSON]")
out = {
    "type": "result",
    "subtype": "success",
    "is_error": False,
    "result": "{}",
    "structured_output": {"suggestions": ["Sounds good, go ahead (%d)" % n, "Thanks, looks good", "Can you give more detail?"]},
}
# Screenshots (SCREENSHOTS=1) may fix the suggestions with a JSON list in a file.
f = os.environ.get("FAKE_SUGGEST_FILE")
if f and os.path.exists(f):
    out["structured_output"]["suggestions"] = json.load(open(f))
print(json.dumps(out))
