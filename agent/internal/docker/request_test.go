package docker

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// The query of a build holds its build arguments: a request that fails must not carry them in its error.
func TestAFailedRequestDoesNotCarryItsURL(t *testing.T) {
	f := &fakeEngine{handler: func(http.ResponseWriter, *http.Request) { panic(http.ErrAbortHandler) }}
	err := newAdmin(t, f).Build(context.Background(), BuildOptions{
		Tag: "o/web:abc", Args: map[string]string{"API_KEY": "hunter2-hunter2"},
	}, strings.NewReader("x"), func(string) {})
	if err == nil {
		t.Fatal("the engine hung up: that is an error")
	}
	for _, leak := range []string{"hunter2", "API_KEY", "buildargs", "http://docker"} {
		if strings.Contains(err.Error(), leak) {
			t.Errorf("the error carries the URL (%q): %v", leak, err)
		}
	}
	if !strings.Contains(err.Error(), "/build") {
		t.Errorf("it must still say what failed: %v", err)
	}
}
