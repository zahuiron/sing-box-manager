package agent

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
)

func configureProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}

func stopProcess(cmd *exec.Cmd, force bool) error {
	signal := syscall.SIGTERM
	if force {
		signal = syscall.SIGKILL
	}
	err := syscall.Kill(-cmd.Process.Pid, signal)
	if err == syscall.ESRCH {
		return nil
	}
	return err
}

func preserveOwner(f *os.File, info os.FileInfo) error {
	stat := info.Sys().(*syscall.Stat_t)
	return f.Chown(int(stat.Uid), int(stat.Gid))
}

func ReloadSignal() os.Signal { return syscall.SIGHUP }

func commandEnvironment() []string {
	env := make([]string, 0, len(os.Environ())+2)
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "LANG=") && !strings.HasPrefix(entry, "LC_ALL=") && !strings.HasPrefix(entry, "AGENT_TOKEN=") {
			env = append(env, entry)
		}
	}
	return append(env, "LANG=C", "LC_ALL=C")
}
