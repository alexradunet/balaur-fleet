package main

// Samsung (Tizen) TV control over the TV's local API:
//   - :8001 REST    device info (power state) and launching apps
//   - :8002 wss     remote-control keys; the TV asks once to allow "Duet",
//                   then hands out a token that is kept in the state directory
//   - Wake-on-LAN   power on from fully off (needs "Power On with Mobile")

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

type TVApp struct {
	Name string `json:"name"`
	ID   string `json:"id"`
	Icon string `json:"icon"`
}

type TVConfig struct {
	Host string  `json:"host"`
	MAC  string  `json:"mac"`
	Name string  `json:"name"`
	Apps []TVApp `json:"apps"`
}

// TVStatus is what /api/status reports under "tv".
type TVStatus struct {
	Name  string  `json:"name"`
	Power string  `json:"power"` // "on", "standby" or "off" (unreachable)
	Apps  []TVApp `json:"apps"`
}

type tv struct {
	cfg       TVConfig
	tokenFile string
	http      *http.Client

	mu      sync.Mutex
	power   string
	checked time.Time

	wsMu sync.Mutex // one remote connection, serialised writes
	ws   *wsConn
}

func newTV(cfg *TVConfig) *tv {
	if cfg == nil || cfg.Host == "" {
		return nil
	}
	dir := os.Getenv("STATE_DIRECTORY") // systemd StateDirectory=
	if dir == "" {
		dir = os.TempDir()
	}
	return &tv{
		cfg:       *cfg,
		tokenFile: filepath.Join(dir, "tv-token"),
		http:      &http.Client{Timeout: 3 * time.Second},
		power:     "off",
	}
}

// Status is cached for two seconds: every open dashboard polls it.
func (t *tv) Status() *TVStatus {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if time.Since(t.checked) > 2*time.Second {
		t.power = t.queryPower()
		t.checked = time.Now()
	}
	return &TVStatus{Name: t.cfg.Name, Power: t.power, Apps: t.cfg.Apps}
}

func (t *tv) invalidate() {
	t.mu.Lock()
	t.checked = time.Time{}
	t.mu.Unlock()
}

func (t *tv) queryPower() string {
	c := http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := c.Get("http://" + t.cfg.Host + ":8001/api/v2/")
	if err != nil {
		return "off"
	}
	defer resp.Body.Close()
	var info struct {
		Device struct {
			PowerState string `json:"PowerState"`
		} `json:"device"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&info) != nil {
		return "off"
	}
	if info.Device.PowerState == "" {
		return "on" // older firmware doesn't report it; answering means on
	}
	return info.Device.PowerState
}

// Power turns the TV on or off. "standby" means the screen is off but the
// network side is up: the power key wakes it faster than Wake-on-LAN.
func (t *tv) Power(on bool) error {
	defer t.invalidate()
	state := t.queryPower()
	switch {
	case on && state == "on", !on && state != "on":
		return nil
	case on && state == "off":
		return t.wake()
	default:
		return t.Key("KEY_POWER")
	}
}

func (t *tv) Launch(id string) error {
	ok := false
	for _, a := range t.cfg.Apps {
		ok = ok || a.ID == id
	}
	if !ok {
		return fmt.Errorf("unknown app %q", id)
	}
	defer t.invalidate()
	// Launching on a sleeping TV: switch it on and wait until it can take it.
	if t.queryPower() != "on" {
		if err := t.Power(true); err != nil {
			return err
		}
		for i := 0; t.queryPower() != "on"; i++ {
			if i == 20 {
				return errors.New("the TV did not turn on")
			}
			time.Sleep(time.Second)
		}
		time.Sleep(2 * time.Second) // home screen still loading right after power-on
	}
	resp, err := t.http.Post("http://"+t.cfg.Host+":8001/api/v2/applications/"+url.PathEscape(id), "application/json", nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("TV answered %s", resp.Status)
	}
	return nil
}

var keyName = regexp.MustCompile(`^KEY_[A-Z0-9_]{1,24}$`)

func (t *tv) Key(key string) error {
	if !keyName.MatchString(key) {
		return fmt.Errorf("bad key %q", key)
	}
	msg, _ := json.Marshal(map[string]any{
		"method": "ms.remote.control",
		"params": map[string]string{"Cmd": "Click", "DataOfCmd": key, "Option": "false", "TypeOfRemote": "SendRemoteKey"},
	})
	t.wsMu.Lock()
	defer t.wsMu.Unlock()
	for attempt := 0; attempt < 2; attempt++ {
		if t.ws == nil || t.ws.closed() {
			c, err := t.dialRemote()
			if err != nil {
				return err
			}
			t.ws = c
		}
		if err := t.ws.writeText(msg); err == nil {
			return nil
		}
		t.ws.close() // stale connection (TV went to standby): redial once
		t.ws = nil
	}
	return errors.New("TV remote connection failed")
}

// dialRemote opens the remote-control channel. Without a valid token the TV
// shows an "allow Duet?" prompt; the answer arrives as the first event.
func (t *tv) dialRemote() (*wsConn, error) {
	token, _ := os.ReadFile(t.tokenFile)
	q := url.Values{"name": {base64.StdEncoding.EncodeToString([]byte("Duet"))}}
	if tok := strings.TrimSpace(string(token)); tok != "" {
		q.Set("token", tok)
	}
	c, err := dialWS(t.cfg.Host+":8002", "/api/v2/channels/samsung.remote.control?"+q.Encode())
	if err != nil {
		return nil, err
	}
	c.conn.SetReadDeadline(time.Now().Add(30 * time.Second)) // time to answer the prompt
	first, err := c.readText()
	if err != nil {
		c.close()
		return nil, fmt.Errorf("TV did not answer (accept the prompt on the TV): %w", err)
	}
	var ev struct {
		Event string `json:"event"`
		Data  struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	_ = json.Unmarshal(first, &ev)
	if ev.Event != "ms.channel.connect" {
		c.close()
		if ev.Event == "ms.channel.timeOut" {
			return nil, errors.New(`nobody answered "Allow Duet?" on the TV in time: try again and choose Allow`)
		}
		if ev.Event == "ms.channel.unauthorized" {
			return nil, errors.New("TV refused the connection: allow Duet under Settings → General → External Device Manager → Device Connection Manager")
		}
		return nil, fmt.Errorf("TV answered %q", ev.Event)
	}
	if ev.Data.Token != "" && ev.Data.Token != strings.TrimSpace(string(token)) {
		if err := os.WriteFile(t.tokenFile, []byte(ev.Data.Token), 0o600); err != nil {
			log.Printf("tv: saving token: %v", err)
		}
	}
	c.conn.SetReadDeadline(time.Time{})
	go c.drain()
	return c, nil
}

// wake sends a Wake-on-LAN magic packet to the LAN broadcast addresses.
func (t *tv) wake() error {
	mac, err := net.ParseMAC(t.cfg.MAC)
	if err != nil || len(mac) != 6 {
		return errors.New("the TV is off and no MAC address is configured for Wake-on-LAN (duet.tv.mac)")
	}
	pkt := make([]byte, 0, 102)
	pkt = append(pkt, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)
	for i := 0; i < 16; i++ {
		pkt = append(pkt, mac...)
	}
	lc := net.ListenConfig{Control: func(_, _ string, rc syscall.RawConn) error {
		var serr error
		err := rc.Control(func(fd uintptr) { serr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_BROADCAST, 1) })
		if err != nil {
			return err
		}
		return serr
	}}
	pc, err := lc.ListenPacket(context.Background(), "udp4", ":0")
	if err != nil {
		return err
	}
	defer pc.Close()
	targets := []string{"255.255.255.255:9"}
	// The subnet broadcast of the TV's /24 too: some Wi-Fi drivers drop 255.255.255.255.
	if ip := net.ParseIP(t.cfg.Host).To4(); ip != nil {
		targets = append(targets, fmt.Sprintf("%d.%d.%d.255:9", ip[0], ip[1], ip[2]))
	}
	var sent bool
	for i := 0; i < 3; i++ {
		for _, a := range targets {
			addr, _ := net.ResolveUDPAddr("udp4", a)
			if _, err := pc.WriteTo(pkt, addr); err == nil {
				sent = true
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !sent {
		return errors.New("could not send the Wake-on-LAN packet")
	}
	return nil
}

func (t *tv) register(mux *http.ServeMux) {
	handle := func(path string, do func(body map[string]any) error) {
		mux.HandleFunc("POST "+path, func(w http.ResponseWriter, r *http.Request) {
			if !sameOrigin(r) {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			body := map[string]any{}
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			if err := do(body); err != nil {
				log.Printf("tv %s: %v", path, err)
				http.Error(w, err.Error(), http.StatusBadGateway)
				return
			}
			writeJSON(w, t.Status())
		})
	}
	str := func(b map[string]any, k string) string { s, _ := b[k].(string); return s }
	handle("/api/tv/power", func(b map[string]any) error { on, _ := b["on"].(bool); return t.Power(on) })
	handle("/api/tv/key", func(b map[string]any) error { return t.Key(str(b, "key")) })
	handle("/api/tv/launch", func(b map[string]any) error { return t.Launch(str(b, "id")) })
}

// ---- minimal WebSocket client (RFC 6455): text frames out, drained in ----

type wsConn struct {
	conn net.Conn
	r    *bufio.Reader
	wmu  sync.Mutex
	done chan struct{}
	once sync.Once
}

func dialWS(hostport, path string) (*wsConn, error) {
	d := &net.Dialer{Timeout: 3 * time.Second}
	// The TV's certificate is self-signed by Samsung; this is the LAN, by IP.
	conn, err := tls.DialWithDialer(d, "tcp", hostport, &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		return nil, err
	}
	key := make([]byte, 16)
	_, _ = rand.Read(key)
	req := "GET " + path + " HTTP/1.1\r\nHost: " + hostport + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + base64.StdEncoding.EncodeToString(key) + "\r\nSec-WebSocket-Version: 13\r\n\r\n"
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.WriteString(conn, req); err != nil {
		conn.Close()
		return nil, err
	}
	r := bufio.NewReader(conn)
	resp, err := http.ReadResponse(r, nil)
	if err != nil {
		conn.Close()
		return nil, err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		conn.Close()
		return nil, fmt.Errorf("websocket upgrade: %s", resp.Status)
	}
	conn.SetDeadline(time.Time{})
	return &wsConn{conn: conn, r: r, done: make(chan struct{})}, nil
}

func (c *wsConn) writeFrame(op byte, payload []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	hdr := []byte{0x80 | op}
	switch n := len(payload); {
	case n < 126:
		hdr = append(hdr, 0x80|byte(n))
	case n < 1<<16:
		hdr = append(hdr, 0x80|126, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, 0x80|127)
		hdr = binary.BigEndian.AppendUint64(hdr, uint64(n))
	}
	mask := make([]byte, 4)
	_, _ = rand.Read(mask)
	hdr = append(hdr, mask...)
	masked := make([]byte, len(payload))
	for i, b := range payload {
		masked[i] = b ^ mask[i%4]
	}
	c.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	_, err := c.conn.Write(append(hdr, masked...))
	return err
}

func (c *wsConn) writeText(p []byte) error { return c.writeFrame(0x1, p) }

// readText returns the next text message, answering pings on the way.
func (c *wsConn) readText() ([]byte, error) {
	for {
		var h [2]byte
		if _, err := io.ReadFull(c.r, h[:]); err != nil {
			return nil, err
		}
		op, n := h[0]&0x0f, uint64(h[1]&0x7f)
		switch n {
		case 126:
			var b [2]byte
			if _, err := io.ReadFull(c.r, b[:]); err != nil {
				return nil, err
			}
			n = uint64(binary.BigEndian.Uint16(b[:]))
		case 127:
			var b [8]byte
			if _, err := io.ReadFull(c.r, b[:]); err != nil {
				return nil, err
			}
			n = binary.BigEndian.Uint64(b[:])
		}
		if n > 1<<20 {
			return nil, errors.New("websocket frame too large")
		}
		var mask [4]byte
		if h[1]&0x80 != 0 {
			if _, err := io.ReadFull(c.r, mask[:]); err != nil {
				return nil, err
			}
		}
		p := make([]byte, n)
		if _, err := io.ReadFull(c.r, p); err != nil {
			return nil, err
		}
		if h[1]&0x80 != 0 {
			for i := range p {
				p[i] ^= mask[i%4]
			}
		}
		switch op {
		case 0x1, 0x2:
			return p, nil
		case 0x8:
			return nil, io.EOF
		case 0x9:
			_ = c.writeFrame(0xA, p)
		}
	}
}

// drain discards the TV's events and notices when the connection dies.
func (c *wsConn) drain() {
	for {
		if _, err := c.readText(); err != nil {
			c.close()
			return
		}
	}
}

func (c *wsConn) close() {
	c.once.Do(func() { close(c.done); c.conn.Close() })
}

func (c *wsConn) closed() bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}
