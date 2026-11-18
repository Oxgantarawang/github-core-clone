# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Oxgantarawang/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Oxgantarawang/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge, written from scratch on the Node standard library — no dependencies, no git binary, no network at runtime. One process, one in-memory store, four surfaces that all read and write the same state:

- **git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 (advertisement, ls-refs, fetch with shallow/deepen) and receive-pack v0 (report-status, side-band-64k, delete-refs), with fast-forward enforcement on every push.
- **REST v3** under `/api/v3` — repos, branches, commits, contents, labels, issues, pull requests and squash merges, with GitHub-shaped pagination, request ids and error bodies.
- **GraphQL** at `/api/graphql` — the documents `gh` and github-mcp-server send, plus introspection, Relay-style global ids and cursor pagination.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28, with eight tools that act on the same store as REST.

Git objects are built by hand: SHA-1 via `node:crypto`, zlib packfiles via `node:zlib`, pkt-line framing, and an object store for blobs, trees, commits and tags — including pack decoding with OFS/REF delta resolution, so pushes carrying delta packs unpack cleanly.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

`main.ts` is the entrypoint: it binds an ephemeral port, registers it with the env at `$MAKEFUN_ENV_URL`, and exits 0 when the env says the trial is done. To run the forge standalone for a smoke test, import `createApp()` from `app.ts` and listen on any port, with `MAKEFUN_SHOP_TOKEN` set to the bearer token clients must send.

## Layout

- `main.ts` — the entry <-> env lifecycle (bind, register, poll done, exit).
- `app.ts` — the HTTP server: REST v3, git smart HTTP, GraphQL and MCP handlers.
- `store.ts` — the in-memory store: repos, refs, issues, pull requests, squash merges, REST shapes.
- `git.ts` — git objects from scratch: hashing, trees, commits, tags, pkt-lines, packfiles, reachability.
- `graphql.ts` — a hand-written GraphQL parser and executor for the forge's schema.

## Local scores

Against the competition's sealed local runner (`sdk/run.ts`, fresh server per run):

- Conformance: **120/120 checks** — git 30, repos 15, issues 15, pulls 20, graphql 20, mcp 15, protocol 5.
- Feature **600**, agent **200**, perf **183–188** across runs (push 50, clone 37–42, read 50, write 46) — total **983–988 of 1000**.

Built for [make.fun bounty github-core-clone-01](https://make.fun/bounty/github-core-clone-01).
