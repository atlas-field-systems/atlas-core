FROM golang:1.26.2-alpine@sha256:f85330846cde1e57ca9ec309382da3b8e6ae3ab943d2739500e08c86393a21b1 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /atlas-core ./cmd/atlas-core

FROM scratch
COPY --from=build /atlas-core /atlas-core
EXPOSE 8080
HEALTHCHECK --interval=2s --timeout=3s --start-period=1s --retries=2 CMD ["/atlas-core", "check-ready"]
ENTRYPOINT ["/atlas-core"]
