#!/usr/bin/env python3
"""A stand-in for `opencode` (2.x) in end-to-end tests, without a model or a real OpenCode.

minbox starts it as `python3 fake-opencode.py <opencode flags>`; its state (the sessions it
"created", the calls it got) lives in $FAKE_OPENCODE_DIR (the test's data directory).

  --version                                     prints "opencode v<FAKE_OPENCODE_VERSION or 2.1.4>"
  api --standalone session.get --param sessionID=<id>
  api --standalone session.create -d <json>     sessions are files in <data dir>/fake-opencode/
  --standalone --auto --session <id>            the TUI: checks the plugin minbox put in
                                                OPENCODE_CONFIG_CONTENT, then talks to minbox's agent API
                                                the way plugin/opencode/minbox.ts does (hello with
                                                agent opencode, heartbeat, status, pending -> claim ->
                                                delivered) and echoes what it receives

Typed commands in the TUI (one per line):
  ask               send a message with a question block
  say <text>        send a plain message
  title <text>      set the session title
  work / idle       report working / idle (while working only urgent messages are taken)
  args              print the command line it was started with
  env               print the MINBOX_* / OPENCODE_* variables it got
  exit              quit
"""
import json, os, sys, threading, time, urllib.error, urllib.request, uuid

args = sys.argv[1:]
state = os.path.join(os.environ.get("FAKE_OPENCODE_DIR") or "/tmp", "fake-opencode")
os.makedirs(state, exist_ok=True)

if "--version" in args:
    print("opencode v" + os.environ.get("FAKE_OPENCODE_VERSION", "2.1.4"))
    sys.exit(0)

with open(os.path.join(state, "calls"), "a") as f:
    f.write(json.dumps(args) + "\n")

if args[:1] == ["api"]:
    op = args[2] if len(args) > 2 else ""
    if op == "session.get":
        sid = args[args.index("--param") + 1].split("=", 1)[1]
        p = os.path.join(state, sid)
        if os.path.exists(p):
            print(json.dumps({"data": {"id": sid, "location": {"directory": open(p).read()}}}))
            sys.exit(0)
        print(json.dumps({"_tag": "SessionNotFoundError", "sessionID": sid}))
        print("HTTP 404 Not Found", file=sys.stderr)
        sys.exit(1)
    if op == "session.create":
        body = json.loads(args[args.index("-d") + 1])
        with open(os.path.join(state, body["id"]), "w") as f:
            f.write(body["location"]["directory"])
        print(json.dumps({"data": {"id": body["id"]}}))
        sys.exit(0)
    sys.exit(2)

# ---- the TUI ----
token = os.environ["MINBOX_TOKEN"]
server_file = os.environ["MINBOX_SERVER_FILE"]
owner = uuid.uuid4().hex
session_id = args[args.index("--session") + 1] if "--session" in args else "none"
last_thread = None
busy = False
seq = 0


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


def beat():
    global seq
    while True:
        seq += 1
        try:
            api("POST", "/api/agent/heartbeat", {"seq": seq, "agent": "opencode", "ext_version": "fake",
                                                  "state": "working" if busy else "idle", "last_poll_at": "", "last_delivery_at": "",
                                                  "info": {"opencode_version": "2.1.4"}, "events": []})
        except Exception:
            pass
        time.sleep(1)


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
                    out(f"<<< inbox [{p['subject']}] {p['body']}" + (" (steered)" if busy else ""))
                    api("POST", f"/api/agent/pending/{p['id']}/delivered?owner={owner}")
        except Exception:  # server restarting
            time.sleep(1)


plugin = ""
try:
    plugins = json.loads(os.environ.get("OPENCODE_CONFIG_CONTENT", "{}")).get("plugins", [])
    plugin = plugins[-1]["package"] if plugins else ""
except Exception:
    pass
has_entry = os.path.exists(os.path.join(plugin, "index.ts")) if plugin else False
existed = os.path.exists(os.path.join(state, session_id))
out(f"fake-opencode session={session_id} exists={'yes' if existed else 'no'} cwd={os.getcwd()} plugin={'index.ts' if has_entry else 'missing'}")
hello = api("POST", "/api/agent/hello", {"agent": "opencode", "agent_session_id": session_id, "ext_version": "fake"})
ins = hello.get("instructions", "")
out(f"hello agent={hello.get('agent')} orchestration={'yes' if 'orchestration' in ins else 'no'} tools={'minbox_' if 'minbox_send_message' in ins else 'other'}")
out(f"subagents={'opencode' if 'subagents in OpenCode' in ins else 'other'}")
api("POST", "/api/agent/status", {"status": "idle"})
threading.Thread(target=poll, daemon=True).start()
threading.Thread(target=beat, daemon=True).start()
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
        out("env " + json.dumps({k: ("set" if v else "") for k, v in os.environ.items() if k.startswith("MINBOX_") or k.startswith("OPENCODE_")}, sort_keys=True))
    elif line:
        out(f"echo: {line}")
    out("ready> ")
