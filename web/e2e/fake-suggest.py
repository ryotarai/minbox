#!/usr/bin/env python3
"""A stand-in for `claude -p --output-format json --json-schema ...` (reply suggestions).

Reads the prompt on stdin and prints a claude-like result envelope. The suggestions are fixed; the
first carries the number of PERSON messages in the prompt, so tests can tell what it held.
"""
import json
import os
import sys
import time

prompt = sys.stdin.read()

if prompt.startswith("Draft a Linear issue"):
    # The Create-Linear-issue dialog's guess. FAKE_LINEAR_DRAFT_HOLD: while that file exists the
    # answer is held back (tests use it to type while the draft is still "coming").
    hold = os.environ.get("FAKE_LINEAR_DRAFT_HOLD")
    for _ in range(400):
        if not (hold and os.path.exists(hold)):
            break
        time.sleep(0.05)
    subject = ""
    for line in prompt.splitlines():
        if line.startswith("Subject: "):
            subject = line[len("Subject: "):]
    draft = {
        "team_id": "team-1",
        "title": "Drafted: " + subject,
        "description": "## Summary\nDrafted from the thread.\n",
        "priority": 2,
        "label_ids": ["lab-1"],
        "project_id": "proj-1",
        "assignee_id": "u1",
        "state_id": "st-3",
    }
    # The person's extra prompt (Settings): echo what the instruction section held, so tests see it arrive.
    hdr = "Additional instructions from the person"
    if hdr in prompt:
        sect = prompt.split(hdr, 1)[1].split("<<<\n", 1)[1].split("\n>>>", 1)[0]
        draft["description"] += "Extra prompt seen: " + sect.strip() + "\n"
    print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": "{}", "structured_output": draft}))
    sys.exit(0)
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
