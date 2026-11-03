package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Upload is a file the person attached to a reply or a new message, not sent
// yet. Its bytes are a blob; sending turns it into an attachment.
type Upload struct {
	ID         string    `json:"upload_id"`
	Name       string    `json:"name"`
	Size       int64     `json:"size"`
	Type       string    `json:"type"`
	SHA256     string    `json:"sha256"`
	Mime       string    `json:"mime"`
	Width      int       `json:"width,omitempty"`
	Height     int       `json:"height,omitempty"`
	DurationMs int64     `json:"duration_ms,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
	SearchText string    `json:"-"`
}

// UploadKeep: an upload no message took is dropped after this long.
const UploadKeep = 24 * time.Hour

func (s *Store) AddUpload(ctx context.Context, u *Upload) error {
	u.ID = NewID("upl")
	u.CreatedAt = s.now()
	_, err := s.db.ExecContext(ctx, `INSERT INTO uploads(id,name,size,type,sha256,mime,width,height,duration_ms,search_text,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		u.ID, u.Name, u.Size, u.Type, u.SHA256, u.Mime, u.Width, u.Height, u.DurationMs, u.SearchText, ms(u.CreatedAt))
	return err
}

func (s *Store) GetUpload(ctx context.Context, id string) (*Upload, error) {
	var u Upload
	var created int64
	err := s.db.QueryRowContext(ctx, `SELECT id,name,size,type,sha256,mime,width,height,duration_ms,search_text,created_at FROM uploads WHERE id=?`, id).
		Scan(&u.ID, &u.Name, &u.Size, &u.Type, &u.SHA256, &u.Mime, &u.Width, &u.Height, &u.DurationMs, &u.SearchText, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	u.CreatedAt = fromMs(created)
	return &u, nil
}

func (s *Store) DeleteUpload(ctx context.Context, id string) error {
	return s.exec(ctx, `DELETE FROM uploads WHERE id=?`, id)
}

// SweepUploads drops uploads no message took within UploadKeep.
func (s *Store) SweepUploads(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM uploads WHERE created_at<?`, ms(s.now().Add(-UploadKeep)))
	return err
}
