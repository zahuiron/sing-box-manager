package agent

import (
	"bytes"
	"strings"
	"testing"
)

func TestLogBufferBoundsBytesAndLines(t *testing.T) {
	buffer := newLogBuffer()
	w := newLineWriter(func(p []byte) error { buffer.append(p); return nil })
	for i := 0; i < 2000; i++ {
		if _, err := w.Write([]byte(strings.Repeat("x", 20000) + "\n")); err != nil {
			t.Fatal(err)
		}
	}
	entries, sequence := buffer.snapshot(0, maxLogLines, true)
	if sequence != 2000 || len(entries) > maxLogLines || buffer.bytes > maxLogBytes {
		t.Fatalf("sequence %d, entries %d, bytes %d", sequence, len(entries), buffer.bytes)
	}
	for _, entry := range entries {
		if len(entry.data) > maxLineBytes+32 || !bytes.Contains(entry.data, []byte("[truncated]")) {
			t.Fatal("long line was not bounded")
		}
	}
	if next, _ := buffer.snapshot(sequence, 100, false); len(next) != 0 {
		t.Fatal("already-read entries were emitted again")
	}
}
