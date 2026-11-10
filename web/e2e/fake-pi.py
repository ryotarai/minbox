#!/usr/bin/env python3
"""A stand-in for `pi` in end-to-end tests: it takes the command line minbox gives Pi
(`-e <extension> --session-id <id> --append-system-prompt <text>`), and talks to minbox's agent API
the way plugin/pi/minbox.ts does (hello with agent_session_id, status, pending -> claim -> delivered),
echoing what it receives to the terminal, without a model.

Typed commands (one per line), the subset of fake-claude.py the Pi tests need:
  ask               send a message with a question block
  say <text>        send a plain message
  title <text>      set the session title
  work / idle       report working / idle (while working only urgent messages are taken)
  args              print the command line it was started with
  env               print MINBOX_* variables it got
  exit              quit
"""
import json, os, sys, threading, time, urllib.error, urllib.request, uuid

token = os.environ["MINBOX_TOKEN"]
server_file = os.environ["MINBOX_SERVER_FILE"]
owner = uuid.uuid4().hex
args = sys.argv[1:]
if "--version" in args:
    print("fake-pi 0.0.0")
    sys.exit(0)
session_id = args[args.index("--session-id") + 1] if "--session-id" in args else "none"
extension = args[args.index("-e") + 1] if "-e" in args else "none"
instructions = args[args.index("--append-system-prompt") + 1] if "--append-system-prompt" in args else ""
last_thread = None
busy = False


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
        except Exception:  # server restarting
            time.sleep(1)


out(f"fake-pi session={session_id} cwd={os.getcwd()} extension={os.path.basename(extension)}")
hello = api("POST", "/api/agent/hello", {"agent": "pi", "agent_session_id": session_id, "ext_version": "fake"})
out(f"hello agent={hello.get('agent')} orchestration={'yes' if 'orchestration' in hello.get('instructions', '') else 'no'} tools={'minbox_' if 'minbox_send_message' in hello.get('instructions', '') else 'other'}")
api("POST", "/api/agent/status", {"status": "idle"})
threading.Thread(target=poll, daemon=True).start()
out("ready> ")

for raw in sys.stdin:
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
            "thread_title": "Pick a database", "status": "need_action",
            "body": "I need a decision.\n\n:::question\nWhich database should we use?\n\n- [ ] SQLite — simplest\n- [ ] Postgres — needs a server\n\nRecommended: SQLite\n:::",
        })
        last_thread = r["thread_id"]
        out(f"sent question in {r['thread_id']}")
    elif line.startswith("say "):
        body = {"body": line[4:], "status": "working"}
        if last_thread:
            body["thread_id"] = last_thread
        else:
            body["thread_title"] = "Note"
        r = api("POST", "/api/agent/messages", body)
        last_thread = r["thread_id"]
        out(f"sent in {r['thread_id']}")
    elif line.startswith("title "):
        r = api("POST", "/api/agent/title", {"title": line[len("title "):]})
        out(f"titled {r['title']}")
    elif line == "args":
        out("args " + json.dumps(args))
    elif line == "env":
        out("env " + json.dumps({k: ("set" if v else "") for k, v in os.environ.items() if k.startswith("MINBOX_")}, sort_keys=True))
    elif line:
        out(f"echo: {line}")
    out("ready> ")
