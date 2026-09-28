# Contributing

Thanks for taking the time to contribute. This document covers how to set the
repo up, run the tests, and get a change merged.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | **>= 22.19.0** | both packages declare this in `engines` |
| pnpm | 11.x | the repo is a pnpm workspace |

## Setup

```sh
git clone https://github.com/HuangQiTai/dsh-agent-room.git
cd dsh-agent-room
pnpm install
```

`pnpm install` resolves the workspace links (`packages/org` depends on
`packages/room`) and pulls the `@deepseek-ai/*` dev dependencies used for
types and the Cordis plugin base.

> **Offline / restricted networks:** the `@deepseek-ai/*` packages are fetched
> from npm. If you are behind a mirror, point pnpm at it
> (`pnpm config set registry <mirror>`) before installing.

## Repository layout

```
packages/
  room/   dsh-agent-room — collaboration rooms, chat + task board, MCP tools
  org/    dsh-agent-org  — org tree, member assignment, hierarchical visibility
```

Both packages are **DSH (DeepSeek Harness) plugins** using the Cordis plugin
model. A package typically has:

- `src/` — TypeScript source (the thing you edit)
- `lib/` — **build output, and it is committed** (see below)
- `test/*.test.mjs` — tests, run with the built-in `node:test` runner
- `cordis.patch.yml` — the loader patch that registers the plugin
- `docs/RELEASE-*.md` — per-version engineering notes

## Building and testing

```sh
pnpm -r build        # compile src/ -> lib/ in both packages
pnpm -r typecheck    # tsc --noEmit
pnpm -r test         # build + run every test
```

Or per package:

```sh
cd packages/room
pnpm build
pnpm test            # node build.mjs && node --test test/*.test.mjs
```

```sh
cd packages/org
pnpm test            # node --test test/*.test.mjs
```

`packages/room` **builds before testing** — its tests import from `lib/`, so a
stale build is a stale test result. `packages/org` runs its sources directly.

### ⚠️ `lib/` is committed on purpose

DSH loads plugins from the installed package, not from a build step at install
time. So `packages/room/lib/` is tracked in git and **you must rebuild and
commit it alongside any `src/` change**. A pull request that changes `src/`
without the matching `lib/` output will not run for anyone installing it.

```sh
# before committing
cd packages/room && pnpm build && git add lib src
```

## Tests

Tests use the Node.js built-in runner — no test framework to install:

```sh
node --test test/*.test.mjs          # all
node --test test/wake.test.mjs       # one file
```

A few conventions worth following:

- **Write tests that can fail.** Several suites in this repo exist specifically
  to pin a previously-broken behaviour; a test that cannot go red is not a test.
- **Tests must not touch the real DSH home.** Point `DSH_HOME` at a temp
  directory and write scratch files under a throwaway path.
- **Prefer a regression test over a comment.** If you are fixing a bug, the
  test that reproduces it is part of the fix.

## Commit messages

This repo follows [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add per-room delivery watermark
fix: do not let a dead relay client overwrite the bridge state
docs: clarify the acceptance criteria for 0.1.44
chore: snapshot 0.1.2 source for kanban tracking
```

Commit subjects and bodies in this repo are often in Chinese, and that is fine
— keep the type prefix in English so tooling can parse it.

### Sign off your commits (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a CLA. It is a one-line assertion that you wrote the patch, or
otherwise have the right to submit it under the project's license:

```sh
git commit -s -m "fix: ..."
```

That appends:

```
Signed-off-by: Your Name <you@example.com>
```

Use a real name and an email you can be reached at. Please make sure your git
identity is set (`git config user.name` / `user.email`) — commits authored by
placeholder addresses cannot be attributed.

## Pull requests

1. **Open an issue first** for anything larger than a bug fix, so the design can
   be discussed before you spend time on it.
2. **Keep the change focused.** One concern per PR; unrelated refactors make a
   diff hard to review.
3. **Run the full suite** before pushing: `pnpm -r test`.
4. **Rebuild `lib/`** if you touched `packages/room/src/`.
5. **Update the docs** the change touches — and if the change alters observable
   behaviour, add a note under `packages/*/docs/`.
6. **Describe how you verified it.** "Tests pass" plus the command you ran, or
   the manual steps and what you observed.

## Reporting bugs

A useful report includes:

- what you expected and what happened instead;
- the exact version (`dsh-agent-room@x.y.z` / `dsh-agent-org@x.y.z`);
- the commands you ran, with output;
- whether it reproduces from a clean `DSH_HOME`.

Please **redact** tokens, hostnames, IP addresses, and any real conversation
content before pasting logs.

## Security

Do not open a public issue for a vulnerability. Contact the maintainer
privately first and allow time for a fix before disclosure.

## License

By contributing, you agree that your contribution is licensed under the
**Apache License 2.0** — see [LICENSE](LICENSE) and [NOTICE](NOTICE). No
separate contributor agreement is required.
