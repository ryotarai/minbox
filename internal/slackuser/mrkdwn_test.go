package slackuser

import (
	"strings"
	"testing"
)

func TestRenderHTML(t *testing.T) {
	rs := Resolver{User: func(id string) string { return map[string]string{"U1": "Alice"}[id] }, Channel: func(id string) string { return "general" }}
	for _, c := range []struct{ in, want string }{
		{"*bold* and _it_ and ~s~", "<b>bold</b> and <i>it</i> and <s>s</s>"},
		{"snake_case_word stays", "snake_case_word stays"},
		{"`a *b* c`", "<code>a *b* c</code>"},
		{"```\nx <y>\n```", "<pre><code>x &lt;y&gt;</code></pre>"},
		{"<@U1> hi", `<span class="mention">@Alice</span> hi`},
		{"<@U9|bob>", `<span class="mention">@bob</span>`},
		{"<#C1|dev>", `<span class="mention">#dev</span>`},
		{"<!here> now", `<span class="mention">@here</span> now`},
		{"<https://a.example/x_y_z|label *x*>", `<a href="https://a.example/x_y_z" target="_blank" rel="noopener noreferrer">label *x*</a>`},
		{"<mailto:a@b.example|mail>", `<a href="mailto:a@b.example" target="_blank" rel="noopener noreferrer">mail</a>`},
		{"&lt;b&gt; &amp; ok", "&lt;b&gt; &amp; ok"},
		{"> q1\n> q2\nafter", "<blockquote>q1<br>q2</blockquote>after"},
		{"line1\nline2", "line1<br>line2"},
		{":tada: yes", ":tada: yes"},
	} {
		if got := RenderHTML(c.in, rs); got != c.want {
			t.Errorf("RenderHTML(%q)\n got  %q\n want %q", c.in, got, c.want)
		}
	}
	// nothing unsafe ever comes out
	for _, in := range []string{"<javascript:alert(1)|x>", "<data:text/html,x|y>", "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "\x00 0 \x00", "<https://x.example/\"onmouseover=\"alert(1)|a>"} {
		got := RenderHTML(in, rs)
		if strings.Contains(got, "<script") || strings.Contains(got, "<img") || strings.Contains(got, `href="javascript`) || strings.Contains(got, `href="data`) || strings.Contains(got, `" onmouseover`) {
			t.Errorf("unsafe output for %q: %q", in, got)
		}
	}
}

func TestPermalinkAndPlainText(t *testing.T) {
	if got := PermalinkFor("https://acme.slack.com/", "C1", "1700000000.000100", ""); got != "https://acme.slack.com/archives/C1/p1700000000000100" {
		t.Errorf("permalink %q", got)
	}
	if got := PermalinkFor("https://acme.slack.com", "C1", "1700000000.000200", "1700000000.000100"); !strings.Contains(got, "thread_ts=1700000000.000100") {
		t.Errorf("thread permalink %q", got)
	}
	rs := Resolver{User: func(string) string { return "Alice" }}
	if got := PlainText("<@U1> see <https://x.example|this> &lt;ok&gt; <#C1|dev>", rs); got != "@Alice see this <ok> #dev" {
		t.Errorf("plain %q", got)
	}
	if got := threadFromPermalink("https://a.slack.com/archives/C1/p1?thread_ts=1699999999.000100&cid=C1"); got != "1699999999.000100" {
		t.Errorf("thread_ts %q", got)
	}
}
