# Contributing

[繁體中文](CONTRIBUTING.zh-TW.md)

Bug reports, fixes, and features are welcome. This page lists the rules for a
pull request. [docs/development.md](docs/development.md) explains how to set
up a checkout, run the panel against the stub, and test on real hardware.

## Safety rules

These rules apply to every change, every test, and every script in this
repository. A pull request that breaks one will not be merged.

- **Never use account transfer.** The daemon always logs in as a secondary
  device. Do not research, implement, or call LINE's account-transfer flow,
  or choose "main device" when LINE offers it. Transfer can log the user's
  phone out.
- **Send only to recipients the account owner chose.** An automated test that
  sends through a real account sends only to recipients that the owner of
  that account picked for testing.
- **Never fake device identity.** Do not forge device identity, push
  registration, or integrity signals.
- **Stop when LINE says stop.** If LINE reports that the account or the
  device is restricted, stop the operation and tell the user. Never retry
  around the restriction.
- **Keep credentials out of the repository.** Sessions, tokens, and passwords
  live only under `~/.local/state/` and in environment variables.
- **Keep SAFETY.md true.** [SAFETY.md](SAFETY.md) describes what the code does
  with the account and the data on disk. A change that makes it wrong updates
  it in the same commit.

## Run the checks locally

Run these from the repository root before you open a pull request:

```bash
(cd daemon && deno task check && deno task no-any && deno task lint && deno task fmt && deno task test)
node tests/qml/run.js
tests/qml/keytest/run.sh
python3 daemon/stub_test.py
```

Each command must exit 0. `tests/qml/keytest/run.sh` skips when
`qmltestrunner` is not installed. If you have Omarchy, also run
`omarchy plugin validate .`.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `fix:`,
`feat:`, `perf:`, `docs:`, `test:`, `ci:`, `chore:`, with a scope when it
helps, such as `fix(daemon):` or `fix(panel):`. Write commit messages in
English. Write the subject in the imperative mood and say what changes for
the user.

## Pull requests

- Keep one change per pull request.
- CI runs the checks above, except `omarchy plugin validate`, on a
  GitHub-hosted runner for every pull request, including pull requests from
  forks. It uses no secrets.
- Update the English and the Traditional Chinese docs together. Each `.md`
  file has a `.zh-TW.md` twin.
- For UI changes, add a screenshot taken against the stub.

## Do not paste personal data

Issues, pull requests, logs, and screenshots are public. Never include
`storage.json`, mids, message text, display names, profile pictures, QR
codes, or PIN codes. [SECURITY.md](SECURITY.md#redact-before-you-send-anything)
lists what to redact. Report security problems privately as SECURITY.md
describes, not in an issue.
