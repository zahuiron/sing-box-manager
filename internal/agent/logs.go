package agent

import (
	"bytes"
	"sync"
)

const (
	maxLogLines  = 1000
	maxLogBytes  = 256 << 10
	maxLineBytes = 4096
)

type limitedBuffer struct {
	mu    sync.Mutex
	data  []byte
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	remaining := b.limit - len(b.data)
	if remaining > 0 {
		b.data = append(b.data, p[:min(len(p), remaining)]...)
	}
	return len(p), nil
}

func (b *limitedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.data)
}

type logEntry struct {
	sequence uint64
	data     []byte
}

type logBuffer struct {
	mu      sync.Mutex
	entries [maxLogLines]logEntry
	start   int
	count   int
	bytes   int
	next    uint64
}

func newLogBuffer() *logBuffer { return &logBuffer{} }

func (b *logBuffer) reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	clear(b.entries[:])
	b.start, b.count, b.bytes = 0, 0, 0
}

func (b *logBuffer) append(p []byte) {
	b.mu.Lock()
	defer b.mu.Unlock()
	p = bytes.Clone(p[:min(len(p), maxLineBytes+32)])
	for b.count > 0 && (b.count == maxLogLines || b.bytes+len(p) > maxLogBytes) {
		b.bytes -= len(b.entries[b.start].data)
		b.entries[b.start] = logEntry{}
		b.start, b.count = (b.start+1)%maxLogLines, b.count-1
	}
	b.next++
	b.entries[(b.start+b.count)%maxLogLines] = logEntry{sequence: b.next, data: p}
	b.count++
	b.bytes += len(p)
}

func (b *logBuffer) snapshot(after uint64, lines int, initial bool) ([]logEntry, uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	start := 0
	if initial {
		start = max(0, b.count-lines)
	}
	entries := make([]logEntry, 0, min(lines, b.count))
	for i := start; i < b.count; i++ {
		entry := b.entries[(b.start+i)%maxLogLines]
		if initial || entry.sequence > after {
			entries = append(entries, entry)
		}
	}
	return entries, b.next
}

type lineWriter struct {
	mu        sync.Mutex
	pending   []byte
	truncated bool
	write     func([]byte) error
}

func newLineWriter(write func([]byte) error) *lineWriter { return &lineWriter{write: write} }

func (w *lineWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	total := len(p)
	for len(p) > 0 {
		end := bytes.IndexByte(p, '\n')
		part := p
		if end >= 0 {
			part = p[:end]
		}
		remaining := maxLineBytes - len(w.pending)
		w.pending = append(w.pending, part[:min(len(part), remaining)]...)
		w.truncated = w.truncated || len(part) > remaining
		if end < 0 {
			break
		}
		if err := w.flush(); err != nil {
			return 0, err
		}
		p = p[end+1:]
	}
	return total, nil
}

func (w *lineWriter) flush() error {
	if w.truncated {
		w.pending = append(w.pending, " [truncated]"...)
	}
	w.pending = append(w.pending, '\n')
	err := w.write(w.pending)
	w.pending, w.truncated = w.pending[:0], false
	return err
}

func (w *lineWriter) Flush() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.pending) == 0 && !w.truncated {
		return nil
	}
	return w.flush()
}
