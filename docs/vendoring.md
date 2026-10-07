# The vendored linejs fork

[繁體中文](vendoring.zh-TW.md)

The daemon talks to LINE through [linejs](https://github.com/evex-dev/linejs)
by [Evex Developers](https://github.com/evex-dev). It does not import the
published `jsr:@evex/linejs` package. It imports the git submodule at
`daemon/vendor/linejs`, which tracks the `omarchy-vendor` branch of the public
fork [frankekn/linejs](https://github.com/frankekn/linejs). The daemon needs
fixes in the protocol layer, where it cannot work around them, so those fixes
live in the fork.

linejs is MIT-licensed. The vendored copy keeps its license at
[`daemon/vendor/linejs/LICENSE`](../daemon/vendor/linejs/LICENSE).

## The pinned commit

The submodule pins `4d6aa18` on `omarchy-vendor`. That commit sits two commits
above upstream `802f4c7`, "fix: E2EE key registration and client message
handling (#226)", which is the base of `omarchy-vendor`.

- The first commit holds the omarchy patches to `packages/linejs` and
  `packages/types`.
- The second commit, `4d6aa18`, turns the fork's root `README.md` from a
  symlink into a real file, so `omarchy plugin validate` passes. The
  validator refuses any symlink inside a plugin folder.

## What the fork changes

- **Types.** `LooseType` from `@evex/loose-types` remains only in the Thrift
  read and write code, `base/push/connManager.ts`, and `types/thrift.ts`.
  Concrete types replace it everywhere else. The types package is published
  as `@frankekn/linejs-types`.
- **Requests.** Request defaults follow current LINE service endpoints. A
  caller's `AbortSignal` reaches the encrypted request, so a request timeout
  also applies to encrypted calls. Before, a keep-alive connection that died
  during suspend could hang forever.
- **E2EE.** A group message is decrypted with the shared-key generation that
  its `groupKeyId` names, and keys are cached per generation. Before, every
  older message in a group whose key had rotated failed to decrypt.
- **Media.** An OBS download that gets a non-2xx answer throws an `ObsError`
  instead of failing later with "HMAC verification failed".
  `uploadMediaByE2EE` takes a `durationMs`, so E2EE videos do not show 0:00
  on the other side. It also takes extra `contentMetadata`, but a caller
  cannot override `DURATION`, `DOWNLOAD_URL`, or `PREVIEW_URL`. Media
  downloads take an `AbortSignal`.
- **Push and polling.** A failed push connection or a failed listen loop is
  reported to the caller instead of becoming an unhandled rejection that
  kills the process.
- **Other.** An Album (`moa`) service, changes to the call feature, a Node
  fetch with a connect timeout (`base/core/node_fetch.ts`), and new tests. The
  workspace holds only `packages/linejs` and `packages/types`.

## Fixes contributed upstream

Several of these fixes went back to `evex-dev/linejs` as pull requests from
this fork's branches, and upstream merged them:

- [#231](https://github.com/evex-dev/linejs/pull/231) forwards the abort
  signal through the encrypted transport.
- [#232](https://github.com/evex-dev/linejs/pull/232) reports push connect
  failures instead of leaving them unhandled.
- [#233](https://github.com/evex-dev/linejs/pull/233) fetches the group shared
  key that a message was encrypted with.
- [#234](https://github.com/evex-dev/linejs/pull/234) surfaces non-2xx
  download responses as `ObsError`.
- [#239](https://github.com/evex-dev/linejs/pull/239) keeps listen loops alive
  and sends a real `reqSeq` for reactions.
- [#240](https://github.com/evex-dev/linejs/pull/240) carries a video's length
  through the E2EE upload.

Upstream has moved on since `802f4c7`. When upstream holds everything the
daemon needs, the plan is to drop the submodule and point the import map in
`daemon/deno.json` back at `jsr:@evex/linejs`.

## Run the fork's tests

The fork's tests run inside the fork. Run `deno test -A` at its root. That
run creates `node_modules/` and `deno.lock` inside the fork. Delete both
before you run `omarchy plugin validate`, because the validator refuses the
symlinks in `node_modules/`. This repository's `deno task test` excludes
`vendor/` and runs only its own tests.

## Change linejs

Work on `omarchy-vendor`, then move the pin in this repository:

```bash
git submodule sync -- daemon/vendor/linejs
git submodule update --init daemon/vendor/linejs
cd daemon/vendor/linejs
git switch omarchy-vendor             # tracks origin/omarchy-vendor
git pull --ff-only
# edit, then commit the change on omarchy-vendor
deno test -A
rm -rf node_modules deno.lock
git push origin omarchy-vendor
cd ../../..
git add daemon/vendor/linejs          # moves the pin
(cd daemon && deno task check && deno task test)
git commit -m "chore(daemon): bump vendored linejs"
```

If you skip `git add daemon/vendor/linejs` and the final `git commit`, this
repository still pins the old commit.

## Take upstream changes

Merge upstream into `omarchy-vendor`. Do not rebase:

```bash
cd daemon/vendor/linejs
git remote add upstream https://github.com/evex-dev/linejs.git   # once
git fetch upstream
git switch omarchy-vendor
git merge upstream/main
deno test -A
rm -rf node_modules deno.lock
git push origin omarchy-vendor
cd ../../..
git add daemon/vendor/linejs
(cd daemon && deno task check && deno task test)
git commit -m "chore(daemon): merge upstream linejs"
```

Do not rebase or force-push `omarchy-vendor`. Every past commit of this
repository pins a commit on that branch. A rewritten branch leaves those
commits on no branch, so `git submodule update` in an older checkout may fail
to fetch them.

`.gitmodules` names the branch, so
`git submodule update --remote daemon/vendor/linejs` moves the submodule to
the tip of `origin/omarchy-vendor`. Test and commit that pin the same way.
