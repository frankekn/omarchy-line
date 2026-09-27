.pragma library

var initialized = false
var revision = 0
var accounts = {}
var lastAccount = ""
var maxRevision = 9007199254740991

function copy(value) {
  return JSON.parse(JSON.stringify(value || {}))
}

function highestDraftVersion(value) {
  var highest = 0
  for (var account in value || {}) {
    var chats = value[account] || {}
    for (var chat in chats) {
      var version = Number(chats[chat] && chats[chat].version || 0)
      if (isFinite(version)) highest = Math.max(highest, version)
    }
  }
  return highest
}

function validRevision(value) {
  return typeof value === "number" && isFinite(value)
      && Math.floor(value) === value && value >= 0
      && value <= maxRevision
}

function advanceRevision() {
  if (revision >= maxRevision) return 0
  revision++
  return revision
}

function validPayload(parsed) {
  if (!parsed || parsed.version !== 1 || !parsed.accounts
      || typeof parsed.accounts !== "object" || Array.isArray(parsed.accounts))
    return false
  if (Object.prototype.hasOwnProperty.call(parsed, "revision")
      && !validRevision(parsed.revision)) return false
  for (var account in parsed.accounts) {
    var chats = parsed.accounts[account]
    if (!chats || typeof chats !== "object" || Array.isArray(chats)) return false
    for (var chat in chats) {
      var draft = chats[chat]
      if (!draft || typeof draft !== "object" || Array.isArray(draft)) return false
      if (Object.prototype.hasOwnProperty.call(draft, "version")
          && !validRevision(draft.version)) return false
    }
  }
  return true
}

function deletionOnly(before, after) {
  if (after === before) return true
  if (!after || typeof after !== "object") return after === before
  if (!before || typeof before !== "object") return false
  if (Array.isArray(after) !== Array.isArray(before)) return false
  if (Array.isArray(after)) {
    var beforeIndex = 0
    for (var afterIndex = 0; afterIndex < after.length; afterIndex++) {
      while (beforeIndex < before.length
          && !deletionOnly(before[beforeIndex], after[afterIndex])) beforeIndex++
      if (beforeIndex >= before.length) return false
      beforeIndex++
    }
    return true
  }
  for (var key in after) {
    if (!Object.prototype.hasOwnProperty.call(before, key)
        || !deletionOnly(before[key], after[key])) return false
  }
  return true
}

function snapshot() {
  return { revision: revision, accounts: copy(accounts), lastAccount: lastAccount }
}

// Draft identities share the file's monotonic revision clock. Allocation is
// process-global, so deleting a chat and recreating it from another Panel can
// never reuse an identity still displayed by an older Panel.
function allocateRevision() {
  initialized = true
  return advanceRevision()
}

// Every Panel instance imports this one library object. File notifications can
// arrive out of order after an atomic rename, so only a newer disk revision may
// replace changes already merged by another screen in this shell process.
function load(content) {
  var parsed = null
  try { parsed = JSON.parse(String(content || "")) } catch (e) {}
  var valid = validPayload(parsed)
  if (!valid) return null
  var incomingRevision = valid ? Number(parsed.revision || 0) : 0
  if (!initialized || (valid && (incomingRevision > revision
      || (incomingRevision === 0 && revision === 0
          && Object.keys(accounts).length === 0)))) {
    initialized = true
    accounts = valid ? copy(parsed.accounts) : {}
    revision = Math.max(incomingRevision, highestDraftVersion(accounts))
    lastAccount = valid ? String(parsed.lastAccount || "") : ""
  }
  return snapshot()
}

// Apply the caller's changes as a three-way patch: `previous` is that panel's
// last view, `next` is its intended view, and `accounts` is the latest shared
// view. Two screens editing different chats therefore keep both changes.
function merge(previous, next, lastHint) {
  initialized = true
  var before = previous || {}
  var after = next || {}
  var merged = copy(accounts)
  var accountKeys = {}
  for (var a in before) accountKeys[a] = true
  for (var b in after) accountKeys[b] = true
  for (var account in accountKeys) {
    var oldChats = before[account] || {}
    var newChats = after[account] || {}
    var currentChats = copy(merged[account] || {})
    var chatKeys = {}
    for (var c in oldChats) chatKeys[c] = true
    for (var d in newChats) chatKeys[d] = true
    for (var chat in chatKeys) {
      if (JSON.stringify(oldChats[chat]) === JSON.stringify(newChats[chat])) continue
      if (newChats[chat] === undefined) delete currentChats[chat]
      else currentChats[chat] = copy(newChats[chat])
    }
    if (Object.keys(currentChats).length) merged[account] = currentChats
    else delete merged[account]
  }
  // Advance before publishing the merge so the snapshot and its clock change
  // together. A persisted file may already be at the numeric ceiling. In that
  // explicit recovery state, new identities remain staged in the Panel while
  // deletions are safe to publish with the existing clock. The in-process
  // snapshot is updated immediately, and load() ignores delayed files at the
  // same revision.
  if (!advanceRevision() && !deletionOnly(before, after)) return null
  accounts = merged
  if (lastHint !== undefined) lastAccount = String(lastHint || "")
  if (lastAccount && !accounts[lastAccount]) lastAccount = ""
  return snapshot()
}

function serialize() {
  return JSON.stringify({
    version: 1,
    revision: revision,
    accounts: accounts,
    lastAccount: lastAccount
  }) + "\n"
}
