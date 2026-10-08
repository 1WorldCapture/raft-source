package app

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestBuildRejectsMissingConfig(t *testing.T) {
	if _, err := Build(Options{}); err == nil {
		t.Fatal("missing configuration must return an error, not panic")
	}
}

func TestJanitorStopIsIdempotentAndJoinsBeforeClose(t *testing.T) {
	built, err := Build(Options{Config: testConfig(t, t.TempDir())})
	if err != nil {
		t.Fatal(err)
	}
	defer built.Close()
	stop := built.StartJanitor(context.Background(), nil)
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() { defer wg.Done(); stop() }()
	}
	done := make(chan struct{})
	go func() { defer close(done); wg.Wait() }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("janitor stop did not join promptly")
	}
	stop()
	if err := built.Close(); err != nil {
		t.Fatal(err)
	}
}
