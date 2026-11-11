package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"sync"
	"time"
)

var errLocked = errors.New("locked out")

const (
	maxFails      = 5
	failWindow    = 15 * time.Minute
	lockFor       = 15 * time.Minute
	maxConnsPerIP = 20
	// Each connection can buffer a 25 MB message, so the total is capped too.
	maxConns = 400
	// Past this many tracked addresses, stale failure records are swept.
	sweepAt = 1000
	// An address that signed in this recently isn't locked out by failures: it holds a real password, and
	// one stale password among its devices would otherwise lock all of them out. Mailopus still rate-limits
	// failures per username, so this doesn't open up guessing.
	trustFor = 24 * time.Hour
)

// client is what the limits count: an IPv4 address, or an IPv6 /64, since one host there has a whole
// /64 to rotate through.
func client(ip string) string {
	p := net.ParseIP(ip)
	if p == nil || p.To4() != nil {
		return ip
	}
	return p.Mask(net.CIDRMask(64, 128)).String()
}

var failDelay = time.Second

// Limiter is the per-IP login lockout and connection cap. There's no per-username lockout on
// purpose: anyone could then lock you out of your own mail by guessing wrong.
type Limiter struct {
	mu     sync.Mutex
	now    func() time.Time
	fails  map[string][]time.Time
	locked map[string]time.Time
	good   map[string]time.Time
	conns  map[string]int
	total  int
}

func NewLimiter() *Limiter {
	return &Limiter{now: time.Now, fails: map[string][]time.Time{}, locked: map[string]time.Time{}, good: map[string]time.Time{}, conns: map[string]int{}}
}

func (l *Limiter) Allowed(ip string) bool {
	ip = client(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	until, ok := l.locked[ip]
	if ok && l.now().Before(until) {
		return false
	}
	delete(l.locked, ip)
	return true
}

// Succeeded records a good login, which exempts that address from lockout for trustFor.
func (l *Limiter) Succeeded(ip string) {
	ip = client(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.good) > sweepAt {
		for k, t := range l.good {
			if l.now().Sub(t) >= trustFor {
				delete(l.good, k)
			}
		}
	}
	l.good[ip] = l.now()
	delete(l.fails, ip)
	delete(l.locked, ip)
}

func (l *Limiter) Fail(ip string) {
	ip = client(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if t, ok := l.good[ip]; ok && now.Sub(t) < trustFor {
		return
	}
	if len(l.fails) > sweepAt {
		for k, ts := range l.fails {
			if now.Sub(ts[len(ts)-1]) >= failWindow {
				delete(l.fails, k)
			}
		}
	}
	recent := l.fails[ip][:0]
	for _, t := range l.fails[ip] {
		if now.Sub(t) < failWindow {
			recent = append(recent, t)
		}
	}
	recent = append(recent, now)
	if len(recent) >= maxFails {
		l.locked[ip] = now.Add(lockFor)
		delete(l.fails, ip)
		return
	}
	l.fails[ip] = recent
}

func (l *Limiter) acquire(ip string) bool {
	ip = client(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.conns[ip] >= maxConnsPerIP || l.total >= maxConns {
		return false
	}
	l.conns[ip]++
	l.total++
	return true
}

func (l *Limiter) release(ip string) {
	ip = client(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	l.total--
	if l.conns[ip]--; l.conns[ip] <= 0 {
		delete(l.conns, ip)
	}
}

// Listener closes connections over the per-IP cap before any protocol starts.
func (l *Limiter) Listener(inner net.Listener) net.Listener { return &capListener{inner, l} }

type capListener struct {
	net.Listener
	l *Limiter
}

func (cl *capListener) Accept() (net.Conn, error) {
	for {
		c, err := cl.Listener.Accept()
		if err != nil {
			return nil, err
		}
		ip, _, _ := net.SplitHostPort(c.RemoteAddr().String())
		if cl.l.acquire(ip) {
			return &capConn{Conn: c, release: func() { cl.l.release(ip) }}, nil
		}
		c.Close()
	}
}

type capConn struct {
	net.Conn
	once    sync.Once
	release func()
}

func (c *capConn) Close() error {
	c.once.Do(c.release)
	return c.Conn.Close()
}

// fingerprint is enough of a password's SHA-256 to tell two apart in the log ("is this the same password
// that worked a minute ago?") and far too little to help anyone guess it.
func fingerprint(password string) string {
	h := sha256.Sum256([]byte(password))
	return hex.EncodeToString(h[:3])
}
