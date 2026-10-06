# Maintainer safety red lines

[繁體中文](MAINTAINERS-SAFETY.zh-TW.md)

These rules bind everyone and everything that works on this repository: each
contributor, each session, and each script or automated job. They are
permanent. The user-facing summary of what the plugin does with an account
and its data is [SAFETY.md](../SAFETY.md).

## 1. Never use EasyMigration or account transfer

Never research, implement, or call LINE's account-transfer flow
(EasyMigration, or "Carry over": the old device shows a transfer QR code and a
new device takes over the account).

**Why.** Transfer semantics change which device is the primary device. They
can demote or log out the user's existing primary device. This is a
deliberate policy decision, not a technical limit.

## 1a. The "Main device" prompt is the transfer (verified 2026-09-22)

After credential verification, the new-device login of LINE for Android
26.14.0 shows the dialog "Use this as your main device?":

- **Main device**: "This will start the account transfer process. You'll be
  logged out of LINE on all other devices." This is transfer semantics, the
  same as EasyMigration. Never select it.
- **Sub device**: "You'll remain logged in on your main device…" This is the
  only permitted path.

**Consequence.** A phone-OTP login that mints a primary token without
affecting existing devices is impossible by design. PAIS
`migratePrimaryUsingPhoneWithTokenV3` has the same "migrate" semantics. The
`/PBK4` full-history backup entitlement is also bound to the main device, so
automation can never obtain it. A personal-account backup is therefore a
rolling window of recent history, not a full archive.

## 2. Other red lines

- **No writes to unapproved targets.** Personal-account sends go only to
  recipients the user has explicitly approved. OA bot write tests go only to
  a designated test OA account.
- **No forged hardware attestation.** Never fake FCM push tokens or
  Strongbox and device-integrity attestation.
- **No credentials in the repository.** Sessions, tokens, and passwords live
  only under `~/.local/state/` and in environment variables.
- **Back off on risk-control error codes.** On `ABUSE_BLOCK`, `BANNED`,
  `EXCESSIVE_ACCESS`, or `NOT_AUTHORIZED_DEVICE`, stop the related operation
  at once and report it to the user.

## 3. Local message store layout

The daemon's message store at
`~/.local/state/enil/messages/<your-mid>/<chatMid>.jsonl` uses the same line
layout as the CLI backup's `archiveLine` records. [SAFETY.md](../SAFETY.md)
describes what the store holds, who can read it, and how to delete it. Keep
that page true when the store changes.
