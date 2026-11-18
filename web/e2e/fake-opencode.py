#!/usr/bin/env python3
"""A stand-in for `opencode` (2.x) in end-to-end tests, without a model or a real OpenCode.

minbox starts it as `python3 fake-opencode.py <opencode flags>`; its state (the sessions it
"created", the calls it got) lives in $FAKE_OPENCODE_DIR (the test's data directory).

  --version                                     prints "opencode v<FAKE_OPENCODE_VERSION or 2.1.4>"
  api --standalone session.get --param sessionID=<id>
  api --standalone session.create -d <json>     sessions are files in <data dir>/fake-opencode/
  --standalone --auto --session <id>            the TUI: checks the plugin minbox put in
                                                OPENCODE_CONFIG_CONTENT, then talks to minbox's agent API
                                                the way plugin/opencode/minbox.ts does, in mod protocol 1
                                                (hello with agent opencode and protocol, heartbeat, the
                                                tool set, tool calls, turn events, pending?proto=1 ->
                                                claim -> delivered) and echoes what it receives

Typed commands in the TUI (one per line):
  ask               send a message with a question block
  say <text>        send a plain message
  title <text>      set the session title
  work / idle       report working / idle (while working only urgent messages are taken)
  args              print the command line it was started with
  paths             whether the plugin folder is under $FAKE_EXPECT_ROOT (a remote host's data dir)
  env               print the MINBOX_* / OPENCODE_* variables it got
  tui <kb>          draw a screen on the alternate screen, then only what changes (kb KB of it), like
                    OpenCode's renderer (fake_tui.py)
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
            api("POST", "/api/agent/heartbeat", {"seq": seq, "agent": "opencode", "ext_version": "fake", "protocol": 1,
                                                  "state": "working" if busy else "idle", "last_poll_at": "", "last_delivery_at": "",
                                                  "info": {"opencode_version": "2.1.4"}, "events": []})
        except Exception:
            pass
        time.sleep(1)


def poll():
    global last_thread
    while True:
        try:
            # Mod protocol 1: each item carries the server's text to inject (p["text"]).
            pending = api("GET", f"/api/agent/pending?owner={owner}&wait=20&proto=1")["items"]
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
hello = api("POST", "/api/agent/hello", {"agent": "opencode", "agent_session_id": session_id, "ext_version": "fake", "protocol": 1})
ins = hello.get("instructions", "")
out(f"hello agent={hello.get('agent')} orchestration={'yes' if 'orchestration' in ins else 'no'} tools={'minbox_' if 'minbox_send_message' in ins else 'other'}")
out(f"subagents={'opencode' if 'subagents in OpenCode' in ins else 'other'}")
api("POST", "/api/agent/event", {"type": "turn.complete"})
tool_set = api("GET", "/api/agent/tools")
out(f"tool set {len(tool_set.get('tools', []))} tools, send={'yes' if any(t['name'] == 'minbox_send_message' for t in tool_set.get('tools', [])) else 'no'}")
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
        api("POST", "/api/agent/event", {"type": "turn.start" if busy else "turn.complete"})
        out(f"status {line}")
    elif line == "ask":
        r = api("POST", "/api/agent/tool", {"tool": "minbox_send_message", "args": {
            "thread_title": "Pick a database",
            "body": "I need a decision.\n\n:::question\nWhich database should we use?\n\n- [ ] SQLite — simplest\n- [ ] Postgres — needs a server\n\nRecommended: SQLite\n:::",
        }})
        out(f"sent question: {r.get('text') or r.get('error')}")
    elif line.startswith("say "):
        r = api("POST", "/api/agent/tool", {"tool": "minbox_send_message", "args": {"body": line[4:]}})
        out(f"sent: {r.get('text') or r.get('error')}")
    elif line.startswith("title "):
        r = api("POST", "/api/agent/tool", {"tool": "minbox_set_session_title", "args": {"title": line[len("title "):]}})
        out("titled " + (r.get("text") or "").removeprefix("Session title set: "))
    elif line == "args":
        out("args " + json.dumps(args))
    elif line == "paths":
        root = os.environ.get("FAKE_EXPECT_ROOT", "")
        cfg = json.loads(os.environ.get("OPENCODE_CONFIG_CONTENT", "{}"))
        out(f"paths under-root={'yes' if root and plugin.startswith(root) and has_entry else 'no'} keys={','.join(sorted(cfg))}")
    elif line == "env":
        out("env " + json.dumps({k: ("set" if v else "") for k, v in os.environ.items() if k.startswith("MINBOX_") or k.startswith("OPENCODE_")}, sort_keys=True))
    elif line.startswith("tui "):
        sys.dont_write_bytecode = True  # no __pycache__ in e2e/
        import fake_tui  # next to this file
        fake_tui.TUI(alt=True).run(int(line[4:]))
        continue
    elif line:
        out(f"echo: {line}")
    out("ready> ")
