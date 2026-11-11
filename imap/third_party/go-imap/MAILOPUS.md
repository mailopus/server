Copy of github.com/emersion/go-imap/v2 v2.0.0-beta.8 with one change, in
`internal/imapnum/numset.go`: a number set value of "0" parses as 1, because Apple Mail
sends `UID FETCH 0:N`. Drop this copy and the `replace` in go.mod once upstream accepts 0.
