#!/usr/bin/env python3
"""A stand-in for `claude` in end-to-end tests: it talks to minbox's agent API
the way the minbox mod does (hello, send_message, pending -> claim -> delivered),
and echoes what it receives to the terminal, without a real model.

Typed commands (one per line):
  ask        send a message with a question block
  say <text> send a plain message
  mark <status> [text]  send a message that sets the thread's status (working|need_action|finished)
  work       status working: queued messages wait (idle ends it)
  exit       quit
"""
import json, os, sys, threading, time, urllib.error, urllib.request, uuid

token = os.environ["MINBOX_TOKEN"]
server_file = os.environ["MINBOX_SERVER_FILE"]
owner = uuid.uuid4().hex
args = sys.argv[1:]
session_id = args[args.index("--session-id") + 1] if "--session-id" in args else (args[args.index("--resume") + 1] if "--resume" in args else "none")
mode = "resume" if "--resume" in args else "new"
last_thread = None
busy = False  # "work": a turn is running; only urgent messages are taken


def base():
    with open(server_file) as f:
        return json.load(f)["url"]


def api(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base() + path, data=data, method=method,
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return {"error": e.read().decode()}


def out(s):
    sys.stdout.write(s.replace("\n", "\r\n") + "\r\n")
    sys.stdout.flush()


def poll():
    global last_thread
    while True:
        try:
            pending = api("GET", f"/api/agent/pending?owner={owner}&wait=20")
            for p in pending:
                if busy and not p.get("urgent"):
                    continue
                if api("POST", f"/api/agent/pending/{p['id']}/claim?owner={owner}")["claimed"]:
                    last_thread = p["thread_id"]
                    out(f"<<< inbox [{p['subject']}] {p['body']}")
                    api("POST", f"/api/agent/pending/{p['id']}/delivered?owner={owner}")
        except Exception as e:  # server restarting
            time.sleep(1)


out(f"fake-claude {mode} session={session_id} cwd={os.getcwd()}")
api("POST", "/api/agent/hello", {"claude_session_id": session_id})
api("POST", "/api/agent/status", {"status": "idle"})
threading.Thread(target=poll, daemon=True).start()
out("ready> ")

for raw in sys.stdin:  # the PTY is in cooked mode: it echoes and gives lines
    line = raw.strip()
    if line == "exit":
        out("bye")
        sys.exit(0)
    elif line in ("work", "idle"):
        busy = line == "work"
        api("POST", "/api/agent/status", {"status": "working" if busy else "idle"})
        out(f"status {line}")
    elif line == "ask":
        r = api("POST", "/api/agent/messages", {
            "subject": "Pick a database",
            "body": "I need a decision.\n\n:::question\nWhich database should we use?\n\nWe store small records.\n\n- [ ] SQLite — simplest\n- [ ] Postgres — needs a server\n\nRecommended: SQLite\n:::\n\n:::question-text\nAnything else?\n:::",
        })
        last_thread = r["thread_id"]
        out(f"sent question in {r['thread_id']}")
    elif line == "stop":
        r = api("POST", "/api/agent/messages", {
            "subject": "Archive rules",
            "name": "archive-search",
            "body": "Two things before the migration.\n\n:::question\nShould an archived thread come back when Claude writes?\nStopped: migration 0007 waits on this.\n- [ ] Come back — like mail\n- [ ] Stay archived\nRecommended: Come back\n:::\n\n:::question-multi\nWhat should search cover?\nHolds up: search API; search UI\n- [ ] Subjects\n- [ ] Bodies\n- [ ] File names\nRecommended: Bodies\n:::",
        })
        last_thread = r["thread_id"]
        out(f"sent stop in {r['thread_id']}")
    elif line == "actions":
        r = api("POST", "/api/agent/messages", {
            "subject": "Before the deploy",
            "body": "Please do these by hand.\n\n:::actions\nDeploy prep\n- [ ] Add the GitHub labels\n- [ ] Check the staging DNS\n:::",
        })
        last_thread = r["thread_id"]
        out(f"sent actions in {r['thread_id']}")
    elif line.startswith("title "):
        r = api("POST", "/api/agent/title", {"title": line[len("title "):]})
        out(f"titled {r['title']}")
    elif line.startswith("openurl "):
        r = api("POST", "/api/agent/open", {"url": line[len("openurl "):]})
        out(f"opened {r.get('url', r)}")
    elif line == "attach":
        with open("plan.md", "w") as f:
            f.write("# Archive plan\n\nAdd `archived_at` to threads and sessions.\n\n## Changes\n\n- Archived threads leave the list and come back when Claude writes.\n- Search uses LIKE first, capped at 50.\n")
        r = api("POST", "/api/agent/messages", {"subject": "The plan", "body": "I wrote the plan; have a look.", "attachments": ["plan.md"]})
        last_thread = r["thread_id"]
        out(f"sent attach in {r['thread_id']}")
    elif line == "kinds":
        import base64
        files = {
            "main.go": "package main\n\nfunc main() {\n\tprintln(\"hi\")\n}\n",
            "data.json": "{\n  \"a\": 1\n}\n",
            "page.html": "<!doctype html><html><body><h1 id=t>Mock page</h1><img src=pic.png><button>Click</button></body></html>",
            "flow.mmd": "graph TD\n  A[Start] --> B[Done]\n",
            "graph.dot": "digraph G { a -> b }\n",
            "doc.pdf": "%PDF-1.4\n%fake\n",
        }
        for n, c in files.items():
            with open(n, "w") as f:
                f.write(c)
        with open("pic.png", "wb") as f:
            f.write(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR42mNk+M9Qz0AEYBxVSF8ADY0BBQqqP0kAAAAASUVORK5CYII="))
        with open("blob.bin", "wb") as f:
            f.write(bytes([0, 1, 2, 3, 255]))
        r = api("POST", "/api/agent/messages", {"subject": "Many kinds", "body": "Files of every kind.",
            "attachments": list(files) + ["pic.png", "blob.bin"]})
        last_thread = r["thread_id"]
        out(f"sent kinds in {r['thread_id']} {len(r.get('attachments', []))}")
    elif line == "rich":
        import base64
        with open("shot.png", "wb") as f:
            f.write(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR42mNk+M9Qz0AEYBxVSF8ADY0BBQqqP0kAAAAASUVORK5CYII="))
        with open("plan.md", "w") as f:
            f.write("# Plan\n\nDo it.\n")
        body = ("A diagram:\n\n```mermaid\ngraph LR\n  X --> Y\n```\n\nA picture:\n\n```svg\n<svg xmlns='http://www.w3.org/2000/svg' width='40' height='20'><rect width='40' height='20' fill='teal'/></svg>\n```\n\nA page:\n\n```html\n<div id=chart style='color:var(--foreground)'>Live chart</div>\n```\n\n"
                "A screenshot: ![shot](shot.png)\n\nSee [the plan](plan.md) and [missing](nope.md).")
        r = api("POST", "/api/agent/messages", {"subject": "Rich body", "body": body, "attachments": ["plan.md"]})
        last_thread = r["thread_id"]
        out(f"sent rich in {r['thread_id']} not_shown={len(r.get('images_not_shown') or [])}")
    elif line == "review":
        with open("derive.go", "w") as f:
            f.write("package store\n\nfunc Section(archived bool) string {\n\tif archived {\n\t\treturn \"archived\"\n\t}\n\treturn \"quiet\"\n}\n")
        r = api("POST", "/api/agent/messages", {"subject": "Review the store change", "body": "Ready for review.",
            "review": {"title": "Archive in the store", "summary": "Sections are derived in one place.",
                       "sections": [{"title": "Section rules", "summary": "The first rule that matches wins.", "files": ["derive.go"]}]}})
        last_thread = r["thread_id"]
        out(f"sent review in {r['thread_id']}")
    elif line in ("mouse", "mouse drag"):
        # A full-screen program that tracks the mouse (like Claude Code's
        # full-screen UI): alternate screen, button events, SGR encoding.
        import termios, tty, select
        fd = sys.stdin.fileno()
        saved = termios.tcgetattr(fd)
        sys.stdout.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h" + ("\x1b[?1002h" if line == "mouse drag" else ""))
        sys.stdout.flush()
        tty.setraw(fd)
        got = b""
        end = time.time() + 6
        while time.time() < end and b"q" not in got:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                got += os.read(fd, 1024)
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        sys.stdout.write("\x1b[?1002l\x1b[?1006l\x1b[?1000l\x1b[?1049l")
        out("mouse got: " + repr(got))
    elif line.startswith("card "):
        r = api("POST", "/api/agent/cards", {"title": line[5:], "column": "building", "note": "working on it"})
        out(f"card {r.get('id', r)}")
    elif line.startswith("retitle "):
        r = api("POST", "/api/agent/messages", {"body": "The topic moved on.", "thread_id": last_thread, "thread_title": line[8:]})
        out(f"retitled {r['thread_id']}")
    elif line.startswith("mark "):
        # mark <status> [text]: a message in the last thread (or a new one) that sets the thread's status
        status, _, text = line[5:].partition(" ")
        body = {"body": text or f"Marked {status}", "status": status}
        if last_thread:
            body["thread_id"] = last_thread
        else:
            body["subject"] = "Status note"
        r = api("POST", "/api/agent/messages", body)
        last_thread = r["thread_id"]
        out(f"marked {r['thread_id']}")
    elif line.startswith("say "):
        body = {"body": line[4:]}
        if last_thread:
            body["thread_id"] = last_thread
        else:
            body["subject"] = "Note"
        r = api("POST", "/api/agent/messages", body)
        last_thread = r["thread_id"]
        out(f"sent in {r['thread_id']}")
    elif line:
        out(f"echo: {line}")
    out("ready> ")
