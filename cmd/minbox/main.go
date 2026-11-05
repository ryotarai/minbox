// Command minbox: an inbox for Claude Code sessions, with their terminals.
//
//	minbox start         start the server as a daemon (and the terminal host, if none runs)
//	minbox stop          stop the server (sessions keep running in the terminal host)
//	minbox restart       stop it and start it again (same flags as the last start)
//	minbox status        whether the server runs, where, and its log
//	minbox host start    run the terminal host (the server starts it when none runs)
//	minbox host stop     stop the terminal host (every session's claude ends)
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ryotarai/minbox/internal/devices"
	"github.com/ryotarai/minbox/internal/hostauth"
	"github.com/ryotarai/minbox/internal/server"
	"github.com/ryotarai/minbox/internal/store"
	"github.com/ryotarai/minbox/internal/termhost"
	"github.com/ryotarai/minbox/plugin"
	"github.com/ryotarai/minbox/web"
)

func main() {
	args := os.Args[1:]
	cmd := "help"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	var err error
	switch cmd {
	case "start":
		err = startCmd(args)
	case "stop":
		err = stopCmd(args)
	case "restart":
		err = restartCmd(args)
	case "status":
		var code int
		code, err = statusCmd(args, os.Stdout)
		if err == nil && code != 0 {
			os.Exit(code)
		}
	case "serve": // the old name of `start --foreground`
		err = serve(args)
	case "host":
		err = hostCmd(args)
	case "pair":
		err = pairCmd(args, os.Stdout)
	case "help":
		fmt.Println(usage)
	default:
		err = fmt.Errorf("unknown command %q\n%s", cmd, usage)
	}
	if err != nil {
		var ee *exitError
		if errors.As(err, &ee) {
			fmt.Fprintln(os.Stderr, ee.msg)
			os.Exit(ee.code)
		}
		log.Fatal(err)
	}
}

const usage = `usage:
  minbox start [flags]                      start the server in the background (and the terminal host,
                                            if none runs); logs go to <data-dir>/minbox.log
  minbox start --foreground [flags]         run it in the foreground instead (logs on stderr)
  minbox stop [--data-dir <dir>]            stop the server; sessions keep running in the terminal host
  minbox restart [flags]                    stop it and start it again, with the flags of the last
                                            minbox start unless others are given
  minbox restart --host [--yes|-y] [flags]  also stop the local terminal host (every session's claude ends;
                                            the new server starts a fresh host and resumes them); asks
                                            first, unless --yes (refuses with exit 2 when stdin is no terminal)
  minbox status [--data-dir <dir>]          whether the server runs (exit 3 if not), its URL and log
  minbox start --listen 0.0.0.0:4848        serve other machines too; their browsers must be paired
                                            (minbox pair accept <code>)
  minbox start --tailscale [--tailscale-port 3125] [--tailscale-user-login <login>]   (default login: this machine's Tailscale user)
  minbox start --tailscale-service minbox [--tailscale-user-login <login>]   (as svc:minbox: https://minbox.<tailnet>.ts.net)
                                            also serve it on the tailnet through tailscale serve (HTTPS);
                                            browsers there must be paired (minbox pair accept <code>)
  minbox host start [--data-dir <dir>]      run the terminal host in the foreground
  minbox host --listen 0.0.0.0:4849 [--data-dir <dir>]
                                            run a host another machine's minbox server connects to (Direct)
  minbox host --tailscale [--tailscale-user-login <login>] [--port 4849] [--tailscale-port 14849] [--data-dir <dir>]
                                            the same, through tailscale serve (HTTPS on the tailnet);
                                            listens on 127.0.0.1 only and answers only that Tailscale user
  minbox host stop [--data-dir <dir>]       stop the terminal host; every session's claude ends
  minbox pair list [--data-dir <dir>]       servers waiting to be paired with this machine's host,
                                            and browsers waiting to be paired with this machine's server
  minbox pair accept <code> [--data-dir <dir>]
                                            let that server use this machine's host (or that browser
                                            use this machine's server)
  minbox pair reject <code> [--data-dir <dir>]
                                            turn that server (or browser) down`

func defaultDataDir() string {
	if d := os.Getenv("MINBOX_DATA_DIR"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".minbox"
	}
	return filepath.Join(home, ".minbox")
}

func hostStart(args []string) error {
	fs := flag.NewFlagSet("host start", flag.ExitOnError)
	dataDir := fs.String("data-dir", defaultDataDir(), "data directory")
	socket := fs.String("socket", "", "Unix socket to listen on (default: the data directory's)")
	listen := fs.String("listen", "", "serve another machine's minbox server over TCP at this address (Direct), e.g. 0.0.0.0:4849")
	tsServe := fs.Bool("tailscale", false, "serve it through tailscale serve (HTTPS on the tailnet); listen on 127.0.0.1 only")
	tsLogin := fs.String("tailscale-user-login", "", "with --tailscale: the Tailscale user (login) whose requests are answered (default: this machine's)")
	port := fs.Int("port", 4849, "with --tailscale: the local port")
	httpsPort := fs.Int("tailscale-port", server.HostTailscalePort, "with --tailscale: the tailnet HTTPS port (3125 is left to minbox start)")
	_ = fs.Parse(args)
	if *tsServe {
		if *tsLogin == "" {
			login, err := tailscaleSelfLogin()
			if err != nil {
				return err
			}
			*tsLogin = login
		}
		addr := fmt.Sprintf("127.0.0.1:%d", *port)
		return hostListen(addr, *dataDir, *tsLogin, func() error {
			if err := tailscaleServe(*port, *httpsPort); err != nil {
				return err
			}
			if n := tailscaleSelfName(); n != "" {
				fmt.Printf("host URL on the tailnet: https://%s:%d\n", n, *httpsPort)
			}
			return nil
		})
	}
	if *listen != "" {
		return hostListen(*listen, *dataDir, "", nil)
	}
	if *socket == "" {
		if err := os.MkdirAll(*dataDir, 0o700); err != nil {
			return err
		}
		*socket = socketPath(*dataDir)
	}
	// The host outlives the server: swallow the hangup of the terminal that
	// started it. Not signal.Ignore: an ignored signal stays ignored in the
	// processes the host starts, and Claude Code must still end on SIGHUP.
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	go func() {
		for range hup {
		}
	}()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return termhost.Serve(ctx, *socket)
}

// hostListen runs a host for another machine's server: requests must be
// signed by a server paired here (`minbox pair accept`); it has its own copy
// of the mod, and the relay its mods reach the server through. With a
// Tailscale login it answers only requests tailscale serve marks as that user.
func hostListen(addr, dataDir, tsLogin string, setup func() error) error {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	pluginDir, err := plugin.Extract(filepath.Join(dataDir, "plugin"))
	if err != nil {
		return fmt.Errorf("extract mod: %w", err)
	}
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	go func() {
		for range hup {
		}
	}()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return termhost.ServeRemote(ctx, termhost.RemoteOptions{
		Addr: addr, DataDir: dataDir, PluginDir: pluginDir, TailscaleLogin: tsLogin,
		ServerFile: filepath.Join(dataDir, "host-server.json"), Version: server.Version,
		Listening: func(a string) {
			fmt.Printf("minbox host listening on %s\n", a)
			if setup != nil {
				if err := setup(); err != nil {
					fmt.Printf("tailscale serve: %v\n", err)
				} else {
					fmt.Printf("served on the tailnet over HTTPS; answering only %s\n", tsLogin)
				}
			}
			fmt.Println("Add it in minbox (Settings › Hosts › Add host), then accept the pairing here: minbox pair accept <code>")
		},
	})
}

// tailscaleServe points tailscale serve (HTTPS on the tailnet) at the host.
// MINBOX_SKIP_TAILSCALE_SERVE=1 leaves tailscale alone (tests, or a setup of one's own).
func tailscaleServe(port, httpsPort int) error {
	if os.Getenv("MINBOX_SKIP_TAILSCALE_SERVE") == "1" {
		return nil
	}
	bin, err := exec.LookPath("tailscale")
	if err != nil {
		const mac = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
		if _, serr := os.Stat(mac); serr != nil {
			return errors.New("the tailscale CLI is not installed")
		}
		bin = mac
	}
	out, err := exec.Command(bin, "serve", "--bg", fmt.Sprintf("--https=%d", httpsPort), fmt.Sprintf("http://127.0.0.1:%d", port)).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// validServiceName: a Tailscale Service name is a DNS label.
func validServiceName(n string) bool {
	if n == "" || len(n) > 63 || n[0] == '-' || n[len(n)-1] == '-' {
		return false
	}
	for _, c := range n {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

// tailscaleServeService serves 127.0.0.1:port as the Tailscale Service
// svc:<name> on HTTPS 443 of the service's own address (not this machine's).
func tailscaleServeService(name string, port, httpsPort int) error {
	if os.Getenv("MINBOX_SKIP_TAILSCALE_SERVE") == "1" {
		return nil
	}
	bin, err := exec.LookPath("tailscale")
	if err != nil {
		const mac = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
		if _, serr := os.Stat(mac); serr != nil {
			return errors.New("the tailscale CLI is not installed")
		}
		bin = mac
	}
	out, err := exec.Command(bin, "serve", "--bg", "--service=svc:"+name, fmt.Sprintf("--https=%d", httpsPort), fmt.Sprintf("http://127.0.0.1:%d", port)).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s (is svc:%s defined in the Tailscale admin console, and this machine tagged and approved to host it?)", err, strings.TrimSpace(string(out)), name)
	}
	return nil
}

// tailscaleSelfLogin is the Tailscale user this machine is logged in as: the
// default --tailscale-user-login.
func tailscaleSelfLogin() (string, error) {
	if l := os.Getenv("MINBOX_TAILSCALE_LOGIN"); l != "" { // tests
		return l, nil
	}
	fail := func(why string) (string, error) {
		return "", fmt.Errorf("--tailscale: %s; pass --tailscale-user-login <login>", why)
	}
	bin, err := exec.LookPath("tailscale")
	if err != nil {
		const mac = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
		if _, serr := os.Stat(mac); serr != nil {
			return fail("the tailscale CLI is not installed")
		}
		bin = mac
	}
	b, err := exec.Command(bin, "status", "--json").Output()
	if err != nil {
		return fail("tailscale status failed (is Tailscale up?)")
	}
	var st struct {
		Self *struct {
			UserID int64 `json:"UserID"`
		} `json:"Self"`
		User map[string]struct {
			LoginName string `json:"LoginName"`
		} `json:"User"`
	}
	if json.Unmarshal(b, &st) != nil || st.Self == nil {
		return fail("could not read tailscale status")
	}
	login := st.User[strconv.FormatInt(st.Self.UserID, 10)].LoginName
	if login == "" || login == "tagged-devices" {
		return fail("this machine has no Tailscale user of its own (a tagged device?)")
	}
	return login, nil
}

// tailscaleSelfName is this machine's MagicDNS name ("" without tailscale).
func tailscaleSelfName() string {
	if n := os.Getenv("MINBOX_TAILSCALE_NAME"); n != "" { // tests, or a name of one's own
		return n
	}
	bin, err := exec.LookPath("tailscale")
	if err != nil {
		const mac = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
		if _, serr := os.Stat(mac); serr != nil {
			return ""
		}
		bin = mac
	}
	b, err := exec.Command(bin, "status", "--json").Output()
	if err != nil {
		return ""
	}
	var st struct {
		Self struct {
			DNSName string `json:"DNSName"`
		} `json:"Self"`
	}
	if json.Unmarshal(b, &st) != nil {
		return ""
	}
	return strings.TrimSuffix(st.Self.DNSName, ".")
}

// pairCmd: `minbox pair list|accept|reject` on the host's (or server's) machine.
func pairCmd(args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New(usage)
	}
	sub := args[0]
	fs := flag.NewFlagSet("pair "+sub, flag.ExitOnError)
	dataDir := fs.String("data-dir", defaultDataDir(), "the host's data directory")
	// The code may come before or after the flags.
	rest := args[1:]
	var code string
	if len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
		code, rest = rest[0], rest[1:]
	}
	_ = fs.Parse(rest)
	if code == "" && fs.NArg() > 0 {
		code = fs.Arg(0)
	}
	now := time.Now()
	switch sub {
	case "list":
		ps, err := hostauth.ListPairings(*dataDir, now)
		if err != nil {
			return err
		}
		bs, err := devices.Pending(*dataDir, now)
		if err != nil {
			return err
		}
		if len(ps) == 0 && len(bs) == 0 {
			fmt.Fprint(out, hostauth.FormatList(nil))
			return nil
		}
		if len(ps) > 0 {
			fmt.Fprint(out, hostauth.FormatList(ps))
		}
		fmt.Fprint(out, devices.FormatList(bs))
		return nil
	case "accept":
		if code == "" {
			return errors.New("usage: minbox pair accept <code>")
		}
		if devices.Exists(*dataDir, code) {
			r, _, err := devices.Accept(*dataDir, code, now)
			if err != nil {
				return err
			}
			fmt.Fprintf(out, "paired the browser %s (ecdsa-p256 %s): it can use this machine's minbox now\n", r.Name, r.Fingerprint)
			return nil
		}
		p, err := hostauth.Accept(*dataDir, code, now)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "paired %s (ed25519 %s): it can use this machine's host now\n", p.ServerName, p.Fingerprint)
		return nil
	case "reject":
		if code == "" {
			return errors.New("usage: minbox pair reject <code>")
		}
		if devices.Exists(*dataDir, code) {
			r, err := devices.Reject(*dataDir, code, now)
			if err != nil {
				return err
			}
			fmt.Fprintf(out, "rejected the browser %s (ecdsa-p256 %s)\n", r.Name, r.Fingerprint)
			return nil
		}
		p, err := hostauth.Reject(*dataDir, code, now)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "rejected %s (ed25519 %s)\n", p.ServerName, p.Fingerprint)
		return nil
	}
	return fmt.Errorf("unknown pair command %q\n%s", sub, usage)
}

func hostCmd(args []string) error {
	if len(args) > 0 && args[0] == "start" {
		return hostStart(args[1:])
	}
	if len(args) > 0 && strings.HasPrefix(args[0], "-") { // minbox host --listen …
		return hostStart(args)
	}
	if len(args) == 0 || args[0] != "stop" {
		return errors.New(usage)
	}
	fs := flag.NewFlagSet("host stop", flag.ExitOnError)
	dataDir := fs.String("data-dir", defaultDataDir(), "data directory")
	_ = fs.Parse(args[1:])
	sock := socketPath(*dataDir)
	pid, running, err := termhost.Stop(context.Background(), sock, server.ProtocolVersion, log.Printf)
	if err != nil {
		return err
	}
	if !running {
		fmt.Printf("no terminal host is running on %s\n", sock)
		return nil
	}
	fmt.Printf("stopped the terminal host (pid %d); the next minbox resumes the open sessions\n", pid)
	return nil
}

// serveFlags are the flags of `minbox start` (and its old name, serve).
type serveFlags struct {
	fs                                                   *flag.FlagSet
	addr, listen, dataDir, claudeCmd, tsService, tsLogin *string
	noOpen, tsServe, foreground                          *bool
	tsPort                                               *int
}

func newServeFlags(name string) *serveFlags {
	fs := flag.NewFlagSet(name, flag.ExitOnError)
	f := &serveFlags{fs: fs}
	f.foreground = fs.Bool("foreground", false, "run in the foreground (logs on stderr) instead of as a daemon")
	f.addr = fs.String("addr", "127.0.0.1:4848", "address to listen on (loopback only)")
	f.listen = fs.String("listen", "", "listen on this address instead, e.g. 0.0.0.0:4848; browsers from other machines must be paired (minbox pair accept <code>)")
	f.dataDir = fs.String("data-dir", defaultDataDir(), "data directory")
	f.claudeCmd = fs.String("claude", envOr("MINBOX_CLAUDE", "claude"), "command that starts Claude Code (split on spaces)")
	f.noOpen = fs.Bool("no-open", false, "do not open the browser")
	f.tsServe = fs.Bool("tailscale", false, "also serve minbox on the tailnet through tailscale serve (HTTPS); browsers there must be paired")
	f.tsService = fs.String("tailscale-service", "", "serve minbox as this Tailscale Service (svc:<name>, https://<name>.<tailnet>.ts.net) instead of on this machine's name; the service must be defined in the Tailscale admin console")
	f.tsPort = fs.Int("tailscale-port", 3125, "with --tailscale or --tailscale-service: the tailnet HTTPS port")
	f.tsLogin = fs.String("tailscale-user-login", "", "with --tailscale or --tailscale-service: answer only this Tailscale user (login) (default: this machine's)")
	return f
}

// serve runs the server in the foreground: `minbox start --foreground`.
func serve(args []string) error {
	f := newServeFlags("start")
	_ = f.fs.Parse(args)
	addr, listen, dataDir, claudeCmd, noOpen := f.addr, f.listen, f.dataDir, f.claudeCmd, f.noOpen
	tsServe, tsService, tsPort, tsLogin := f.tsServe, f.tsService, f.tsPort, f.tsLogin
	*tsService = strings.TrimPrefix(strings.TrimSpace(*tsService), "svc:")
	if *tsService != "" {
		if !validServiceName(*tsService) {
			return fmt.Errorf("--tailscale-service %q: use lowercase letters, digits and hyphens (e.g. minbox)", *tsService)
		}
		*tsServe = true // the same setup, served under the service's name
	}
	if *tsLogin != "" && !*tsServe {
		return errors.New("--tailscale-user-login goes with --tailscale or --tailscale-service")
	}
	if *tsPort < 1 || *tsPort > 65535 {
		return fmt.Errorf("--tailscale-port %d: not a port", *tsPort)
	}

	listenAny := false
	if *listen != "" {
		if *tsServe {
			return errors.New("--listen and --tailscale/--tailscale-service do not go together (tailscale serve needs minbox on 127.0.0.1)")
		}
		*addr = *listen
		listenAny = true
	}
	host, _, err := net.SplitHostPort(*addr)
	if err != nil {
		return err
	}
	if ip := net.ParseIP(host); !listenAny && host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return fmt.Errorf("refusing to listen on %s with --addr (loopback only); use --listen %s to serve other machines (they must pair)", *addr, *addr)
	}
	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		return err
	}
	st, err := store.Open(filepath.Join(*dataDir, "minbox.db"))
	if err != nil {
		return err
	}
	defer st.Close()
	pluginDir, err := plugin.Extract(filepath.Join(*dataDir, "plugin"))
	if err != nil {
		return fmt.Errorf("extract mod: %w", err)
	}

	cfg := server.Config{
		Addr:           *addr,
		DataDir:        *dataDir,
		ClaudeCommand:  strings.Fields(*claudeCmd),
		SuggestCommand: strings.Fields(os.Getenv("MINBOX_SUGGEST_COMMAND")),
		PluginDir:      pluginDir,
		ServerFile:     filepath.Join(*dataDir, "server.json"),
		ScratchDir:     filepath.Join(*dataDir, "scratch"),
		HostURL:        "unix://" + socketPath(*dataDir),
		ListenAny:      listenAny,
	}
	if *tsServe {
		if *tsLogin == "" {
			login, err := tailscaleSelfLogin()
			if err != nil {
				return err
			}
			*tsLogin = login
		}
		log.Printf("tailscale serve: answering only %s", *tsLogin)
		cfg.TailscaleLogin = *tsLogin
		if name := tailscaleSelfName(); name != "" {
			if *tsService != "" {
				// <service>.<tailnet suffix>
				_, suffix, _ := strings.Cut(name, ".")
				name = *tsService + "." + suffix
			}
			cfg.PublicHosts = []string{name}
		}
	}
	srv := server.New(cfg, st, web.FS())

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		return err
	}
	url := "http://" + ln.Addr().String()
	if listenAny {
		// This machine's mods and browser use loopback (trusted, no pairing).
		h, p, _ := net.SplitHostPort(ln.Addr().String())
		log.Printf("serving other machines on %s: their browsers must be paired (minbox pair accept <code>)", ln.Addr())
		if ip := net.ParseIP(h); ip != nil && ip.IsUnspecified() {
			url = "http://127.0.0.1:" + p
		}
	}
	if err := writeServerFile(cfg.ServerFile, url); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	exe, err := os.Executable()
	if err != nil {
		return err
	}
	socket := socketPath(*dataDir)
	connect := func(ctx context.Context) (*termhost.Client, error) {
		c, started, err := termhost.Ensure(ctx, socket, termhost.EnsureOptions{
			ServerVersion:      server.ProtocolVersion,
			ServerRequiresHost: server.RequiredHostVersion,
			Start: func() error {
				return termhost.StartDetached(exe, []string{"host", "start", "--socket", socket}, filepath.Join(*dataDir, "termhost.log"))
			},
			Logf: log.Printf,
		})
		if started {
			log.Printf("started a terminal host on %s", socket)
		}
		return c, err
	}
	if err := srv.RunHost(ctx, connect); err != nil {
		log.Printf("terminal host not ready yet: %v (retrying in the background)", err)
	}

	hs := &http.Server{Handler: srv, ReadHeaderTimeout: 10 * time.Second}
	hs.RegisterOnShutdown(srv.Close)
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = hs.Shutdown(sctx)
	}()
	log.Printf("minbox listening on %s (data in %s)", url, *dataDir)
	if *tsServe {
		_, port, _ := net.SplitHostPort(ln.Addr().String())
		p, _ := strconv.Atoi(port)
		serveErr := error(nil)
		if *tsService != "" {
			serveErr = tailscaleServeService(*tsService, p, *tsPort)
		} else {
			serveErr = tailscaleServe(p, *tsPort)
		}
		if err := serveErr; err != nil {
			log.Printf("tailscale serve: %v", err)
		} else if len(cfg.PublicHosts) > 0 {
			where := cfg.PublicHosts[0]
			if *tsPort != 443 {
				where = fmt.Sprintf("%s:%d", where, *tsPort)
			}
			log.Printf("on the tailnet: https://%s (browsers there pair first: minbox pair accept <code>)", where)
		} else {
			log.Printf("on the tailnet through tailscale serve (browsers there pair first: minbox pair accept <code>)")
		}
	}
	if !*noOpen {
		openBrowser(url)
	}
	if err := hs.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// socketPath is the terminal host's socket for a data directory. Unix socket
// paths are limited (104 bytes on macOS), so a long data directory gets a
// short path under /tmp, named after the directory.
func socketPath(dataDir string) string {
	p := filepath.Join(dataDir, "termhost.sock")
	if len(p) < 100 {
		return p
	}
	abs, _ := filepath.Abs(dataDir)
	sum := sha256.Sum256([]byte(abs))
	return filepath.Join("/tmp", fmt.Sprintf("minbox-%d-%s.sock", os.Getuid(), hex.EncodeToString(sum[:6])))
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func writeServerFile(path, url string) error {
	b, _ := json.Marshal(map[string]any{"url": url, "pid": os.Getpid()})
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	default:
		return
	}
	_ = cmd.Start()
}
