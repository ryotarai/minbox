package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/ryotarai/minbox/internal/linear"
)

// Issue search for the thread's "Link Linear issue" dialog: one small page of list_issues with
// the tool's text-query argument, plus the issue itself when the text is an identifier (ENG-123)
// or an issue URL, so an exact identifier always comes first. Answers are cached per query for a
// short while (the dialog searches as the person types). See docs/linear.md.

const (
	searchTTL   = 30 * time.Second
	searchLimit = 20
	searchMaxQ  = 200
	searchCache = 200 // cached queries kept at most
)

type searchEntry struct {
	at     time.Time
	issues []linear.Issue
}

// searchText: one page of list_issues for q (no assignee filter). A tool without a text-query
// argument is an error: minbox will not list the whole workspace instead.
func (l *linearSvc) searchText(ctx context.Context, q string) ([]linear.Issue, error) {
	rr, _, err := l.callRaw(ctx, "list_issues", func(t linear.Tool) (map[string]any, error) {
		p := t.Pick("query", "search", "term", "text")
		if p == "" {
			return nil, fmt.Errorf("the Linear tool %s takes no text query: search by identifier (ENG-123) or issue URL", t.Name)
		}
		args := map[string]any{p: q}
		if lp := t.Pick("limit", "first", "pageSize", "page_size"); lp != "" {
			args[lp] = searchLimit
		}
		if o := t.Pick("orderBy", "order_by"); o != "" {
			args[o] = "updatedAt"
		}
		return args, nil
	})
	if err != nil {
		return nil, err
	}
	return linear.ParseIssues(linear.IssueItems(rr.Value())), nil
}

// search: the exact issue (when q is an identifier or URL) followed by the text matches, without
// duplicates, at most searchLimit. Cached per lower-cased query for searchTTL.
func (l *linearSvc) search(ctx context.Context, q string) ([]linear.Issue, error) {
	key := strings.ToLower(q)
	st := &l.iss
	st.mu.Lock()
	if e, ok := st.searches[key]; ok && l.now().Sub(e.at) < searchTTL {
		st.mu.Unlock()
		return e.issues, nil
	}
	st.mu.Unlock()

	var out []linear.Issue
	seen := map[string]bool{}
	add := func(is linear.Issue) {
		id := strings.ToUpper(is.Identifier)
		if id == "" || seen[id] || len(out) >= searchLimit {
			return
		}
		seen[id] = true
		if is.StateType == "" {
			is.StateType = linear.TypeByName(is.State)
		}
		is.StateType = strings.ToLower(is.StateType)
		out = append(out, is)
	}
	ident, identErr := linear.ParseIssueRef(q)
	if identErr == nil {
		is, err := l.getIssue(ctx, ident)
		var rl *linear.RateLimitError
		switch {
		case err == nil:
			add(*is)
		case errors.As(err, &rl), ctx.Err() != nil:
			return nil, err
		}
		// Not found: the text search may still find something (ENG-12 while typing ENG-123).
	}
	// A URL names one issue: no text search for it.
	if identErr != nil || !strings.Contains(q, "/") {
		found, err := l.searchText(ctx, q)
		if err != nil && len(out) == 0 {
			return nil, err
		}
		for _, is := range found {
			add(is)
		}
	}
	st.mu.Lock()
	if len(st.searches) >= searchCache {
		for k, e := range st.searches {
			if l.now().Sub(e.at) >= searchTTL || len(st.searches) >= searchCache {
				delete(st.searches, k)
			}
		}
	}
	st.searches[key] = searchEntry{at: l.now(), issues: out}
	st.mu.Unlock()
	return out, nil
}

// GET /api/linear/search?q=…: {"issues": [...], "query": q}. An empty q answers no issues
// without asking Linear.
func (s *Server) linearSearch(w http.ResponseWriter, r *http.Request) {
	l := s.lin
	ctx := r.Context()
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len([]rune(q)) > searchMaxQ {
		httpError(w, 400, fmt.Sprintf("the search text is longer than %d characters", searchMaxQ))
		return
	}
	if _, err := l.me(ctx); err != nil {
		l.linearFail(w, err)
		return
	}
	views := []issueView{}
	if q == "" {
		writeJSON(w, 200, map[string]any{"issues": views, "query": q})
		return
	}
	found, err := l.search(ctx, q)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		l.linearFail(w, err)
		return
	}
	threads, _ := s.store.ThreadsByIssue(ctx)
	for _, is := range found {
		views = append(views, toView(is, threads, false))
	}
	writeJSON(w, 200, map[string]any{"issues": views, "query": q})
}
