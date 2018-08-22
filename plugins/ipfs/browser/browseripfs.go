package main

import (
	"context"
	"fmt"
	"io"
	"io/ioutil"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ipfs/iptb/plugins/ipfs"
	"github.com/ipfs/iptb/testbed/interfaces"
	"github.com/ipfs/iptb/util"

	"github.com/ipfs/go-cid"
	config "github.com/ipfs/go-ipfs-config"
	serial "github.com/ipfs/go-ipfs-config/serialize"
	"github.com/multiformats/go-multiaddr"
	"github.com/pkg/errors"
)

var errTimeout = errors.New("timeout")

var PluginName = "browseripfs"

type BrowserIpfs struct {
	dir         string
	peerid      *cid.Cid
	repobuilder string
	apiaddr     multiaddr.Multiaddr
	swarmaddr   multiaddr.Multiaddr
	source      string
}

var NewNode testbedi.NewNodeFunc
var GetAttrDesc testbedi.GetAttrDescFunc
var GetAttrList testbedi.GetAttrListFunc

func init() {
	NewNode = func(dir string, attrs map[string]string) (testbedi.Core, error) {
		if _, err := exec.LookPath("ipfs"); err != nil {
			return nil, err
		}

		if _, err := exec.LookPath("node"); err != nil {
			return nil, err
		}

		apiaddr, err := multiaddr.NewMultiaddr("/ip4/127.0.0.1/tcp/0")
		if err != nil {
			return nil, err
		}

		swarmaddr, err := multiaddr.NewMultiaddr("/ip4/127.0.0.1/tcp/0")
		if err != nil {
			return nil, err
		}

		if apiaddrstr, ok := attrs["apiaddr"]; ok {
			var err error
			apiaddr, err = multiaddr.NewMultiaddr(apiaddrstr)

			if err != nil {
				return nil, err
			}
		}

		if swarmaddrstr, ok := attrs["swarmaddr"]; ok {
			var err error
			swarmaddr, err = multiaddr.NewMultiaddr(swarmaddrstr)

			if err != nil {
				return nil, err
			}
		}

		var repobuilder string
		if v, ok := attrs["repobuilder"]; ok {
			repobuilder = v
		} else {
			jsipfspath, err := exec.LookPath("jsipfs")
			if err != nil {
				return nil, fmt.Errorf("No `repobuilder` provided, could not find jsipfs in path")
			}

			repobuilder = jsipfspath
		}

		var source string
		if v, ok := attrs["source"]; ok {
			source = v
		} else {
			return nil, fmt.Errorf("No `source` provided")
		}

		return &BrowserIpfs{
			dir:         dir,
			apiaddr:     apiaddr,
			swarmaddr:   swarmaddr,
			repobuilder: repobuilder,
			source:      source,
		}, nil

	}

	GetAttrList = func() []string {
		return []string{}
	}

	GetAttrDesc = func(attr string) (string, error) {
		return "", nil
	}

}

/// TestbedNode Interface

func (l *BrowserIpfs) Init(ctx context.Context, agrs ...string) (testbedi.Output, error) {
	agrs = append([]string{l.repobuilder, "init"}, agrs...)
	output, oerr := l.RunCmd(ctx, nil, agrs...)
	if oerr != nil {
		return nil, oerr
	}

	icfg, err := l.Config()
	if err != nil {
		return nil, err
	}

	lcfg, ok := icfg.(*config.Config)
	if !ok {
		return nil, fmt.Errorf("Error: Config() is not an ipfs config")
	}

	lcfg.Bootstrap = []string{}
	lcfg.Addresses.Swarm = []string{l.swarmaddr.String()}
	lcfg.Addresses.API = l.apiaddr.String()
	lcfg.Addresses.Gateway = ""
	lcfg.Discovery.MDNS.Enabled = false

	err = l.WriteConfig(lcfg)
	if err != nil {
		return nil, err
	}

	return output, oerr
}

func (l *BrowserIpfs) Start(ctx context.Context, wait bool, args ...string) (testbedi.Output, error) {
	var err error

	dir := l.dir
	cmd := exec.Command("node", l.source)
	cmd.Dir = dir

	cmd.Env, err = l.env()
	if err != nil {
		return nil, err
	}

	stdout, err := os.Create(filepath.Join(dir, "daemon.stdout"))
	if err != nil {
		return nil, err
	}

	stderr, err := os.Create(filepath.Join(dir, "daemon.stderr"))
	if err != nil {
		return nil, err
	}

	cmd.Stdout = stdout
	cmd.Stderr = stderr

	err = cmd.Start()
	if err != nil {
		return nil, err
	}

	pid := cmd.Process.Pid

	err = ioutil.WriteFile(filepath.Join(dir, "daemon.pid"), []byte(fmt.Sprint(pid)), 0666)
	if err != nil {
		return nil, err
	}

	if wait {
		return nil, ipfs.WaitOnAPI(l)
	}

	return nil, nil
}

func (l *BrowserIpfs) Stop(ctx context.Context) error {
	pid, err := l.getPID()
	if err != nil {
		return fmt.Errorf("error killing daemon %s: %s", l.dir, err)
	}

	p, err := os.FindProcess(pid)
	if err != nil {
		return fmt.Errorf("error killing daemon %s: %s", l.dir, err)
	}

	waitch := make(chan struct{}, 1)
	go func() {
		p.Wait()
		waitch <- struct{}{}
	}()

	defer func() {
		err := os.Remove(filepath.Join(l.dir, "daemon.pid"))
		if err != nil && !os.IsNotExist(err) {
			panic(fmt.Errorf("error removing pid file for daemon at %s: %s", l.dir, err))
		}
	}()

	if err := l.signalAndWait(p, waitch, syscall.SIGINT, 1*time.Second); err != errTimeout {
		return err
	}

	if err := l.signalAndWait(p, waitch, syscall.SIGTERM, 2*time.Second); err != errTimeout {
		return err
	}

	if err := l.signalAndWait(p, waitch, syscall.SIGQUIT, 5*time.Second); err != errTimeout {
		return err
	}

	if err := l.signalAndWait(p, waitch, syscall.SIGKILL, 5*time.Second); err != errTimeout {
		return err
	}

	return fmt.Errorf("Could not stop browseripfs node with pid %d", pid)
}

func (l *BrowserIpfs) RunCmd(ctx context.Context, stdin io.Reader, args ...string) (testbedi.Output, error) {
	env, err := l.env()

	if err != nil {
		return nil, fmt.Errorf("error getting env: %s", err)
	}

	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	cmd.Env = env
	cmd.Stdin = stdin

	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}

	err = cmd.Start()
	if err != nil {
		return nil, err
	}

	stderrbytes, err := ioutil.ReadAll(stderr)
	if err != nil {
		return nil, err
	}

	stdoutbytes, err := ioutil.ReadAll(stdout)
	if err != nil {
		return nil, err
	}

	if err != nil {
		return nil, err
	}

	exiterr := cmd.Wait()

	var exitcode = 0
	switch oerr := exiterr.(type) {
	case *exec.ExitError:
		if ctx.Err() == context.DeadlineExceeded {
			err = errors.Wrapf(oerr, "context deadline exceeded for command: %q", strings.Join(cmd.Args, " "))
		}

		exitcode = 1
	case nil:
		err = oerr
	}

	return iptbutil.NewOutput(args, stdoutbytes, stderrbytes, exitcode, err), nil
}

func (l *BrowserIpfs) Connect(ctx context.Context, tbn testbedi.Core) error {
	swarmaddrs, err := tbn.SwarmAddrs()
	if err != nil {
		return err
	}

	for _, addr := range swarmaddrs {
		output, err := l.RunCmd(ctx, nil, "ipfs", "swarm", "connect", addr)

		if err != nil {
			return err
		}

		if output.ExitCode() == 0 {
			return nil
		}
	}

	return fmt.Errorf("Could not connect using any address")
}

func (l *BrowserIpfs) Shell(ctx context.Context, nodes []testbedi.Core) error {
	shell := os.Getenv("SHELL")
	if shell == "" {
		return fmt.Errorf("no shell found")
	}

	if len(os.Getenv("IPFS_PATH")) != 0 {
		// If the users shell sets IPFS_PATH, it will just be overridden by the shell again
		return fmt.Errorf("shell has IPFS_PATH set, please unset before trying to use iptb shell")
	}

	nenvs, err := l.env()
	if err != nil {
		return err
	}

	// TODO(tperson): It would be great if we could guarantee that the shell
	// is using the same binary. However, the users shell may prepend anything
	// we change in the PATH

	for i, n := range nodes {
		peerid, err := n.PeerID()

		if err != nil {
			return err
		}

		nenvs = append(nenvs, fmt.Sprintf("NODE%d=%s", i, peerid))
	}

	return syscall.Exec(shell, []string{shell}, nenvs)
}

func (l *BrowserIpfs) String() string {
	pcid, err := l.PeerID()
	if err != nil {
		return fmt.Sprintf("%s", l.Type())
	}
	return fmt.Sprintf("%s", pcid[0:12])
}

func (l *BrowserIpfs) APIAddr() (string, error) {
	return ipfs.GetAPIAddrFromRepo(l.dir)
}

func (l *BrowserIpfs) SwarmAddrs() ([]string, error) {
	return ipfs.SwarmAddrs(l)
}

func (l *BrowserIpfs) Dir() string {
	return l.dir
}

func (l *BrowserIpfs) PeerID() (string, error) {
	if l.peerid != nil {
		return l.peerid.String(), nil
	}

	var err error
	l.peerid, err = ipfs.GetPeerID(l)

	if err != nil {
		return "", err
	}

	return l.peerid.String(), nil
}

func (l *BrowserIpfs) Config() (interface{}, error) {
	return serial.Load(filepath.Join(l.dir, "config"))
}

func (l *BrowserIpfs) WriteConfig(cfg interface{}) error {
	return serial.WriteConfigFile(filepath.Join(l.dir, "config"), cfg)
}

func (l *BrowserIpfs) Type() string {
	return "browseripfs"
}

func (l *BrowserIpfs) signalAndWait(p *os.Process, waitch <-chan struct{}, signal os.Signal, t time.Duration) error {
	err := p.Signal(signal)
	if err != nil {
		return fmt.Errorf("error killing daemon %s: %s", l.dir, err)
	}

	select {
	case <-waitch:
		return nil
	case <-time.After(t):
		return errTimeout
	}
}

func (l *BrowserIpfs) getPID() (int, error) {
	b, err := ioutil.ReadFile(filepath.Join(l.dir, "daemon.pid"))
	if err != nil {
		return -1, err
	}

	return strconv.Atoi(string(b))
}

func (l *BrowserIpfs) env() ([]string, error) {
	envs := os.Environ()
	ipfspath := "IPFS_PATH=" + l.dir

	for i, e := range envs {
		if strings.HasPrefix(e, "IPFS_PATH=") {
			envs[i] = ipfspath
			return envs, nil
		}
	}
	return append(envs, ipfspath), nil
}