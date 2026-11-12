// Package hostexec runs an operator-configured command on the host: a backup
// script before a migration, a scheduled job. It exists so those two share one
// careful implementation.
package hostexec

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// killWait is how long a command that ignores cancellation gets before its
// output pipes are forcibly closed.
const killWait = 5 * time.Second

// Run runs argv without a shell, in dir (empty means the agent's), with the
// agent's environment minus every KEELSON_* variable (they hold its secrets)
// plus extraEnv. Each line of combined stdout and stderr goes to out. The
// command and every process it started are killed when ctx ends.
func Run(ctx context.Context, argv []string, dir string, extraEnv []string, out func(line string)) error {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Env = append(withoutKeelsonVars(os.Environ()), extraEnv...)
	cmd.WaitDelay = killWait
	// Its own process group, so that cancelling takes the whole tree down: a script's `sleep 300 &` or a worker
	// the command forked would otherwise outlive the timeout, keep running unsupervised and hold the output pipe.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		// The group's id is the child's pid (Setpgid with Pgid 0).
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}

	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw // one writer: os/exec then copies both streams with a single goroutine
	scanned := make(chan struct{})
	go func() {
		defer close(scanned)
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			out(sc.Text())
		}
		_, _ = io.Copy(io.Discard, pr) // never leave the command blocked on a full pipe
	}()

	err := cmd.Run()
	pw.Close()
	<-scanned
	return err
}

func withoutKeelsonVars(env []string) []string {
	out := make([]string, 0, len(env))
	for _, e := range env {
		if !strings.HasPrefix(e, "KEELSON_") {
			out = append(out, e)
		}
	}
	return out
}
