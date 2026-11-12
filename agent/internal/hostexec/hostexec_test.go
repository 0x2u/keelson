package hostexec

import (
	"context"
	"errors"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"testing"
	"time"
)

type lines struct {
	mu  sync.Mutex
	got []string
	// first receives the first line, for tests that act once the command is up.
	first chan string
}

func newLines() *lines { return &lines{first: make(chan string, 1)} }

func (l *lines) add(s string) {
	l.mu.Lock()
	l.got = append(l.got, s)
	l.mu.Unlock()
	select {
	case l.first <- s:
	default:
	}
}

func (l *lines) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.got...)
}

func TestRunReturnsOutputAndExitCode(t *testing.T) {
	l := newLines()
	err := Run(context.Background(), []string{"sh", "-c", "echo out; echo err >&2; exit 3"}, "", nil, l.add)
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 3 {
		t.Fatalf("want exit code 3, got %v", err)
	}
	got := l.all()
	if len(got) != 2 || got[0] != "out" || got[1] != "err" {
		t.Errorf("output = %q", got)
	}
}

func TestRunSucceeds(t *testing.T) {
	l := newLines()
	if err := Run(context.Background(), []string{"echo", "hello"}, "", nil, l.add); err != nil {
		t.Fatal(err)
	}
	if got := l.all(); len(got) != 1 || got[0] != "hello" {
		t.Errorf("output = %q", got)
	}
}

// runWithGrandchild starts a shell that forks a long sleep, prints the sleep's pid and waits for it: the sleep is not the
// command Run started, only a descendant of it.
func runWithGrandchild(t *testing.T, ctx context.Context) (pid int, runErr <-chan error) {
	t.Helper()
	l := newLines()
	errc := make(chan error, 1)
	go func() {
		errc <- Run(ctx, []string{"sh", "-c", "sleep 300 & echo $!; wait"}, "", nil, l.add)
	}()
	select {
	case first := <-l.first:
		p, err := strconv.Atoi(first)
		if err != nil {
			t.Fatalf("the shell printed %q, not a pid", first)
		}
		t.Cleanup(func() { _ = syscall.Kill(p, syscall.SIGKILL) }) // never leave the sleep behind, whatever the outcome
		return p, errc
	case <-time.After(10 * time.Second):
		t.Fatal("the command printed nothing")
	}
	return 0, nil
}

func waitGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("process %d is still alive: cancelling must kill the command's whole process group", pid)
}

func TestCancelKillsTheWholeProcessGroup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pid, errc := runWithGrandchild(t, ctx)
	if err := syscall.Kill(pid, 0); err != nil {
		t.Fatalf("the grandchild must be running before the cancel: %v", err)
	}

	cancel()
	select {
	case err := <-errc:
		if err == nil {
			t.Error("a killed command must report an error")
		}
	case <-time.After(killWait / 2):
		t.Fatal("Run must return promptly: the grandchild held the output pipe open")
	}
	waitGone(t, pid)
}

func TestTimeoutKillsTheWholeProcessGroup(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	pid, errc := runWithGrandchild(t, ctx)

	select {
	case <-errc:
	case <-time.After(killWait / 2):
		t.Fatal("Run must return promptly after the timeout")
	}
	waitGone(t, pid)
}
