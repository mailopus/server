package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	capCore = "urn:ietf:params:jmap:core"
	capMail = "urn:ietf:params:jmap:mail"
	capIMAP = "https://mailopus.net/jmap/imap"
)

var (
	errAuth    = errors.New("jmap: authentication failed")
	errLimited = errors.New("jmap: too many failed logins")
)

// MethodError is a JMAP method-level error (["error", {type}, id]).
type MethodError struct{ Type, Description string }

func (e *MethodError) Error() string { return "jmap: " + e.Type }

// Client talks JMAP over HTTPS to Mailopus as one app password. Requests carry Basic auth; Mailopus
// takes it on /jmap/* only.
type Client struct {
	base      string
	user      string
	pass      string
	ip        string // the mail app's address, for Mailopus's "last used from" (x-mailopus-client-ip)
	http      *http.Client
	AccountID string
}

var httpClient = &http.Client{Timeout: 60 * time.Second}

// Login checks the credentials by fetching the JMAP session. clientIP is the mail app's address: every
// request here comes from the proxy's own, so Mailopus is told the real one. "" sends none.
func Login(ctx context.Context, base, user, pass, clientIP string) (*Client, error) {
	c := &Client{base: strings.TrimRight(base, "/"), user: user, pass: pass, ip: clientIP, http: httpClient}
	req, err := c.request(ctx, http.MethodGet, "/jmap/session", nil, "")
	if err != nil {
		return nil, err
	}
	var s struct {
		PrimaryAccounts map[string]string `json:"primaryAccounts"`
		Capabilities    map[string]any    `json:"capabilities"`
	}
	if err := c.doJSON(req, &s); err != nil {
		return nil, err
	}
	if _, ok := s.Capabilities[capIMAP]; !ok {
		return nil, errors.New("jmap: server lacks the Mailopus IMAP capability (deploy the server changes first)")
	}
	c.AccountID = s.PrimaryAccounts[capMail]
	if c.AccountID == "" {
		return nil, errors.New("jmap: no mail account")
	}
	return c, nil
}

func (c *Client) request(ctx context.Context, method, path string, body io.Reader, contentType string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, body)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(c.user, c.pass)
	req.Header.Set("User-Agent", "mailopus-imap")
	// Mailopus believes this only next to a valid app password, and keeps just the /24 or /48.
	if c.ip != "" {
		req.Header.Set("X-Mailopus-Client-Ip", c.ip)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return req, nil
}

func (c *Client) do(req *http.Request) (*http.Response, error) {
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	switch {
	case res.StatusCode == http.StatusUnauthorized:
		res.Body.Close()
		return nil, errAuth
	case res.StatusCode == http.StatusTooManyRequests:
		res.Body.Close()
		return nil, errLimited
	case res.StatusCode >= 300:
		res.Body.Close()
		return nil, fmt.Errorf("jmap: %s %s: HTTP %d", req.Method, req.URL.Path, res.StatusCode)
	}
	return res, nil
}

func (c *Client) doJSON(req *http.Request, out any) error {
	res, err := c.do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	return json.NewDecoder(res.Body).Decode(out)
}

// Call is one method call in a request.
type Call struct {
	Name string
	Args map[string]any
	ID   string
}

func (c Call) MarshalJSON() ([]byte, error) { return json.Marshal([]any{c.Name, c.Args, c.ID}) }

// Calls sends one JMAP request and returns each response's arguments in order. A method error comes
// back as a *MethodError in errs at its index, so callers can tell which call failed.
func (c *Client) Calls(ctx context.Context, calls ...Call) ([]json.RawMessage, error) {
	for i := range calls {
		if calls[i].ID == "" {
			calls[i].ID = fmt.Sprint(i)
		}
		if calls[i].Args == nil {
			calls[i].Args = map[string]any{}
		}
		if _, ok := calls[i].Args["accountId"]; !ok {
			calls[i].Args["accountId"] = c.AccountID
		}
	}
	body, err := json.Marshal(map[string]any{"using": []string{capCore, capMail, capIMAP}, "methodCalls": calls})
	if err != nil {
		return nil, err
	}
	req, err := c.request(ctx, http.MethodPost, "/jmap/api", bytes.NewReader(body), "application/json")
	if err != nil {
		return nil, err
	}
	var r struct {
		MethodResponses [][3]json.RawMessage `json:"methodResponses"`
	}
	if err := c.doJSON(req, &r); err != nil {
		return nil, err
	}
	out := make([]json.RawMessage, 0, len(r.MethodResponses))
	for _, m := range r.MethodResponses {
		var name string
		json.Unmarshal(m[0], &name)
		if name == "error" {
			var e MethodError
			json.Unmarshal(m[1], &e)
			return nil, &e
		}
		out = append(out, m[1])
	}
	return out, nil
}

// Call1 sends one method call and decodes its response into out.
func (c *Client) Call1(ctx context.Context, name string, args map[string]any, out any) error {
	r, err := c.Calls(ctx, Call{Name: name, Args: args})
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(r[0], out)
}

// Upload stores a blob (RFC 8620 §6.1) and returns its id.
func (c *Client) Upload(ctx context.Context, data []byte) (string, error) {
	req, err := c.request(ctx, http.MethodPost, "/jmap/upload/"+url.PathEscape(c.AccountID)+"/", bytes.NewReader(data), "message/rfc822")
	if err != nil {
		return "", err
	}
	var r struct {
		BlobID string `json:"blobId"`
	}
	if err := c.doJSON(req, &r); err != nil {
		return "", err
	}
	return r.BlobID, nil
}

// Download fetches a blob; for an email id that's the raw message.
func (c *Client) Download(ctx context.Context, blobID string) ([]byte, error) {
	req, err := c.request(ctx, http.MethodGet, "/jmap/download/"+url.PathEscape(c.AccountID)+"/"+url.PathEscape(blobID)+"/m.eml", nil, "")
	if err != nil {
		return nil, err
	}
	res, err := c.do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	return io.ReadAll(io.LimitReader(res.Body, maxMessage+1))
}

// socketURL is the account's push WebSocket (/jmap/ws).
func (c *Client) socketURL() string {
	u := strings.Replace(strings.Replace(c.base, "https://", "wss://", 1), "http://", "ws://", 1)
	return u + "/jmap/ws?account=" + url.QueryEscape(c.AccountID)
}

func (c *Client) authHeader() http.Header {
	req, _ := http.NewRequest(http.MethodGet, c.base, nil)
	req.SetBasicAuth(c.user, c.pass)
	h := http.Header{"Authorization": req.Header["Authorization"], "User-Agent": {"mailopus-imap"}}
	// As in request: without it the push socket would record the proxy's own network as last used.
	if c.ip != "" {
		h.Set("X-Mailopus-Client-Ip", c.ip)
	}
	return h
}
