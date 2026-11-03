package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/ryotarai/minbox/internal/attach"
	"strings"
	"time"
	"unicode/utf8"
)

// ---- attachments ----

// Attachment is a file (or a guided review) a message carries, or an image
// its body shows (Inline).
type Attachment struct {
	ID         string     `json:"id"`
	ThreadID   string     `json:"thread_id"`
	MessageID  string     `json:"message_id"`
	Author     string     `json:"author"` // agent | user
	Kind       string     `json:"kind"`   // file | review
	Type       string     `json:"type"`   // markdown text html mermaid graphviz code image video pdf file (review: "")
	Name       string     `json:"name"`
	Path       string     `json:"path"` // realpath
	NamedPath  *string    `json:"named_path"`
	Mime       string     `json:"mime"`
	Size       int64      `json:"size"`
	Width      int        `json:"width,omitempty"`
	Height     int        `json:"height,omitempty"`
	DurationMs int64      `json:"duration_ms,omitempty"`
	SentMtime  *time.Time `json:"sent_mtime"`
	CreatedAt  time.Time  `json:"created_at"`
	Inline     bool       `json:"inline"`
	Ref        string     `json:"ref,omitempty"` // inline image: the src as written in the body
	SHA256     string     `json:"-"`
	// SearchText: the words of a text file, for search (not served).
	SearchText string `json:"-"`
}

// Attachment kinds.
const (
	AttachmentFile   = "file"
	AttachmentReview = "review"
)

// AddAttachment stores an attachment snapshot (content for a file, review JSON for a review).
func (s *Store) AddAttachment(ctx context.Context, a *Attachment, content []byte, review string) error {
	if a.ID == "" {
		a.ID = NewID("att")
	}
	a.CreatedAt = s.now()
	if a.Author == "" {
		a.Author = AuthorAgent
	}
	var mtime any
	if a.SentMtime != nil {
		mtime = ms(*a.SentMtime)
	}
	named := ""
	if a.NamedPath != nil {
		named = *a.NamedPath
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO attachments(id,thread_id,message_id,kind,name,path,mime,size,sha256,content,review,created_at,type,author,named_path,width,height,duration_ms,sent_mtime,inline,ref,search_text) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		a.ID, a.ThreadID, a.MessageID, a.Kind, a.Name, a.Path, a.Mime, a.Size, a.SHA256, content, review, ms(a.CreatedAt),
		a.Type, a.Author, named, a.Width, a.Height, a.DurationMs, mtime, a.Inline, a.Ref, a.SearchText)
	return err
}

const attachmentCols = `id, thread_id, message_id, kind, name, path, mime, size, sha256, created_at, type, author, named_path, width, height, duration_ms, sent_mtime, inline, ref`

func scanAttachment(row interface{ Scan(...any) error }, extra ...any) (*Attachment, error) {
	var a Attachment
	var created int64
	var named string
	var mtime sql.NullInt64
	dst := append([]any{&a.ID, &a.ThreadID, &a.MessageID, &a.Kind, &a.Name, &a.Path, &a.Mime, &a.Size, &a.SHA256, &created,
		&a.Type, &a.Author, &named, &a.Width, &a.Height, &a.DurationMs, &mtime, &a.Inline, &a.Ref}, extra...)
	if err := row.Scan(dst...); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	a.CreatedAt = fromMs(created)
	if named != "" {
		a.NamedPath = &named
	}
	a.SentMtime = fromNullMs(mtime)
	if a.Type == "" && a.Kind == AttachmentFile {
		a.Type = legacyType(a.Name, a.Mime)
	}
	return &a, nil
}

// legacyType: rows from before types were stored, judged by name and mime.
func legacyType(name, mime string) string {
	switch {
	case strings.HasPrefix(mime, "image/"):
		return "image"
	case strings.HasPrefix(mime, "video/"):
		return "video"
	case mime == "application/pdf":
		return "pdf"
	}
	switch t := attach.ByName(name); t {
	case "file":
		if strings.HasPrefix(mime, "text/") || mime == "application/json" {
			return "code"
		}
		return "file"
	default:
		return t
	}
}

// AttachmentsOfMessage lists a message's attachments (not its inline images).
func (s *Store) AttachmentsOfMessage(ctx context.Context, messageID string) ([]Attachment, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+attachmentCols+` FROM attachments WHERE message_id=? AND inline=0 ORDER BY created_at, rowid`, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Attachment{}
	for rows.Next() {
		a, err := scanAttachment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

// InlineImage finds a message's inline image by the src written in its body.
func (s *Store) InlineImage(ctx context.Context, messageID, ref string) (*Attachment, error) {
	return scanAttachment(s.db.QueryRowContext(ctx, `SELECT `+attachmentCols+` FROM attachments WHERE message_id=? AND inline=1 AND ref=? LIMIT 1`, messageID, ref))
}

// ListAttachments lists a thread's attachments, oldest first.
func (s *Store) ListAttachments(ctx context.Context, threadID string) ([]Attachment, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+attachmentCols+` FROM attachments WHERE thread_id=? ORDER BY created_at, rowid`, threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Attachment{}
	for rows.Next() {
		a, err := scanAttachment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

// GetAttachment returns an attachment with its snapshot and review JSON.
func (s *Store) GetAttachment(ctx context.Context, id string) (*Attachment, []byte, string, error) {
	var content []byte
	var review string
	a, err := scanAttachment(s.db.QueryRowContext(ctx, `SELECT `+attachmentCols+`, content, review FROM attachments WHERE id=?`, id), &content, &review)
	if err != nil {
		return nil, nil, "", err
	}
	return a, content, review, nil
}

// ---- cards (Board) ----

// Card columns.
var CardColumns = []string{"backlog", "designing", "look", "building", "review", "shipped", "icebox", "dropped"}

func ValidColumn(c string) bool {
	for _, v := range CardColumns {
		if v == c {
			return true
		}
	}
	return false
}

type Card struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Column    string    `json:"column"`
	Note      string    `json:"note"`
	SessionID *string   `json:"session_id"`
	ThreadID  *string   `json:"thread_id"`
	PRURL     string    `json:"pr_url"`
	PRState   string    `json:"pr_state"`
	PRNumber  int       `json:"pr_number"`
	CreatedBy string    `json:"created_by"`
	DroppedBy string    `json:"dropped_by"`
	Position  float64   `json:"position"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// CardPatch: fields to change (nil leaves them).
type CardPatch struct {
	Title     *string  `json:"title"`
	Column    *string  `json:"column"`
	Note      *string  `json:"note"`
	SessionID *string  `json:"session_id"`
	ThreadID  *string  `json:"thread_id"`
	PRURL     *string  `json:"pr_url"`
	PRState   *string  `json:"pr_state"`
	PRNumber  *int     `json:"pr_number"`
	Position  *float64 `json:"position"`
}

const cardCols = `id, title, col, note, session_id, thread_id, pr_url, pr_state, pr_number, created_by, dropped_by, position, created_at, updated_at`

func scanCard(row interface{ Scan(...any) error }) (*Card, error) {
	var c Card
	var sid, tid sql.NullString
	var created, updated int64
	if err := row.Scan(&c.ID, &c.Title, &c.Column, &c.Note, &sid, &tid, &c.PRURL, &c.PRState, &c.PRNumber, &c.CreatedBy, &c.DroppedBy, &c.Position, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if sid.Valid && sid.String != "" {
		c.SessionID = &sid.String
	}
	if tid.Valid && tid.String != "" {
		c.ThreadID = &tid.String
	}
	c.CreatedAt, c.UpdatedAt = fromMs(created), fromMs(updated)
	return &c, nil
}

// ListCards lists cards (of one session when sessionID is set) by column and position.
func (s *Store) ListCards(ctx context.Context, sessionID string) ([]Card, error) {
	q := `SELECT ` + cardCols + ` FROM cards`
	var args []any
	if sessionID != "" {
		q += ` WHERE session_id=?`
		args = append(args, sessionID)
	}
	rows, err := s.db.QueryContext(ctx, q+` ORDER BY position, created_at`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Card{}
	for rows.Next() {
		c, err := scanCard(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

func (s *Store) GetCard(ctx context.Context, id string) (*Card, error) {
	return scanCard(s.db.QueryRowContext(ctx, `SELECT `+cardCols+` FROM cards WHERE id=?`, id))
}

func nullStr(p *string) any {
	if p == nil || *p == "" {
		return nil
	}
	return *p
}

// CreateCard adds a card at the end of its column.
func (s *Store) CreateCard(ctx context.Context, c *Card) error {
	now := s.now()
	c.ID, c.CreatedAt, c.UpdatedAt = NewID("card"), now, now
	if c.Position == 0 {
		var maxPos sql.NullFloat64
		_ = s.db.QueryRowContext(ctx, `SELECT MAX(position) FROM cards WHERE col=?`, c.Column).Scan(&maxPos)
		c.Position = maxPos.Float64 + 1
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO cards(`+cardCols+`) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		c.ID, c.Title, c.Column, c.Note, nullStr(c.SessionID), nullStr(c.ThreadID), c.PRURL, c.PRState, c.PRNumber, c.CreatedBy, c.DroppedBy, c.Position, ms(now), ms(now))
	return err
}

// UpdateCard applies a patch; by records who dropped a card moved to "dropped".
func (s *Store) UpdateCard(ctx context.Context, id string, p CardPatch, by string) (*Card, error) {
	c, err := s.GetCard(ctx, id)
	if err != nil {
		return nil, err
	}
	if p.Title != nil {
		c.Title = *p.Title
	}
	if p.Column != nil && *p.Column != c.Column {
		c.Column = *p.Column
		if c.Column == "dropped" {
			c.DroppedBy = by
		} else {
			c.DroppedBy = ""
		}
	}
	if p.Note != nil {
		c.Note = *p.Note
	}
	if p.SessionID != nil {
		c.SessionID = p.SessionID
	}
	if p.ThreadID != nil {
		c.ThreadID = p.ThreadID
	}
	if p.PRURL != nil {
		c.PRURL = *p.PRURL
	}
	if p.PRState != nil {
		c.PRState = *p.PRState
	}
	if p.PRNumber != nil {
		c.PRNumber = *p.PRNumber
	}
	if p.Position != nil {
		c.Position = *p.Position
	}
	c.UpdatedAt = s.now()
	err = s.exec(ctx, `UPDATE cards SET title=?, col=?, note=?, session_id=?, thread_id=?, pr_url=?, pr_state=?, pr_number=?, dropped_by=?, position=?, updated_at=? WHERE id=?`,
		c.Title, c.Column, c.Note, nullStr(c.SessionID), nullStr(c.ThreadID), c.PRURL, c.PRState, c.PRNumber, c.DroppedBy, c.Position, ms(c.UpdatedAt), id)
	return c, err
}

func (s *Store) DeleteCard(ctx context.Context, id string) error {
	return s.exec(ctx, `DELETE FROM cards WHERE id=?`, id)
}

// ---- settings ----

// Settings returns the stored settings (top-level key -> JSON value).
func (s *Store) Settings(ctx context.Context) (map[string]json.RawMessage, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT key, value FROM settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]json.RawMessage{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = json.RawMessage(v)
	}
	return out, rows.Err()
}

// PutSettings stores top-level keys (replacing their values).
func (s *Store) PutSettings(ctx context.Context, values map[string]json.RawMessage) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for k, v := range values {
		if _, err := tx.ExecContext(ctx, `INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, k, string(v)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ---- search ----

type SearchQuery struct {
	Q         string
	SessionID string
	Status    string // a section
	From      string // agent | user
	Limit     int
}

type Hit struct {
	ThreadID     string    `json:"thread_id"`
	SessionID    string    `json:"session_id"`
	SessionName  string    `json:"session_name"`
	Subject      string    `json:"subject"`
	MessageID    string    `json:"message_id,omitempty"`
	AttachmentID string    `json:"attachment_id,omitempty"`
	Name         string    `json:"name,omitempty"`
	Author       string    `json:"author,omitempty"`
	Snippet      string    `json:"snippet"`
	Archived     bool      `json:"archived"`
	Section      string    `json:"section"`
	CreatedAt    time.Time `json:"created_at"`
}

type SearchResult struct {
	Threads  []Hit `json:"threads"`
	Messages []Hit `json:"messages"`
	Files    []Hit `json:"files"`
}

func likeEscape(w string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(strings.ToLower(w)) + "%"
}

// likeAll builds "lower(expr) LIKE ? ESCAPE '\' AND ..." for every word.
func likeAll(expr string, words []string) (string, []any) {
	var parts []string
	var args []any
	for _, w := range words {
		parts = append(parts, `lower(`+expr+`) LIKE ? ESCAPE '\'`)
		args = append(args, likeEscape(w))
	}
	return "(" + strings.Join(parts, " AND ") + ")", args
}

// snippet cuts text around the first word's match.
func snippet(text string, words []string) string {
	text = strings.Join(strings.Fields(text), " ")
	lower := strings.ToLower(text)
	at := -1
	for _, w := range words {
		if i := strings.Index(lower, strings.ToLower(w)); i >= 0 && (at < 0 || i < at) {
			at = i
		}
	}
	if at < 0 {
		at = 0
	}
	start := at
	for n := 0; start > 0 && n < 40; n++ {
		_, size := utf8.DecodeLastRuneInString(text[:start])
		start -= size
	}
	r := []rune(text[start:])
	out := string(r)
	if len(r) > 140 {
		out = string(r[:140]) + "…"
	}
	if start > 0 {
		out = "…" + out
	}
	return out
}

// Search finds threads (subject or name), messages (body) and files (name or text).
func (s *Store) Search(ctx context.Context, q SearchQuery) (*SearchResult, error) {
	words := strings.Fields(q.Q)
	res := &SearchResult{Threads: []Hit{}, Messages: []Hit{}, Files: []Hit{}}
	if len(words) == 0 {
		return res, nil
	}
	if q.Limit <= 0 || q.Limit > 200 {
		q.Limit = 50
	}
	scope := ""
	var scopeArgs []any
	if q.SessionID != "" {
		scope = ` AND t.session_id=?`
		scopeArgs = append(scopeArgs, q.SessionID)
	}
	// Derived state of the threads hit, loaded once each.
	derived := map[string]*Thread{}
	threadOf := func(id string) *Thread {
		if t, ok := derived[id]; ok {
			return t
		}
		t, err := s.GetThread(ctx, id)
		if err != nil {
			derived[id] = nil
			return nil
		}
		t.Messages = nil
		derived[id] = t
		return t
	}
	names := map[string]string{}
	sessName := func(id string) string {
		if n, ok := names[id]; ok {
			return n
		}
		var n string
		_ = s.db.QueryRowContext(ctx, `SELECT name FROM sessions WHERE id=?`, id).Scan(&n)
		names[id] = n
		return n
	}
	keep := func(h *Hit) bool {
		t := threadOf(h.ThreadID)
		if t == nil {
			return false
		}
		h.Section = t.Section
		h.Archived = t.ArchivedAt != nil
		h.SessionName = sessName(h.SessionID)
		h.Subject = t.Subject
		return q.Status == "" || q.Status == t.Section
	}

	if q.From == "" {
		cond, args := likeAll(`t.subject || ' ' || t.name`, words)
		rows, err := s.db.QueryContext(ctx, `SELECT t.id, t.session_id, t.subject, t.updated_at FROM threads t WHERE `+cond+scope+` ORDER BY t.updated_at DESC LIMIT ?`,
			append(append(args, scopeArgs...), q.Limit)...)
		if err != nil {
			return nil, err
		}
		var hits []Hit
		for rows.Next() {
			var h Hit
			var at int64
			if err := rows.Scan(&h.ThreadID, &h.SessionID, &h.Snippet, &at); err != nil {
				rows.Close()
				return nil, err
			}
			h.CreatedAt = fromMs(at)
			hits = append(hits, h)
		}
		rows.Close()
		for _, h := range hits {
			if keep(&h) {
				res.Threads = append(res.Threads, h)
			}
		}
	}

	cond, args := likeAll(`m.body`, words)
	from := ""
	if q.From == AuthorAgent || q.From == AuthorUser {
		from = ` AND m.author=?`
		args = append(args, q.From)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT m.id, m.thread_id, t.session_id, m.author, m.body, m.created_at FROM messages m JOIN threads t ON t.id=m.thread_id
	  WHERE `+cond+from+scope+` ORDER BY m.created_at DESC LIMIT ?`, append(append(args, scopeArgs...), q.Limit)...)
	if err != nil {
		return nil, err
	}
	var mhits []Hit
	for rows.Next() {
		var h Hit
		var body string
		var at int64
		if err := rows.Scan(&h.MessageID, &h.ThreadID, &h.SessionID, &h.Author, &body, &at); err != nil {
			rows.Close()
			return nil, err
		}
		h.Snippet = snippet(body, words)
		h.CreatedAt = fromMs(at)
		mhits = append(mhits, h)
	}
	rows.Close()
	for _, h := range mhits {
		if keep(&h) {
			res.Messages = append(res.Messages, h)
		}
	}

	{
		textExpr := `COALESCE(NULLIF(a.search_text,''), CASE WHEN a.mime LIKE 'text/%' OR a.mime='application/json' OR a.mime='' THEN CAST(COALESCE(a.content,'') AS TEXT) ELSE '' END)`
		cond, args := likeAll(`a.name || ' ' || `+textExpr, words)
		from := ""
		if q.From != "" {
			from = ` AND a.author=?`
			scopeArgs = append(scopeArgs, q.From)
		}
		rows, err := s.db.QueryContext(ctx, `SELECT a.id, a.thread_id, t.session_id, a.name, a.message_id, `+textExpr+`, a.mime, a.created_at FROM attachments a JOIN threads t ON t.id=a.thread_id
		  WHERE a.kind='file' AND `+cond+scope+from+` ORDER BY a.created_at DESC LIMIT ?`, append(append(args, scopeArgs...), q.Limit)...)
		if err != nil {
			return nil, err
		}
		var fhits []Hit
		for rows.Next() {
			var h Hit
			var content, mime string
			var at int64
			if err := rows.Scan(&h.AttachmentID, &h.ThreadID, &h.SessionID, &h.Name, &h.MessageID, &content, &mime, &at); err != nil {
				rows.Close()
				return nil, err
			}
			h.Snippet = h.Name
			if content != "" {
				if sn := snippet(content, words); sn != "" {
					h.Snippet = sn
				}
			}
			h.CreatedAt = fromMs(at)
			fhits = append(fhits, h)
		}
		rows.Close()
		for _, h := range fhits {
			if keep(&h) {
				res.Files = append(res.Files, h)
			}
		}
	}
	return res, nil
}
