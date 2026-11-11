# Third-party notices

Mailopus is licensed under the PolyForm Shield License 1.0.0 (see `LICENSE`). It includes and redistributes the work below under its own licenses.

## IMAP library

`imap/third_party/go-imap` is a copy of [emersion/go-imap](https://github.com/emersion/go-imap) v2 with one change, described in `imap/third_party/go-imap/MAILOPUS.md`. It is under the MIT License, in `imap/third_party/go-imap/LICENSE`.

## Other dependencies

The server is built with npm packages under the MIT, ISC, BSD, Apache 2.0, BlueOak 1.0.0 and 0BSD licenses, and the IMAP proxy with Go modules under the MIT, BSD and Apache 2.0 licenses. `pnpm licenses list --prod` in the repo root and `go list -m all` in `imap/` name each one, and each package carries its own license file.
