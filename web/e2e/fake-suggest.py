#!/usr/bin/env python3
"""A stand-in for `claude -p --output-format json --json-schema ...` (reply questions and other helpers).

Reads the prompt on stdin and prints a claude-like result envelope. The reply questions are fixed; the
first carries the number of PERSON messages in the prompt, so tests can tell what it held.
"""
import json
import os
import sys
import time

prompt = sys.stdin.read()

if prompt.startswith("Choose the workflow state"):
    # Step two of the Create-Linear-issue draft: the team's state and labels.
    print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": "{}", "structured_output": {"state_id": "st-3", "label_ids": ["lab-1"]}}))
    sys.exit(0)

if prompt.startswith("Judge which of the Slack threads"):
    # The Slack screen's judgement: one entry per <slack_thread id=...> block, decided by what it says.
    import re
    fail = os.environ.get("FAKE_JUDGE_FAIL")
    if fail and os.path.exists(fail):
        print("judge failed on purpose", file=sys.stderr)
        sys.exit(1)
    out = []
    for m in re.finditer(r'<slack_thread id="([^"]+)"[^>]*>\n(.*?)</slack_thread>', prompt, re.S):
        tid, body = m.group(1), m.group(2)
        if "review" in body:
            out.append({"id": tid, "needs_reply": "yes", "reason": "Alice asks you to review PR 12 before noon", "urgency": "high", "summary": "Review request on the auth flow", "suggested_next_step": "Review the PR and answer Alice"})
        elif "quick call" in body:
            out.append({"id": tid, "needs_reply": "maybe", "reason": "Alice asks if you are free for a call", "urgency": "normal", "summary": "Call request"})
        else:
            out.append({"id": tid, "needs_reply": "no", "reason": "Only thanks", "urgency": "low", "summary": "Nothing to do"})
    print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": "{}", "structured_output": {"judgements": out}}))
    sys.exit(0)

if prompt.startswith("Choose which project the Linear issue") or prompt.startswith("Choose which project the Slack thread"):
    # The project pick of a thread started from an issue: the project named in FAKE_PICK_NAME, else the first.
    want = os.environ.get("FAKE_PICK_NAME", "")
    ids = []
    for line in prompt.splitlines():
        if line.startswith("- id: "):
            pid = line[len("- id: "):].split(" |", 1)[0]
            ids.append((pid, line))
    chosen = next((pid for pid, line in ids if want and ("name: " + want) in line), ids[0][0] if ids else None)
    print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": "{}", "structured_output": {"project_id": chosen}}))
    sys.exit(0)

if prompt.startswith("Draft a Linear issue"):
    # The Create-Linear-issue dialog's guess. FAKE_LINEAR_DRAFT_HOLD: while that file exists the
    # answer is held back (tests use it to type while the draft is still "coming").
    hold = os.environ.get("FAKE_LINEAR_DRAFT_HOLD")
    for _ in range(400):
        if not (hold and os.path.exists(hold)):
            break
        time.sleep(0.05)
    subject = ""
    if "<issue_request>" in prompt:
        # The plain-language draft (My issues > New issue): the title echoes the first line of the request.
        req = prompt.split("<issue_request>\n", 1)[1].split("\n</issue_request>", 1)[0].strip()
        subject = req.splitlines()[0] if req else ""
    for line in prompt.splitlines():
        if line.startswith("Subject: "):
            subject = line[len("Subject: "):]
    draft = {
        "team_id": "team-1",
        "title": "Drafted: " + subject,
        "description": ("## Background\nDrafted from the request.\n" if "<issue_request>" in prompt else "## Summary\nDrafted from the thread.\n"),
        "priority": 2,
        "label_ids": ["lab-1"],
        "project_id": "proj-1",
        "assignee_id": "u1",
        "state_id": "st-3",
    }
    if "team_id must be exactly " in prompt:
        # One step: the person chose the team first, the prompt holds its states and labels.
        draft["team_id"] = prompt.split("team_id must be exactly ", 1)[1].split(" ", 1)[0]
        if draft["team_id"] == "team-2":
            draft["state_id"], draft["label_ids"] = "st-d2", ["lab-d1"]
    else:
        # Two steps: no states or labels in this answer (step two chooses them).
        draft.pop("state_id")
        draft.pop("label_ids")
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
    "structured_output": {
        "questions": [
            {"question": "How should it continue? (%d)" % n, "kind": "single", "options": [
                {"label": "Go ahead", "description": "Continue with the plan"},
                {"label": "Wait for me"},
            ]},
            {"question": "What should it check?", "kind": "multi", "options": [
                {"label": "Tests"}, {"label": "Docs"}, {"label": "Lint"},
            ]},
            {"question": "Anything else to tell it?", "kind": "single", "options": []},
        ]
    },
}
# Screenshots (SCREENSHOTS=1) may fix the questions with a JSON file: a list of questions, or the
# whole structured output ({"questions": [...], "command": "..."}).
f = os.environ.get("FAKE_SUGGEST_FILE")
if f and os.path.exists(f):
    v = json.load(open(f))
    out["structured_output"] = {"questions": v} if isinstance(v, list) else v
print(json.dumps(out))
