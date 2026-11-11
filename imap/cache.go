package main

import (
	"container/list"
	"sync"
)

// Memory-only caches of message bytes, capped by size. Never on disk.
var (
	headerCache = newLRU(16 << 20)
	rawCache    = newLRU(64 << 20)
)

type lru struct {
	mu    sync.Mutex
	max   int
	size  int
	order *list.List
	items map[string]*list.Element
}

type entry struct {
	key string
	val []byte
}

func newLRU(max int) *lru {
	return &lru{max: max, order: list.New(), items: map[string]*list.Element{}}
}

func (c *lru) Get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.items[key]; ok {
		c.order.MoveToFront(e)
		return e.Value.(*entry).val, true
	}
	return nil, false
}

func (c *lru) Add(key string, val []byte) {
	if len(val) > c.max/4 {
		return // one huge message shouldn't flush everything else
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.items[key]; ok {
		c.size -= len(e.Value.(*entry).val)
		c.order.Remove(e)
	}
	c.items[key] = c.order.PushFront(&entry{key, val})
	c.size += len(val)
	for c.size > c.max {
		e := c.order.Back()
		c.order.Remove(e)
		delete(c.items, e.Value.(*entry).key)
		c.size -= len(e.Value.(*entry).val)
	}
}
