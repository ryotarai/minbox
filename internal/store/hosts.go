package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// LocalHostID is the built-in host: the terminal host on the server's machine.
const LocalHostID = "local"

// Host connection methods.
const (
	MethodBuiltin   = "builtin"
	MethodTailscale = "tailscale"
	MethodDirect    = "direct"
)

// Host is a machine sessions run on.
type Host struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	URL            string    `json:"url"`
	Builtin        bool      `json:"builtin"`
	Method         string    `json:"method"`
	TailscaleLogin string    `json:"tailscale_login,omitempty"`
	Paired         bool      `json:"paired"`
	PairingCode    string    `json:"pairing_code,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
}

// EnsureLocalHost records the built-in host (once); url is how it is shown.
func (s *Store) EnsureLocalHost(ctx context.Context, url string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO hosts(id,name,url,token,builtin,method,paired,created_at) VALUES(?,?,?,'',1,?,1,?)
	  ON CONFLICT(id) DO UPDATE SET url=excluded.url, method=excluded.method, paired=1`, LocalHostID, "local", url, MethodBuiltin, ms(s.now()))
	return err
}

const hostCols = `id, name, url, builtin, method, tailscale_login, paired, pairing_code, created_at`

func scanHost(row interface{ Scan(...any) error }) (*Host, error) {
	var h Host
	var created int64
	if err := row.Scan(&h.ID, &h.Name, &h.URL, &h.Builtin, &h.Method, &h.TailscaleLogin, &h.Paired, &h.PairingCode, &created); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	h.CreatedAt = fromMs(created)
	return &h, nil
}

// ListHosts lists the hosts, the built-in one first.
func (s *Store) ListHosts(ctx context.Context) ([]Host, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+hostCols+` FROM hosts ORDER BY builtin DESC, created_at, rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Host{}
	for rows.Next() {
		h, err := scanHost(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *h)
	}
	return out, rows.Err()
}

func (s *Store) GetHost(ctx context.Context, id string) (*Host, error) {
	return scanHost(s.db.QueryRowContext(ctx, `SELECT `+hostCols+` FROM hosts WHERE id=?`, id))
}

// CreateHost records a remote host, waiting for the pairing code to be accepted.
func (s *Store) CreateHost(ctx context.Context, name, url, method, tailscaleLogin, pairingCode string) (*Host, error) {
	h := &Host{ID: NewID("hst"), Name: name, URL: url, Method: method, TailscaleLogin: tailscaleLogin, PairingCode: pairingCode, CreatedAt: s.now()}
	_, err := s.db.ExecContext(ctx, `INSERT INTO hosts(id,name,url,token,builtin,method,tailscale_login,paired,pairing_code,created_at) VALUES(?,?,?,'',0,?,?,0,?,?)`,
		h.ID, h.Name, h.URL, h.Method, h.TailscaleLogin, h.PairingCode, ms(h.CreatedAt))
	if err != nil {
		return nil, err
	}
	return h, nil
}

// UpdateHost changes what is given.
func (s *Store) UpdateHost(ctx context.Context, id string, name, url *string) error {
	if name != nil {
		if err := s.exec(ctx, `UPDATE hosts SET name=? WHERE id=?`, *name, id); err != nil {
			return err
		}
	}
	if url != nil {
		if err := s.exec(ctx, `UPDATE hosts SET url=? WHERE id=?`, *url, id); err != nil {
			return err
		}
	}
	_, err := s.GetHost(ctx, id)
	return err
}

// SetHostPairing records a pairing in progress (code) or its end (paired).
func (s *Store) SetHostPairing(ctx context.Context, id, code string, paired bool) error {
	return s.exec(ctx, `UPDATE hosts SET pairing_code=?, paired=? WHERE id=?`, code, paired, id)
}

// DeleteHost removes a remote host; its sessions are ended (and stay, with
// their threads).
func (s *Store) DeleteHost(ctx context.Context, id string) error {
	if id == LocalHostID {
		return errors.New("the built-in host cannot be removed")
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE sessions SET status=?, updated_at=? WHERE host_id=? AND status!=?`, StatusEnded, ms(s.now()), id, StatusEnded); err != nil {
		return err
	}
	return s.exec(ctx, `DELETE FROM hosts WHERE id=?`, id)
}

// SessionsOnHost counts a host's sessions (all of them).
func (s *Store) SessionsOnHost(ctx context.Context, id string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sessions WHERE host_id=?`, id).Scan(&n)
	return n, err
}

// HostOfThread is the host of the thread's session.
func (s *Store) HostOfThread(ctx context.Context, threadID string) (string, string, error) {
	var host, cwd string
	err := s.db.QueryRowContext(ctx, `SELECT s.host_id, s.cwd FROM threads t JOIN sessions s ON s.id=t.session_id WHERE t.id=?`, threadID).Scan(&host, &cwd)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrNotFound
	}
	return host, cwd, err
}
