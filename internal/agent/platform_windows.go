package agent

import (
	"os"
	"os/exec"
)

func configureProcess(*exec.Cmd)                {}
func stopProcess(cmd *exec.Cmd, _ bool) error   { return cmd.Process.Kill() }
func preserveOwner(*os.File, os.FileInfo) error { return nil }
func ReloadSignal() os.Signal                   { return nil }
func commandEnvironment() []string              { return os.Environ() }
