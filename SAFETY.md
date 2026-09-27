# SAFETY — operations this project will never implement

Any agent, session, or script working on this repository is permanently
forbidden from the following:

## 1. EasyMigration / account transfer — absolutely forbidden

LINE's account-transfer flow (EasyMigration / "Carry over", where the old
device shows a transfer QR and a new device takes over the account) is
**never researched, implemented, or invoked**.

**Why**: transfer semantics change the primary-device state and can demote
or log out the user's existing primary device. This is a deliberate
policy decision, not a technical limitation.

## 1a. The "Main device" prompt *is* the transfer — verified 2026-09-22

After credential verification, LINE's new-device login (Android 26.14.0)
shows a "Use this as your main device?" dialog:

- **Main device**: "This will start the account transfer process.
  You'll be logged out of LINE on all other devices."
  ← This *is* transfer semantics (equivalent to EasyMigration). Never select it.
- **Sub device**: "You'll remain logged in on your main device…"
  ← The only permitted path.

**Consequence**: a "phone-OTP login that mints a primary token without
affecting existing devices" is *structurally impossible*. PAIS
`migratePrimaryUsingPhoneWithTokenV3` shares the same "migrate" semantics.
The `/PBK4` full-history backup entitlement is also bound to the main
device, so automation can never obtain it; personal-account backup is
therefore a rolling recent-history window, not a full archive.

## 2. Other red lines

- **No writes to unapproved targets**: personal-account sends only go to
  recipients the user has explicitly approved; OA bot write tests only go
  to a designated test OA account.
- **No forged hardware attestation**: FCM push tokens and
  Strongbox/device-integrity attestation are never faked.
- **No credentials in the repo**: sessions, tokens, and passwords live only
  under `~/.local/state/` and environment variables.
- **Back off on risk-control error codes**: on ABUSE_BLOCK / BANNED /
  EXCESSIVE_ACCESS / NOT_AUTHORIZED_DEVICE, stop the related operation
  immediately and report to the user.
