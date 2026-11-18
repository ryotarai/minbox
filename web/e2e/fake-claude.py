#!/usr/bin/env python3
"""A stand-in for `claude` in end-to-end tests: it talks to minbox's agent API
the way the minbox mod did before mod protocol 1 (hello, send_message, pending -> claim -> delivered),
and echoes what it receives to the terminal, without a real model. It deliberately stays on protocol 0
(the endpoints a session started with an older mod keeps calling): every suite that uses it checks that
old integrations keep working; fake-pi.py and fake-opencode.py speak protocol 1 (docs/mod-protocol.md).

Typed commands (one per line):
  ask        send a message with a question block
  say <text> send a plain message
  mark <status> [text]  set the typed task's status with update_task (working|needs_you|blocked|done),
             then send a plain message about it (send_message has no status: minbox refuses one)
  work       status working: queued messages wait (idle ends it)
  nobeat     stop the heartbeat (beat starts it again); the poll carries on
  tui <kb>   draw a screen, then only what changes (kb KB of it), on the main screen (fake_tui.py)
  agent off|on  stop / start answering the person's stream messages by itself (v3; on by default)
  exit       quit

v3 (docs/v3): a message the person writes in an agent's stream is answered by itself, deciding like
the prototype's fake agent (see decide()): written from a task -> a note in that task; names an open
task's keyword -> in that task (task_ids, the one-id legacy form a protocol-0 mod sends); asks for work -> create_task, then a reply; else a
quick exchange: a small task of its own, done (create_task status done), then a plain reply. Every
message belongs to exactly one task. "GOAL: <title>" + "- <criterion>" lines -> a goal with an autonomous run;
"ASK" -> a question; a goal's continuation -> progress, and on the second one the criteria are met.
minbox's request to place messages in tasks (kind "place") -> put them in the newest open task, else a
done "Quick questions" task. "IGNORE" -> a plain reply in no task, and the next two requests to place
it are ignored (the third is done).
"""
import json, os, re, sys, threading, time, urllib.error, urllib.request, uuid

token = os.environ["MINBOX_TOKEN"]
server_file = os.environ["MINBOX_SERVER_FILE"]
owner = uuid.uuid4().hex
args = sys.argv[1:]
session_id = args[args.index("--session-id") + 1] if "--session-id" in args else (args[args.index("--resume") + 1] if "--resume" in args else "none")
mode = "resume" if "--resume" in args else "new"
last_thread = None
busy = False  # "work": a turn is running; only urgent messages are taken
deaf = False  # "deaf": the mod stopped answering (no polling) until "listen"
beating = True  # "nobeat": the heartbeat stops until "beat"
beat_seq = 0
answering = os.environ.get("FAKE_AGENT", "1") != "0"  # "agent off": stream messages are not answered
continued = {}  # goal id -> continuations taken
ignore_left = 0  # requests to place messages still to ignore ("IGNORE")
PLACE_ID = re.compile(r"^- (msg_[0-9A-Za-z]+) \(", re.M)


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


def keep_tasks(p):
    """The Tasks board, as an agent keeps it with create_task / update_task: every line
    "TOPIC: <title> | <status> | <summary>" of a delivered message creates that task in the thread, or
    updates the one with that title. "TOPIC-DETAIL: <title> | <markdown>" is its detail (\\n in it is a
    new line); "TOPIC-TASK: <title> | [x] <text>" (or "[ ] ") one of its steps, a later line for the
    same text marking it again. A message whose text names a task's title is linked to it."""
    body = p.get("body") or ""
    lines = re.findall(r"^TOPIC: (.+?) \| (in_progress|waiting_on_you|done) \| (.*)$", body, re.M)
    details = {m[0].strip(): m[1].strip().replace("\\n", "\n") for m in re.findall(r"^TOPIC-DETAIL: (.+?) \| (.*)$", body, re.M)}
    steps = {}
    for title, box, text in re.findall(r"^TOPIC-TASK: (.+?) \| \[([ x])\] (.*)$", body, re.M):
        steps.setdefault(title.strip(), []).append({"text": text.strip(), "done": box == "x"})
    if "TOPIC" not in body:
        return
    have = {}
    res = api("GET", "/api/agent/tasks?all=1")
    for t in (res or {}).get("tasks") or []:
        have[t["title"]] = t
    named = set()
    for title, status, summary in lines:
        title = title.strip()
        named.add(title)
        fields = {"status": status, "summary": summary.strip(), "message_ids": [p["id"]]}
        if title in details:
            fields["detail"] = details[title]
        cur = have.get(title)
        if title in steps:
            merged = [dict(k) for k in (cur or {}).get("tasks") or []]
            for k in steps[title]:
                for m in merged:
                    if m["text"] == k["text"]:
                        m["done"] = k["done"]
                        break
                else:
                    merged.append(k)
            fields["steps"] = merged
        if cur:
            api("PATCH", "/api/agent/tasks/" + cur["id"], fields)
        else:
            fields.update({"title": title})
            api("POST", "/api/agent/tasks", fields)
    for title, t in have.items():
        if title not in named and title in body:
            api("PATCH", "/api/agent/tasks/" + t["id"], {"message_ids": [p["id"]]})


WORK = re.compile(r"\b(fix|add|implement|make|build|write|update|remove|refactor|investigate|create|change|bump|migrate|rename|delete|support)\b|作って|直して|追加|修正|実装|調べて", re.I)
STOP = set("this that with from have please also make into about when them they their should could would there some test tests page look sure just still again what which where will your more than then here been does done need want like only very much thanks thank".split())


def words(text):
    return {w.strip(".-#") for w in re.findall(r"[#a-z0-9][a-z0-9.\-]*", text.lower())}


def title_from(text):
    s = re.sub(r"^(please|could you|can you|pls)\s+", "", text.split("\n")[0], flags=re.I).rstrip(".?!。").strip()
    s = s[:1].upper() + s[1:]
    return s[:64]


def say(body, task_ids=None, **extra):
    m = {"body": body, **extra}
    if task_ids:
        m["task_ids"] = task_ids
    r = api("POST", "/api/agent/messages", m)
    out(f"replied {r.get('decision', '')} {r.get('task_ids')}")
    return r


TYPED_TASK = None


def typed_task():
    """The task what is typed in the terminal (say / burst) is about: every message belongs to one."""
    global TYPED_TASK
    if not TYPED_TASK:
        TYPED_TASK = api("POST", "/api/agent/tasks", {"title": "Typed in the terminal"})["task_id"]
    return [TYPED_TASK]


def decide(p):
    """The fake agent's turn for a stream message of the person (the prototype's rules)."""
    body = (p.get("body") or "").strip()
    api("POST", "/api/agent/status", {"status": "working"})
    try:
        turn(p, body)
    finally:
        time.sleep(0.2)
        api("POST", "/api/agent/status", {"status": "idle"})


def place(body):
    global ignore_left
    if ignore_left > 0:
        ignore_left -= 1
        out("ignored the request to place messages")
        return
    ids = PLACE_ID.findall(body)
    tasks = [t for t in (api("GET", "/api/agent/tasks").get("tasks") or []) if t["status"] != "done"]
    if tasks:
        api("PATCH", "/api/agent/tasks/" + tasks[0]["id"], {"message_ids": ids})
    else:
        api("POST", "/api/agent/tasks", {"title": "Quick questions", "status": "done", "message_ids": ids})
    out(f"placed {len(ids)} message(s)")


def turn(p, body):
    global ignore_left
    if p.get("kind") == "place":
        place(body)
        return
    if p.get("kind") == "continue":
        gid = re.search(r"Goal (tsk_[0-9a-f]+)", body).group(1)
        continued[gid] = continued.get(gid, 0) + 1
        if continued[gid] >= 2:
            g = api("GET", "/api/agent/tasks?all=1")
            crit = next((t.get("criteria") or [] for t in g.get("tasks") or [] if t["id"] == gid), [])
            api("PATCH", "/api/agent/tasks/" + gid, {"check_criteria": list(range(1, len(crit) + 1))})
            say("All criteria are met; the goal is done.", [gid])
        else:
            say(f"Goal progress: step {continued[gid]} done.", [gid])
        return
    if body.startswith("## Answers") or "Answers to your questions" in body:
        say("Thanks, carrying on with that.")
        return
    tasks = [t for t in (api("GET", "/api/agent/tasks?all=1").get("tasks") or []) if t["status"] != "done"]
    if body.startswith("GOAL:"):
        lines = body.split("\n")
        crit = [{"text": l[2:].strip()} for l in lines[1:] if l.startswith("- ")]
        g = api("POST", "/api/agent/tasks", {"title": lines[0][5:].replace("(manual)", "").strip(), "kind": "goal", "criteria": crit, "autonomous": "(manual)" not in lines[0]})
        say(f"Goal set: {g['task']['title']}. I will keep going until it is met.")
        return
    if "NEEDYOU" in body:
        # update_task with only a status: the task waits on the person, with no question asked.
        named = [t["id"] for t in tasks if any(w in words(body) for w in words(t["title"]) if len(w) >= 4 and w not in STOP)]
        api("PATCH", "/api/agent/tasks/" + named[0], {"status": "needs_you"})
        say("I need you to look at the gauge before I go on.", named[:1])
        return
    if "TODOS" in body:
        # Only things for the person to do (no question): the Board's ask is the first one, +n.
        named = [t["id"] for t in tasks if any(w in words(body) for w in words(t["title"]) if len(w) >= 4 and w not in STOP)]
        say("Two things for you.\n\n:::actions\n- [ ] Restart the staging box\n- [ ] Rotate the API key\n:::", named[:1])
        return
    if "ASK" in body:
        named = [t["id"] for t in tasks if any(w in words(body) for w in words(t["title"]) if len(w) >= 4 and w not in STOP)]
        say("One decision first.\n\n:::question\nWhich region should it deploy to?\n- [ ] Tokyo\n- [ ] Oregon\nRecommended: Tokyo\n:::", named[:1])
        return
    if p.get("tasks"):
        t0 = p["tasks"][0]
        say(f"Noted for “{t0['title']}”.")
        return
    ws = words(body)
    hits = []
    for t in tasks:
        kws = {w for w in words(t["title"]) if len(w) >= 4 and w not in STOP}
        n = len(kws & ws)
        if n:
            hits.append((n, t))
    if hits:
        hits.sort(key=lambda x: -x[0])
        t = hits[0][1]
        say(f"Got it, adding this to “{t['title']}”.", [t["id"]])
        return
    if WORK.search(body) or len(body) > 90:
        title = title_from(body)
        api("POST", "/api/agent/tasks", {"title": title, "steps": [{"text": "Look into it"}, {"text": "Make the change"}, {"text": "Test it"}, {"text": "Open a PR"}]})
        say(f"On it. I created a task for this (“{title}”) and will report progress there.")
        return
    if "IGNORE" in body:
        ignore_left = 2
        say("Sure — noted.")
        return
    api("POST", "/api/agent/tasks", {"title": title_from(body), "status": "done"})
    say("Sure — noted.")


def poll():
    global last_thread
    while True:
        try:
            if deaf:
                time.sleep(0.3)
                continue
            pending = api("GET", f"/api/agent/pending?owner={owner}&wait=20")
            for p in pending:
                if deaf or (busy and not p.get("urgent")):
                    continue
                if api("POST", f"/api/agent/pending/{p['id']}/claim?owner={owner}")["claimed"]:
                    last_thread = p["thread_id"]
                    out(f"<<< inbox [{p['subject']}] {p['body']}")
                    api("POST", f"/api/agent/pending/{p['id']}/delivered?owner={owner}")
                    try:
                        keep_tasks(p)
                    except Exception as e:
                        out(f"tasks: {e}")
                    if answering and p.get("stream"):
                        try:
                            decide(p)
                        except Exception as e:
                            out(f"decide: {e}")
        except Exception as e:  # server restarting
            time.sleep(1)


def heartbeat_loop():
    global beat_seq
    every = float(os.environ.get("FAKE_HEARTBEAT_S", "1"))
    while True:
        time.sleep(every)
        if not beating:
            continue
        try:
            beat_seq += 1
            api("POST", "/api/agent/heartbeat", {
                "seq": beat_seq, "agent": "claude", "ext_version": "fake-1", "state": "working" if busy else "idle",
                "last_poll_at": "", "last_delivery_at": "",
                "info": {"deaf": deaf},
                "events": [{"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "kind": "fake", "msg": "fake mod heartbeat"}],
            }, timeout=5)
        except Exception:
            pass


out(f"fake-claude {mode} session={session_id} cwd={os.getcwd()}")
api("POST", "/api/agent/hello", {"claude_session_id": session_id})
api("POST", "/api/agent/status", {"status": "idle"})
threading.Thread(target=poll, daemon=True).start()
threading.Thread(target=heartbeat_loop, daemon=True).start()
out("ready> ")

for raw in sys.stdin:  # the PTY is in cooked mode: it echoes and gives lines
    line = raw.strip()
    if line == "exit":
        out("bye")
        sys.exit(0)
    elif line in ("nobeat", "beat"):
        beating = line == "beat"
        out(f"status {line}")
    elif line in ("deaf", "listen"):
        deaf = line == "deaf"
        out(f"status {line}")
    elif line in ("agent off", "agent on"):
        answering = line == "agent on"
        out(f"status {line}")
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
    elif line == "ask region":
        # A second question in the last thread: it moves the thread on past the earlier one.
        r = api("POST", "/api/agent/messages", {
            "thread_id": last_thread,
            "body": "One more while you decide.\n\n:::question\nWhich region?\n- [ ] Tokyo\n- [ ] Oregon\n:::",
        })
        out(f"sent region in {r['thread_id']}")
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
    elif line.startswith("send "):
        # send <file.json>: post that JSON as an agent message (used by the README screenshots)
        with open(line[5:]) as f:
            spec = json.load(f)
        if last_thread and "subject" not in spec and "thread_id" not in spec:
            spec["thread_id"] = last_thread
        r = api("POST", "/api/agent/messages", spec)
        last_thread = r["thread_id"]
        out(f"sent in {r['thread_id']}")
    elif line.startswith("transcript "):
        # transcript <file>: clear the screen and print a canned Claude Code-like transcript
        with open(line[11:]) as f:
            text = f.read()
        sys.stdout.write("\x1b[2J\x1b[H")
        out(text)
        continue
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
    elif line.startswith("retitle "):
        r = api("POST", "/api/agent/messages", {"body": "The topic moved on.", "thread_id": last_thread, "thread_title": line[8:]})
        out(f"retitled {r['thread_id']}")
    elif line.startswith("mark "):
        # mark <status> [text]: the typed task's status (update_task), then a message about it
        status, _, text = line[5:].partition(" ")
        task = typed_task()[0]
        api("PATCH", "/api/agent/tasks/" + task, {"status": status})
        r = api("POST", "/api/agent/messages", {"body": text or f"Marked {status}", "task_id": task})
        last_thread = r["thread_id"]
        out(f"marked {task}")
    elif line.startswith("burst "):
        _, count, text = line.split(" ", 2)
        for i in range(int(count)):
            body = {"body": " ".join([f"{text} #{i}"] * 10), "task_ids": typed_task()}  # ten repeats: tall messages
            if last_thread:
                body["thread_id"] = last_thread
            else:
                body["subject"] = "Burst"
            r = api("POST", "/api/agent/messages", body)
            last_thread = r["thread_id"]
        out(f"sent in {r['thread_id']}")
    elif line.startswith("say "):
        body = {"body": line[4:].replace("\\n", "\n"), "task_ids": typed_task()}  # a literal \n types a line break
        if last_thread:
            body["thread_id"] = last_thread
        else:
            body["subject"] = "Note"
        r = api("POST", "/api/agent/messages", body)
        last_thread = r["thread_id"]
        out(f"sent in {r['thread_id']}")
    elif line.startswith("denied "):
        # denied <command>: what the mod reports when a Bash call was denied (in the last thread's turn)
        body = {"command": line[len("denied "):], "reason": "The user doesn't want to proceed with this tool use."}
        if last_thread:
            body["thread_id"] = last_thread
        r = api("POST", "/api/agent/denied-commands", body)
        out(f"denied reported {r.get('thread_id', r)}")
    elif line.startswith("ran "):
        # ran <command>: the mod's report that a command denied earlier ran
        r = api("POST", "/api/agent/denied-commands/ran", {"command": line[len("ran "):]})
        out(f"ran reported cleared={r.get('cleared')}")
    elif line.startswith("tui "):
        sys.dont_write_bytecode = True  # no __pycache__ in e2e/
        import fake_tui  # next to this file
        fake_tui.TUI(alt=False).run(int(line[4:]))
        continue
    elif line:
        out(f"echo: {line}")
    out("ready> ")
