FROM golang:1.26.10-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
COPY third_party ./third_party
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/imap . && mkdir -p /out/data/certs

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/imap /imap
# Owned by nonroot so the certificate volume is writable.
COPY --from=build --chown=nonroot:nonroot /out/data /data
EXPOSE 993 143 465 587
ENTRYPOINT ["/imap"]
