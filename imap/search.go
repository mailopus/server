package main

import (
	"context"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
)

// Search answers flag, date, size and number criteria from the mailbox index. Text criteria
// (HEADER, BODY, TEXT) each become one Email/query within this mailbox.
func (s *Session) Search(kind imapserver.NumKind, criteria *imap.SearchCriteria, options *imap.SearchOptions) (*imap.SearchData, error) {
	c, cancel := ctx()
	defer cancel()
	text := map[*imap.SearchCriteria]map[string]bool{}
	if err := s.textMatches(c, criteria, text); err != nil {
		return nil, s.backend("search", err)
	}

	s.acct.mu.Lock()
	defer s.acct.mu.Unlock()
	var data imap.SearchData
	var seqs imap.SeqSet
	var uids imap.UIDSet
	var max imap.UID
	if n := len(s.box.msgs); n > 0 {
		max = s.box.msgs[n-1].UID
	}
	for i, m := range s.box.msgs {
		seq := s.st.EncodeSeqNum(uint32(i) + 1)
		if !s.match(seq, uint32(len(s.box.msgs)), max, m, criteria, text) {
			continue
		}
		uids.AddNum(m.UID)
		num := uint32(m.UID)
		if kind == imapserver.NumKindSeq {
			if seq == 0 {
				continue
			}
			seqs.AddNum(seq)
			num = seq
		}
		if data.Min == 0 || num < data.Min {
			data.Min = num
		}
		if num > data.Max {
			data.Max = num
		}
		data.Count++
	}
	if kind == imapserver.NumKindSeq {
		data.All = seqs
	} else {
		data.All = uids
	}
	if options.ReturnSave {
		s.searchRes = uids
	}
	return &data, nil
}

// textMatches runs the Email/query for every text condition in the tree, keyed by the criteria
// node it belongs to.
func (s *Session) textMatches(c context.Context, cr *imap.SearchCriteria, out map[*imap.SearchCriteria]map[string]bool) error {
	var conds []map[string]any
	for _, h := range cr.Header {
		if h.Value == "" {
			continue // HEADER x "" matches any message with the field; treat as no condition
		}
		switch k := strings.ToLower(h.Key); k {
		case "from", "to", "cc", "subject":
			conds = append(conds, map[string]any{k: h.Value})
		default:
			conds = append(conds, map[string]any{"text": h.Value})
		}
	}
	for _, v := range cr.Body {
		conds = append(conds, map[string]any{"body": v})
	}
	for _, v := range cr.Text {
		conds = append(conds, map[string]any{"text": v})
	}
	if len(conds) > 0 {
		filter := map[string]any{"operator": "AND", "conditions": append(conds, map[string]any{"inMailbox": s.box.ID})}
		ids := map[string]bool{}
		const page, maxPages = 256, 40
		for p := 0; p < maxPages; p++ {
			var r struct {
				IDs []string `json:"ids"`
			}
			if err := s.acct.c.Call1(c, "Email/query", map[string]any{"filter": filter, "position": p * page, "limit": page}, &r); err != nil {
				return err
			}
			for _, id := range r.IDs {
				ids[id] = true
			}
			if len(r.IDs) < page {
				break
			}
		}
		out[cr] = ids
	}
	for i := range cr.Not {
		if err := s.textMatches(c, &cr.Not[i], out); err != nil {
			return err
		}
	}
	for i := range cr.Or {
		for j := range cr.Or[i] {
			if err := s.textMatches(c, &cr.Or[i][j], out); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Session) match(seq, maxSeq uint32, maxUID imap.UID, m *Message, cr *imap.SearchCriteria, text map[*imap.SearchCriteria]map[string]bool) bool {
	for _, set := range cr.SeqNum {
		if imap.IsSearchRes(set) {
			if !s.searchRes.Contains(m.UID) {
				return false
			}
			continue
		}
		st := staticSeq(set, maxSeq)
		if seq == 0 || !st.Contains(seq) {
			return false
		}
	}
	for _, set := range cr.UID {
		if imap.IsSearchRes(set) {
			if !s.searchRes.Contains(m.UID) {
				return false
			}
			continue
		}
		su := staticUID(set, maxUID)
		if !su.Contains(m.UID) {
			return false
		}
	}
	day := func(t time.Time) time.Time { return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC) }
	// No sent date in the index; the received date stands in for SENTSINCE and SENTBEFORE.
	for _, since := range []time.Time{cr.Since, cr.SentSince} {
		if !since.IsZero() && day(m.Date).Before(day(since)) {
			return false
		}
	}
	for _, before := range []time.Time{cr.Before, cr.SentBefore} {
		if !before.IsZero() && !day(m.Date).Before(day(before)) {
			return false
		}
	}
	for _, f := range cr.Flag {
		if !hasFlag(m.Flags, f) {
			return false
		}
	}
	for _, f := range cr.NotFlag {
		if hasFlag(m.Flags, f) {
			return false
		}
	}
	if cr.Larger > 0 && m.Size <= cr.Larger {
		return false
	}
	if cr.Smaller > 0 && m.Size >= cr.Smaller {
		return false
	}
	if ids, ok := text[cr]; ok && !ids[m.ID] {
		return false
	}
	for i := range cr.Not {
		if s.match(seq, maxSeq, maxUID, m, &cr.Not[i], text) {
			return false
		}
	}
	for i := range cr.Or {
		if !s.match(seq, maxSeq, maxUID, m, &cr.Or[i][0], text) && !s.match(seq, maxSeq, maxUID, m, &cr.Or[i][1], text) {
			return false
		}
	}
	return true
}
