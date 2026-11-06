package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// SetProjectEmoji gives a project an emoji icon (the caller validated it).
func (s *Store) SetProjectEmoji(ctx context.Context, id, emoji string) error {
	return s.setIcon(ctx, id, "emoji", emoji, nil)
}

// SetProjectImage gives a project an image icon: png is the final 128x128 PNG.
func (s *Store) SetProjectImage(ctx context.Context, id string, png []byte) error {
	return s.setIcon(ctx, id, "image", "", png)
}

// ClearProjectIcon removes a project's icon.
func (s *Store) ClearProjectIcon(ctx context.Context, id string) error {
	return s.setIcon(ctx, id, "", "", nil)
}

func (s *Store) setIcon(ctx context.Context, id, kind, emoji string, png []byte) error {
	res, err := s.db.ExecContext(ctx, `UPDATE projects SET icon_kind=?, icon_emoji=?, icon_png=?, icon_updated_at=? WHERE id=?`,
		kind, emoji, png, time.Now().UnixMilli(), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ProjectIconPNG answers the PNG of a project's image icon (ErrNotFound when it has none).
func (s *Store) ProjectIconPNG(ctx context.Context, id string) ([]byte, error) {
	var png []byte
	var kind string
	err := s.db.QueryRowContext(ctx, `SELECT icon_kind, icon_png FROM projects WHERE id=?`, id).Scan(&kind, &png)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (kind != "image" || len(png) == 0)) {
		return nil, ErrNotFound
	}
	return png, err
}
