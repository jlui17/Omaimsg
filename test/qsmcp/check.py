#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from quickshell_mcp import server as srv
from quickshell_mcp.examples.driver import CheckError, Driver

HERE = Path(__file__).resolve().parent
GLYPH = "\U000f0361"
# The daemon serves a page this size and caches exactly that tail, so a thread
# longer than it can only arrive in more than one page.
PAGE = json.loads((HERE / "daemon-config.json").read_text())["cache"]["messagesPerThread"]


def find(pred: str, root: str = "win(0)") -> str:
    # The bar's object graph has no stable indices, so every node is addressed
    # by what it is. dev._children is the probe's own walker.
    return (
        "(function(){var f=null,seen=[];"
        "(function rec(o,d){ if(!o||f||d>18||seen.indexOf(o)>=0) return; seen.push(o);"
        f" try{{ if({pred}) {{ f=o; return; }} }}catch(e){{}}"
        " var k=dev._children(o); for(var i=0;i<k.length;i++) rec(k[i],d+1); })"
        f"({root},0); return f; }})()"
    )


# The staged bar holds two installs of this plugin under different ids, so every
# finder is scoped to the one it belongs to. Unrooted, "the first node with a
# composer" would answer for whichever widget the walk happened to reach first.
CANONICAL_ID, VARIANT_ID = (e["id"] for e in json.loads((HERE / "shell.json").read_text())["bar"]["layout"]["right"])
BAR = find(f"o.moduleName==={CANONICAL_ID!r} && String(o).indexOf('BarWidget')>=0")
PANEL = find(f"o.moduleName==={CANONICAL_ID!r} && String(o).indexOf('Panel')>=0")
VARIANT_BAR = find(f"o.moduleName==={VARIANT_ID!r} && String(o).indexOf('BarWidget')>=0")
CLIENT = find("o.socketPath!==undefined", root=BAR)
VARIANT_CLIENT = find("o.socketPath!==undefined", root=VARIANT_BAR)
BUTTON = find("o.tooltipText!==undefined", root=BAR)
VARIANT_BUTTON = find("o.tooltipText!==undefined", root=VARIANT_BAR)
VARIANT_PANEL = find(f"o.moduleName==={VARIANT_ID!r} && String(o).indexOf('Panel')>=0")
COMPOSER = find("String(o.placeholderText||'').indexOf('Message')===0", root=PANEL)


def keys(*args: str) -> None:
    # wtype's virtual keyboard dies with the process, and sway drops every event
    # it delivers before the keymap settles. The sleeps hold the keyboard open
    # either side of the keystroke; without them nothing arrives at all.
    h = srv.HARNESS
    env = dict(os.environ, WAYLAND_DISPLAY=h._wl, XDG_RUNTIME_DIR=str(h._xdg))
    subprocess.run(["wtype", "-s", "300", *args, "-s", "300"], env=env, check=True)


def ipc(*args: str) -> str:
    # Through the real IpcHandler, the way a notification's click action reaches
    # it. The function name declared in BarWidget.qml is the only thing joining
    # the daemon's --exec argv to the panel; calling the QML function behind the
    # handler instead would leave a rename to break silently.
    h = srv.HARNESS
    done = subprocess.run(
        h._ipc_argv("call", "--", *args),
        env=h._launch_env, capture_output=True, text=True, timeout=15, check=False,
    )
    return f"exit={done.returncode} {done.stdout.strip()} {done.stderr.strip()}".strip()


def q(node: str, body: str) -> str:
    return f"(function(){{var x={node}; if(!x) return null; {body} }})()"


def wait_stable(d: Driver, expr: str, settle: float = 2.0, timeout: float = 25.0):
    deadline = time.time() + timeout
    last, unchanged_since = None, time.time()
    while time.time() < deadline:
        now = d.eval(expr)
        if now != last:
            last, unchanged_since = now, time.time()
        elif time.time() - unchanged_since >= settle:
            return last
        time.sleep(0.25)
    return last


def wait_for(d: Driver, expr: str, ok, timeout: float = 20.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = d.eval(expr)
        if ok(last):
            return last
        time.sleep(0.25)
    return last


def run(d: Driver) -> None:
    d.section("identity")
    # Both widgets run the same QML off the same disk; only their manifests
    # differ. A hardcoded id would make these two answers identical.
    d.eq("the widget takes its id from its manifest", d.eval(q(BAR, "return x.pluginId;")), CANONICAL_ID)
    d.eq("a second install under another id is its own widget", d.eval(q(VARIANT_BAR, "return x.pluginId;")), VARIANT_ID)
    # The host overwrites moduleName from the bar entry after load, so nothing
    # but this pins it against the id the widget read for itself.
    for name, node in (("the install", BAR), ("the second install", VARIANT_BAR)):
        d.check(f"{name} answers to one id", d.eval(q(node, "return x.pluginId===x.moduleName;")) is True)
    sockets = [
        d.eval(q(CLIENT, "return x.socketPath;")),
        d.eval(q(VARIANT_CLIENT, "return x.socketPath;")),
    ]
    d.check(
        "each install names its own daemon socket",
        sockets[0].endswith(f"/{CANONICAL_ID}.sock") and sockets[1].endswith(f"/{VARIANT_ID}.sock"),
    )

    # Both installs carry a build stamp; only the one flagged a variant says so.
    # Without that the canonical install would announce a branch and sha to
    # someone who just installed it from the marketplace.
    # Unread is pinned first: the seeded server gives the canonical install a
    # count, and this is asking what the label holds besides one.
    d.eval(q(CLIENT, "x.unread=0; return x.unread;"))
    d.eq(
        "the install you use renders no id beside the glyph",
        d.eval(q(BUTTON, "return x.text;")),
        GLYPH,
    )
    d.eq("the install you use shows no build line", d.eval(q(BAR, "return x.buildLine;")), "")
    d.eq(
        "a variant names itself in the bar",
        d.eval(q(VARIANT_BUTTON, "return x.text;")),
        f"{GLYPH} {VARIANT_ID}",
    )
    d.eq(
        "a variant's panel names its build",
        d.eval(q(VARIANT_PANEL, "return x.buildLine;")),
        f"{VARIANT_ID} · stage-branch @ abc1234",
    )

    d.section("wiring")
    conn = wait_for(d, q(CLIENT, "return x.connection;"), lambda v: v == "connected")
    d.eq("client reaches the daemon", conn, "connected")

    d.section("unread badge")
    # The badge string is built in BarWidget.qml, so the count is set on the
    # client and read back off the rendered button.
    def badge(n: int):
        d.eval(q(CLIENT, f"x.unread={n}; return x.unread;"))
        return d.eval(q(BUTTON, "return [x.text, x.active, x.tooltipText];"))

    text, active, tip = badge(0)
    d.eq("no unread shows the bare glyph", text, GLYPH)
    d.eq("no unread leaves the button inactive", active, False)
    d.eq("no unread tooltip", tip, "Omaimsg")

    text, active, tip = badge(3)
    d.eq("unread renders beside the glyph", text, f"{GLYPH} 3")
    d.eval(q(VARIANT_CLIENT, "x.unread=3; return x.unread;"))
    d.eq(
        "a variant keeps its id when a count arrives",
        d.eval(q(VARIANT_BUTTON, "return x.text;")),
        f"{GLYPH} {VARIANT_ID} · 3",
    )
    d.eval(q(VARIANT_CLIENT, "x.unread=0; return x.unread;"))
    d.eq("unread marks the button active", active, True)
    # The badge counts conversations, not messages, so the tooltip says which:
    # a chat's own badge holds its message count and the two do not sum.
    d.eq("unread tooltip counts conversations", tip, "Omaimsg · 3 unread conversations")

    _, _, tip = badge(1)
    d.eq("one unread conversation is singular", tip, "Omaimsg · 1 unread conversation")

    text, _, _ = badge(150)
    d.eq("a count over 99 clamps", text, f"{GLYPH} 99+")

    d.section("chat list")
    d.eval(q(BAR, "x.open(); return x.opened;"))
    d.check("panel opens", d.eval(q(BAR, "return x.opened;")) is True)

    guids = wait_for(
        d,
        q(PANEL, "return (x.visibleChats||[]).map(function(c){return c.guid;});"),
        lambda v: bool(v),
    )
    d.check("the panel lists chats", bool(guids))

    # The daemon sorts the chat list itself and never trusts BlueBubbles'
    # ranking, so the order it sends is the order that must reach the screen.
    served = d.eval(q(CLIENT, "return (x.chats||[]).map(function(c){return c.guid;});"))
    d.eq("the rendered order is the daemon's order", guids, served)

    empty = d.eval(
        q(PANEL, "var out=[],seen=[];"
                 "(function rec(o,dd){ if(!o||dd>18||seen.indexOf(o)>=0) return; seen.push(o);"
                 " try{ if(typeof o.text==='string'&&o.text&&o.visible!==false) out.push(o.text); }catch(e){}"
                 " var k=dev._children(o); for(var i=0;i<k.length;i++) rec(k[i],dd+1); })(x,0);"
                 " return out.indexOf('No conversations yet.')>=0;")
    )
    d.eq("the empty state is not showing", empty, False)

    d.section("pinning")
    target = guids[2]
    d.eval(q(CLIENT, f"x.setPinned({target!r}, true); return true;"))
    pinned = wait_for(
        d,
        q(PANEL, "return (x.visibleChats||[]).map(function(c){return c.guid;});"),
        lambda v: bool(v) and v[0] == target,
    )
    d.eq("a pinned chat renders first", pinned[0], target)

    d.eval(q(CLIENT, f"x.setPinned({target!r}, false); return true;"))
    restored = wait_for(
        d,
        q(PANEL, "return (x.visibleChats||[]).map(function(c){return c.guid;});"),
        lambda v: bool(v) and v[0] != target,
    )
    d.eq("unpinning restores the recency order", restored, served)

    d.section("keyboard navigation")
    state = q(PANEL, "return [x.focusSection, x.cursorIndex, x.view];")
    d.eq("the chat list starts focused at the top", d.eval(state), ["chats", 0, "chats"])

    keys("j")
    d.eq("j walks down the chat list", d.eval(state)[1], 1)
    keys("j")
    d.eq("j keeps walking", d.eval(state)[1], 2)
    keys("k")
    d.eq("k walks back up", d.eval(state)[1], 1)

    keys("l")
    view = wait_for(d, state, lambda v: v[2] == "thread")
    d.eq("l opens the chat under the cursor", view[2], "thread")
    d.eq("the opened thread is the one at the cursor", d.eval(q(PANEL, "return x.activeGuid;")), served[1])

    d.section("composer")
    keys("i")
    focused = wait_for(d, state, lambda v: v[0] == "composer")
    d.eq("i focuses the composer", focused[0], "composer")

    sent = "typed by the harness"
    keys(sent)
    typed = wait_for(d, q(COMPOSER, "return x.text;"), lambda v: v == sent)
    d.eq("typing lands in the composer", typed, sent)

    keys("-k", "Return")
    landed = wait_for(
        d,
        q(PANEL, "return (x.messages||[]).map(function(m){return m.text;});"),
        lambda v: isinstance(v, list) and sent in v,
    )
    d.check("Enter sends the message into the thread", sent in (landed or []))
    d.eq("sending clears the composer", d.eval(q(COMPOSER, "return x.text;")), "")

    d.section("thread paging")
    keys("-k", "Escape")  # composer -> messages
    keys("-k", "Escape")  # thread -> chat list
    wait_for(d, state, lambda v: v[2] == "chats")
    keys("j")
    keys("l")
    wait_for(d, state, lambda v: v[2] == "thread")

    rows = wait_stable(
        d, q(PANEL, "return (x.messages||[]).map(function(m){return [m.guid, m.ts];});")
    )
    d.check("the thread settles with messages", bool(rows))
    d.check(
        f"reaching the oldest end pages past the first {PAGE}",
        len(rows) > PAGE,
    )

    stamps = [ts for _, ts in rows]
    d.eq("pages join in timestamp order", stamps, sorted(stamps))
    d.eq("no message is appended twice", len(rows), len({guid for guid, _ in rows}))

    # The panel stops asking once the view has enough to scroll, so the end of
    # the thread is only reached by draining it. The daemon's cut is inclusive,
    # which is what makes the duplicate check below worth pinning.
    guid = d.eval(q(PANEL, "return x.activeGuid;"))
    exhausted_q = q(CLIENT, f"return x.exhaustedThreads[{guid!r}]===true;")
    for _ in range(12):
        if d.eval(exhausted_q):
            break
        d.eval(q(CLIENT, "x.loadOlderMessages(); return true;"))
        time.sleep(0.6)
    d.eq("draining the thread ends in an exhausted page", d.eval(exhausted_q), True)

    drained = d.eval(q(PANEL, "return (x.messages||[]).map(function(m){return m.guid;});"))
    d.eq("the inclusive cut never duplicates a message", len(drained), len(set(drained)))
    d.check("draining only ever adds", len(drained) >= len(rows))

    d.section("notification click target")
    # What a daemon notification's --exec reaches: the bar widget's openChat IPC
    # function, called here directly since qs ipc only forwards to it. The guid
    # is a chat other than the open one, and the panel starts closed, so neither
    # answer can be left over from the paging walk above.
    click_target = next(g for g in served if g != d.eval(q(PANEL, "return x.activeGuid;")))
    d.eval(q(BAR, "x.close(); return true;"))
    wait_for(d, q(BAR, "return x.opened;"), lambda v: v is False)
    reply = ipc(CANONICAL_ID, "openChat", click_target)
    d.check(
        f"the widget answers an openChat IPC call under its own id ({reply})",
        reply.startswith("exit=0") and "not found" not in reply.lower() and "arguments" not in reply.lower(),
    )
    landed = wait_for(
        d,
        q(PANEL, "return [x.opened, x.activeGuid];"),
        lambda v: isinstance(v, list) and v[1] == click_target,
    )
    d.eq("openChat opens the panel", landed[0], True)
    d.eq("openChat opens the conversation it was given", landed[1], click_target)

    # Showing the panel flips `opened` synchronously, and onOpenedChanged marks
    # whatever thread is still active read. A click that showed the panel before
    # choosing its thread would clear the unread of the chat the reader last had
    # open, which they never saw. markRead mirrors that locally, so the client's
    # own copy is the witness.
    stale = d.eval(q(PANEL, "return x.activeGuid;"))
    d.eval(q(BAR, "x.close(); return true;"))
    wait_for(d, q(BAR, "return x.opened;"), lambda v: v is False)
    d.eval(q(CLIENT, f"""
        var list = (x.chats||[]).slice();
        for (var i=0;i<list.length;i++) if (list[i].guid==={stale!r})
          list[i] = Object.assign({{}}, list[i], {{unread: 4}});
        x.setChats(list); return true;"""))
    other = next(g for g in served if g != stale)
    ipc(CANONICAL_ID, "openChat", other)
    wait_for(d, q(PANEL, "return x.activeGuid;"), lambda v: v == other)
    kept = d.eval(q(CLIENT, f"""
        var list = x.chats||[];
        for (var i=0;i<list.length;i++) if (list[i].guid==={stale!r}) return list[i].unread;
        return null;"""))
    d.eq("opening one chat from a toast leaves the last one's unread alone", kept, 4)

    # A toast outlives a shell restart, so a click can land before the first
    # `chats` frame does. The guid is held and spent on the next one.
    saved = d.eval(q(CLIENT, "return JSON.stringify(x.chats||[]);"))
    d.eval(q(BAR, "x.close(); return true;"))
    d.eval(q(CLIENT, "x.setChats([]); return true;"))
    ipc(CANONICAL_ID, "openChat", stale)
    d.eq(
        "a click with no chat list yet is held, not dropped",
        d.eval(q(PANEL, "return x.openFollowGuid;")),
        stale,
    )
    d.eval(q(CLIENT, f"x.setChats(JSON.parse({saved!r})); return true;"))
    arrived = wait_for(d, q(PANEL, "return x.activeGuid;"), lambda v: v == stale)
    d.eq("the held click is spent on the next chat list", arrived, stale)

    d.section("sending an image")
    # The picker's own sequence, which no other send takes: the panel steps
    # aside for the file dialog, then reopens and sends. Reopening re-requests
    # the thread, and a `messages` frame REPLACES it -- so an optimistic row
    # appended in that same tick is wiped before its ack can reach it, and the
    # ack then has no row to mark failed. A picked file that is not there is the
    # deterministic way to see that: the daemon always refuses it.
    missing = f"file://{Path(tempfile.gettempdir()) / 'omaimsg-ui-not-there.png'}"
    d.eval(q(PANEL, "x.close(); return true;"))
    wait_for(d, q(PANEL, "return x.opened;"), lambda v: v is False)
    d.eval(q(PANEL, f"x.open(); x.sendPickedImages([{missing!r}]); return true;"))
    failed = wait_for(
        d,
        q(CLIENT, "return (x.activeMessages||[]).filter(function(m){return m.failed===true;}).length;"),
        lambda v: isinstance(v, int) and v >= 1,
    )
    d.check(
        "a send that fails while the panel reopens still draws its failed row",
        isinstance(failed, int) and failed >= 1,
    )


def main() -> int:
    d = Driver(HERE / "profile.json").boot()
    try:
        run(d)
        return d.report("omaimsg-ui")
    except CheckError as e:
        print(f"  ABORT {e}")
        return d.report("omaimsg-ui") or 1
    finally:
        d.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
