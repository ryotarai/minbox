package termhost

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// modes follows the terminal modes a full-screen app sets once, at its start, and then
// relies on: the alternate screen, mouse reporting, bracketed paste, focus events, the
// cursor keys and the kitty keyboard flags. The replay a newly attached view gets is only
// the last scrollbackLimit bytes of output; once its start is cut off, the sequences that
// set these modes are gone with it, and the view would draw the app on its main screen,
// send no mouse events, or encode keys the app does not expect. The host puts them back
// around a cut replay (replayPrefix, replaySuffix).
type modes struct {
	dec   map[int]bool // the tracked DEC private modes seen, set (true) or reset (false)
	alt   bool         // on the alternate screen
	altNo int          // the mode that entered it (1049, 1047 or 47)
	altAt int64        // the stream offset of the sequence that entered it
	kitty []int        // the kitty keyboard flags stack, top last

	pos    int64 // bytes seen so far
	st     int   // parser state: ground, esc, csi
	seqAt  int64 // the stream offset of the sequence being parsed
	prefix byte  // a CSI's private marker (? < = >)
	params []byte
	bad    bool // the CSI has intermediates or overlong params: ignore it
}

const (
	stGround = iota
	stEsc
	stCSI
)

// trackedDEC are the DEC private modes put back after a cut replay (the alternate screen
// is handled apart: it must come before the replay, not after it).
var trackedDEC = map[int]bool{
	1:    true, // application cursor keys
	25:   true, // cursor visible
	1000: true, // mouse: press and release
	1002: true, // mouse: drag
	1003: true, // mouse: any motion
	1004: true, // focus in and out
	1005: true, // mouse: UTF-8 coordinates
	1006: true, // mouse: SGR coordinates
	1015: true, // mouse: urxvt coordinates
	2004: true, // bracketed paste
}

func newModes() *modes { return &modes{dec: map[int]bool{}, altAt: -1} }

// feed parses output for the mode sequences.
func (m *modes) feed(b []byte) {
	for _, c := range b {
		switch m.st {
		case stGround:
			if c == 0x1b {
				m.st, m.seqAt = stEsc, m.pos
			}
		case stEsc:
			switch c {
			case '[':
				m.st, m.prefix, m.params, m.bad = stCSI, 0, m.params[:0], false
			case 'c': // RIS: every mode back to its default
				m.reset()
				m.st = stGround
			case 0x1b:
				m.seqAt = m.pos
			default:
				m.st = stGround
			}
		case stCSI:
			switch {
			case c == 0x1b:
				m.st, m.seqAt = stEsc, m.pos
			case c == 0x18 || c == 0x1a: // CAN, SUB: the sequence is cancelled
				m.st = stGround
			case c >= '<' && c <= '?' && len(m.params) == 0 && m.prefix == 0:
				m.prefix = c
			case c >= '0' && c <= ';':
				if len(m.params) < 64 {
					m.params = append(m.params, c)
				} else {
					m.bad = true
				}
			case c >= 0x20 && c <= 0x2f:
				m.bad = true
			case c >= 0x40 && c <= 0x7e:
				if !m.bad {
					m.dispatch(c)
				}
				m.st = stGround
			case c < 0x20: // a C0 control inside a CSI is executed; the sequence goes on
			default:
				m.st = stGround
			}
		}
		m.pos++
	}
}

func (m *modes) reset() {
	m.dec = map[int]bool{}
	m.alt, m.altAt, m.kitty = false, -1, nil
}

func (m *modes) nums(def int) []int {
	if len(m.params) == 0 {
		return []int{def}
	}
	var out []int
	for _, p := range strings.Split(string(m.params), ";") {
		n, err := strconv.Atoi(p)
		if err != nil {
			n = def
		}
		out = append(out, n)
	}
	return out
}

func (m *modes) dispatch(final byte) {
	switch {
	case m.prefix == '?' && (final == 'h' || final == 'l'):
		on := final == 'h'
		for _, n := range m.nums(0) {
			switch {
			case n == 47 || n == 1047 || n == 1049:
				if on && !m.alt {
					m.altAt, m.altNo = m.seqAt, n
				}
				m.alt = on
				if !on {
					m.altAt = -1
				}
			case trackedDEC[n]:
				m.dec[n] = on
			}
		}
	case final == 'u' && m.prefix == '>': // push kitty flags
		m.kitty = append(m.kitty, m.nums(0)[0])
		if len(m.kitty) > 16 {
			m.kitty = m.kitty[1:]
		}
	case final == 'u' && m.prefix == '<': // pop
		n := m.nums(1)[0]
		if n >= len(m.kitty) {
			m.kitty = nil
		} else {
			m.kitty = m.kitty[:len(m.kitty)-n]
		}
	case final == 'u' && m.prefix == '=': // set, or with, and not
		p := m.nums(1)
		flags, how := p[0], 1
		if len(p) > 1 {
			how = p[1]
		}
		if len(m.kitty) == 0 {
			m.kitty = []int{0}
		}
		top := &m.kitty[len(m.kitty)-1]
		switch how {
		case 2:
			*top |= flags
		case 3:
			*top &^= flags
		default:
			*top = flags
		}
	}
}

// replayPrefix goes before a replay that starts at stream offset start: it enters the
// alternate screen when the app is on it and the sequence that entered it was cut off.
func (m *modes) replayPrefix(start int64) string {
	if m.alt && m.altAt < start {
		return fmt.Sprintf("\x1b[?%dh", m.altNo)
	}
	return ""
}

// replaySuffix goes after a cut replay: the tracked modes as the app left them.
func (m *modes) replaySuffix() string {
	var b strings.Builder
	ns := make([]int, 0, len(m.dec))
	for n := range m.dec {
		ns = append(ns, n)
	}
	sort.Ints(ns)
	for _, n := range ns {
		c := 'l'
		if m.dec[n] {
			c = 'h'
		}
		fmt.Fprintf(&b, "\x1b[?%d%c", n, c)
	}
	if len(m.kitty) > 0 {
		b.WriteString("\x1b[<99u") // empty the view's stack, then push the app's
		for _, f := range m.kitty {
			fmt.Fprintf(&b, "\x1b[>%du", f)
		}
	}
	return b.String()
}
