VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
.PHONY: all web build test test-go test-mod test-e2e dev clean

all: build

web/node_modules: web/package.json
	cd web && npm install
	touch $@

web: web/node_modules
	cd web && npm run build

build: web
	go build -ldflags "-X github.com/ryotarai/minbox/internal/server.Version=$(VERSION)" -o bin/minbox ./cmd/minbox

test: test-go test-mod test-e2e

test-go:
	go test ./...

test-mod:
	cd plugin/minbox && claude plugin test .

test-e2e: build
	cd web && npx playwright test

clean:
	rm -rf bin web/dist/assets web/dist/index.html web/dist/favicon.svg
