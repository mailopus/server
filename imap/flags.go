package main

import (
	"slices"
	"strings"

	"github.com/emersion/go-imap/v2"
)

// IMAP system flags and their JMAP keywords (RFC 8621 §4.1.1). \Deleted is stored as $deleted so
// a flag set by one connection survives until another expunges it.
var systemFlags = map[imap.Flag]string{
	imap.FlagSeen:     "$seen",
	imap.FlagAnswered: "$answered",
	imap.FlagFlagged:  "$flagged",
	imap.FlagDraft:    "$draft",
	imap.FlagDeleted:  "$deleted",
}

var keywordFlags = func() map[string]imap.Flag {
	m := map[string]imap.Flag{}
	for f, k := range systemFlags {
		m[k] = f
	}
	return m
}()

// flagToKeyword maps an IMAP flag to a JMAP keyword, or "" for one Mailopus can't store (\Recent,
// unknown system flags, or characters outside RFC 8621's keyword set).
func flagToKeyword(f imap.Flag) string {
	for sf, k := range systemFlags {
		if strings.EqualFold(string(f), string(sf)) {
			return k
		}
	}
	s := strings.ToLower(string(f))
	if s == "" || strings.HasPrefix(s, `\`) {
		return ""
	}
	for _, r := range s {
		if r < 0x21 || r > 0x7e || strings.ContainsRune(`(){]%*"\`, r) {
			return ""
		}
	}
	return s
}

func keywordToFlag(k string) imap.Flag {
	if f, ok := keywordFlags[strings.ToLower(k)]; ok {
		return f
	}
	return imap.Flag(k)
}

func keywordsToFlags(kw []string) []imap.Flag {
	out := make([]imap.Flag, 0, len(kw))
	for _, k := range kw {
		out = append(out, keywordToFlag(k))
	}
	slices.Sort(out)
	return out
}

func flagsToKeywords(flags []imap.Flag) map[string]bool {
	out := map[string]bool{}
	for _, f := range flags {
		if k := flagToKeyword(f); k != "" {
			out[k] = true
		}
	}
	return out
}

func hasFlag(flags []imap.Flag, f imap.Flag) bool {
	return slices.ContainsFunc(flags, func(x imap.Flag) bool { return strings.EqualFold(string(x), string(f)) })
}

func sameFlags(a, b []imap.Flag) bool {
	a, b = slices.Clone(a), slices.Clone(b)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}
