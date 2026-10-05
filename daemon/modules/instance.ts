/**
 * The single-instance gate. LINE rotates the refresh token on every use, so
 * two daemons resuming from one storage.json overwrite each other's token and
 * the loser's copy is already dead -- the next start needs a fresh QR scan.
 * The second one would also take over the socket and, on its way out, delete
 * the first one's.
 *
 * An flock on a file in the state dir is the gate: the kernel drops it when
 * the holder dies, however it dies, so a crash never leaves a stale lock that
 * has to be cleaned up by hand.
 *
 * Dependency direction: a leaf. daemon.ts calls it before anything touches
 * the state dir.
 */

/**
 * Takes the lock at `path` without waiting. Returns the open handle on
 * success -- keep it for the life of the process, closing it releases the
 * lock -- or null when another process already holds it.
 */
async function claimInstance(path: string): Promise<Deno.FsFile | null> {
  const file = await Deno.open(path, {
    read: true,
    write: true,
    create: true,
    mode: 0o600,
  });
  if (await file.tryLock(true)) return file;
  file.close();
  return null;
}

export { claimInstance };
