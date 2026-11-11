package linear

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ErrInvalidGrant: the refresh token (or code) is no longer valid; the person must log in again.
var ErrInvalidGrant = errors.New("linear: the login expired or was revoked (invalid_grant)")

// Discovery is what the MCP server's OAuth metadata says.
type Discovery struct {
	Resource              string   `json:"resource"`
	Issuer                string   `json:"issuer"`
	AuthorizationEndpoint string   `json:"authorization_endpoint"`
	TokenEndpoint         string   `json:"token_endpoint"`
	RegistrationEndpoint  string   `json:"registration_endpoint"`
	Scopes                []string `json:"scopes_supported"`
	IssParam              bool     `json:"authorization_response_iss_parameter_supported"`
}

// Registration is the client registered by dynamic client registration (RFC 7591).
type Registration struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret,omitempty"`
	RedirectURI  string `json:"redirect_uri"`
	AuthMethod   string `json:"auth_method,omitempty"` // token_endpoint_auth_method
}

// Token is an OAuth token set.
type Token struct {
	Access  string    `json:"access_token"`
	Refresh string    `json:"refresh_token,omitempty"`
	Expiry  time.Time `json:"expiry"`
	Scope   string    `json:"scope,omitempty"`
}

// Valid: the access token is there and not about to expire.
func (t Token) Valid(now time.Time) bool {
	return t.Access != "" && (t.Expiry.IsZero() || now.Add(60*time.Second).Before(t.Expiry))
}

func okEndpoint(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "https" && !(u.Scheme == "http" && LoopbackHost(u.Hostname()))) {
		return nil, fmt.Errorf("linear: unusable OAuth endpoint %q (https required)", raw)
	}
	return u, nil
}

func getJSON(ctx context.Context, hc *http.Client, u string, out any) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return resp.StatusCode, err
	}
	if resp.StatusCode != 200 {
		return resp.StatusCode, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return resp.StatusCode, json.Unmarshal(b, out)
}

// Discover finds the authorization server of an MCP URL: protected-resource metadata (RFC 9728,
// path-specific first, then the origin's), then the authorization server's metadata (RFC 8414,
// then OpenID configuration). Only GETs.
func Discover(ctx context.Context, hc *http.Client, mcpURL string) (*Discovery, error) {
	mu, err := okEndpoint(mcpURL)
	if err != nil {
		return nil, err
	}
	origin := mu.Scheme + "://" + mu.Host
	var pr struct {
		Resource string   `json:"resource"`
		AuthSrv  []string `json:"authorization_servers"`
		Scopes   []string `json:"scopes_supported"`
	}
	var perr error
	for _, p := range []string{"/.well-known/oauth-protected-resource" + strings.TrimRight(mu.Path, "/"), "/.well-known/oauth-protected-resource"} {
		if _, perr = getJSON(ctx, hc, origin+p, &pr); perr == nil {
			break
		}
	}
	issuer := origin
	if perr == nil && len(pr.AuthSrv) > 0 {
		issuer = strings.TrimRight(pr.AuthSrv[0], "/")
	}
	if _, err := okEndpoint(issuer); err != nil {
		return nil, err
	}
	iu, _ := url.Parse(issuer)
	var d Discovery
	var aerr error
	for _, p := range []string{"/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"} {
		d = Discovery{}
		if _, aerr = getJSON(ctx, hc, issuer+p+strings.TrimRight(iu.Path, "/"), &d); aerr == nil {
			break
		}
	}
	if aerr != nil {
		return nil, fmt.Errorf("linear: OAuth discovery failed: %v", aerr)
	}
	for _, e := range []string{d.AuthorizationEndpoint, d.TokenEndpoint} {
		if _, err := okEndpoint(e); err != nil {
			return nil, err
		}
	}
	if d.RegistrationEndpoint != "" {
		if _, err := okEndpoint(d.RegistrationEndpoint); err != nil {
			return nil, err
		}
	}
	if d.Issuer == "" {
		d.Issuer = issuer
	}
	d.Resource = mcpURL // the canonical resource (RFC 8707) is the MCP URL we call
	if len(d.Scopes) == 0 {
		d.Scopes = pr.Scopes
	}
	return &d, nil
}

// Register registers minbox as an OAuth client (RFC 7591) for one redirect URI.
func Register(ctx context.Context, hc *http.Client, d *Discovery, redirectURI string) (*Registration, error) {
	if d.RegistrationEndpoint == "" {
		return nil, errors.New("linear: the server offers no dynamic client registration")
	}
	body, _ := json.Marshal(map[string]any{
		"client_name": "minbox", "redirect_uris": []string{redirectURI},
		"grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"},
		"token_endpoint_auth_method": "none", "application_type": "web",
	})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, d.RegistrationEndpoint, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("linear: client registration failed: %v", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var out struct {
		ClientID string `json:"client_id"`
		Secret   string `json:"client_secret"`
		Method   string `json:"token_endpoint_auth_method"`
		Err      string `json:"error"`
		ErrDesc  string `json:"error_description"`
	}
	_ = json.Unmarshal(b, &out)
	if resp.StatusCode/100 != 2 || out.ClientID == "" {
		msg := oauthErrText(out.Err, out.ErrDesc)
		return nil, fmt.Errorf("linear: client registration refused (HTTP %d%s)", resp.StatusCode, msg)
	}
	m := out.Method
	if m == "" {
		m = "none"
		if out.Secret != "" {
			m = "client_secret_basic"
		}
	}
	return &Registration{ClientID: out.ClientID, ClientSecret: out.Secret, RedirectURI: redirectURI, AuthMethod: m}, nil
}

func oauthErrText(code, desc string) string {
	if code == "" {
		return ""
	}
	s := ": " + Truncate(code, 60)
	if desc != "" {
		s += " (" + Truncate(desc, 160) + ")"
	}
	return s
}

// NewPKCE returns a code verifier and its S256 challenge.
func NewPKCE() (verifier, challenge string) {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	verifier = base64.RawURLEncoding.EncodeToString(b)
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

// RandomState returns an unguessable state value.
func RandomState() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// AuthURL builds the authorization request URL.
func AuthURL(d *Discovery, reg *Registration, state, challenge, scope string) string {
	u, _ := url.Parse(d.AuthorizationEndpoint)
	q := u.Query()
	q.Set("response_type", "code")
	q.Set("client_id", reg.ClientID)
	q.Set("redirect_uri", reg.RedirectURI)
	q.Set("state", state)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	if scope != "" {
		q.Set("scope", scope)
	}
	if d.Resource != "" {
		q.Set("resource", d.Resource)
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func tokenRequest(ctx context.Context, hc *http.Client, d *Discovery, reg *Registration, form url.Values, now time.Time) (*Token, error) {
	if reg.ClientSecret != "" && reg.AuthMethod == "client_secret_post" {
		form.Set("client_secret", reg.ClientSecret)
	}
	form.Set("client_id", reg.ClientID)
	if d.Resource != "" {
		form.Set("resource", d.Resource)
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, d.TokenEndpoint, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	if reg.ClientSecret != "" && reg.AuthMethod != "client_secret_post" && reg.AuthMethod != "none" {
		req.SetBasicAuth(url.QueryEscape(reg.ClientID), url.QueryEscape(reg.ClientSecret))
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, errors.New("linear: token request failed: " + scrubURLErr(err))
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var out struct {
		Access  string `json:"access_token"`
		Refresh string `json:"refresh_token"`
		Expires int64  `json:"expires_in"`
		Scope   string `json:"scope"`
		Err     string `json:"error"`
		ErrDesc string `json:"error_description"`
	}
	_ = json.Unmarshal(b, &out)
	if out.Err == "invalid_grant" {
		return nil, ErrInvalidGrant
	}
	if resp.StatusCode/100 != 2 || out.Access == "" {
		// Only the OAuth error code and description: never the body as it is.
		return nil, fmt.Errorf("linear: token request refused (HTTP %d%s)", resp.StatusCode, oauthErrText(out.Err, out.ErrDesc))
	}
	t := &Token{Access: out.Access, Refresh: out.Refresh, Scope: out.Scope}
	if out.Expires > 0 {
		t.Expiry = now.Add(time.Duration(out.Expires) * time.Second)
	}
	return t, nil
}

func scrubURLErr(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Op + ": " + ue.Err.Error()
	}
	return err.Error()
}

// Exchange trades the authorization code for tokens.
func Exchange(ctx context.Context, hc *http.Client, d *Discovery, reg *Registration, code, verifier string, now time.Time) (*Token, error) {
	return tokenRequest(ctx, hc, d, reg, url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {reg.RedirectURI}, "code_verifier": {verifier},
	}, now)
}

// Refresh trades a refresh token for new tokens (the refresh token may rotate: keep the new one).
func Refresh(ctx context.Context, hc *http.Client, d *Discovery, reg *Registration, refresh string, now time.Time) (*Token, error) {
	t, err := tokenRequest(ctx, hc, d, reg, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}}, now)
	if err != nil {
		return nil, err
	}
	if t.Refresh == "" {
		t.Refresh = refresh
	}
	return t, nil
}
