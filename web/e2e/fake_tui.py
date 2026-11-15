"""A full-screen TUI that draws only what changes, for the fake agents (`tui <kb>`).

Like OpenCode (on the alternate screen) or Claude Code and Pi (on the main screen), it draws
its whole screen once, then only the cells that change (a spinner, kb kilobytes of it: more
than the terminal host keeps for a replay), and draws the whole screen again on a resize
(SIGWINCH). A view that attaches later sees the whole screen only if the app repaints for it.
"""
import os, signal, time

SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"


class TUI:
    def __init__(self, alt):
        self.alt = alt
        self.spun = False
        self.tick = 0

    def write(self, s):
        b = s.encode()
        while b:
            n = os.write(1, b)
            b = b[n:]

    def full(self, *_):
        cols, rows = os.get_terminal_size(1)
        s = "\x1b[?2026h\x1b[H\x1b[2J"
        s += f"\x1b[1;1H{SPIN[self.tick % len(SPIN)]} TUI-TOP {cols}x{rows}"
        if self.spun:
            s += "\x1b[2;1HSPUN"
        s += f"\x1b[{max(3, rows // 2)};1HTUI-MIDDLE"
        s += f"\x1b[{rows};1HTUI-BOTTOM"
        s += f"\x1b[{max(1, rows - 2)};1H\x1b[?2026l"  # the cursor above the bottom line: typing echoes there
        self.write(s)

    def run(self, kb):
        if self.alt:
            self.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h")
        self.full()
        signal.signal(signal.SIGWINCH, self.full)
        left = kb * 1024
        while left > 0:
            chunk = ""
            for _ in range(1000):
                self.tick += 1
                chunk += f"\x1b[?2026h\x1b7\x1b[1;1H{SPIN[self.tick % len(SPIN)]}\x1b8\x1b[?2026l"
            self.write(chunk)
            left -= len(chunk.encode())
            time.sleep(0.02)  # a pace a view keeps up with (a view that falls behind is dropped and attaches again)
        self.spun = True
        self.write("\x1b7\x1b[2;1HSPUN\x1b8")
