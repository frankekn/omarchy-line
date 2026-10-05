/**
 * The session store: the same JSON object linejs's FileStorage keeps in
 * storage.json, written the way state.json is. FileStorage truncates the file
 * in place and hands `resolve` to writeFile as its callback, so a failed write
 * resolves as if it had landed -- a full disk or a kill mid-rotation leaves an
 * empty or half-written token file, and the "could not persist token" log
 * behind it can never fire. Here every write is a pid-suffixed temp file,
 * fsynced and renamed into place at 0600, and a failure rejects.
 *
 * Dependency direction: a leaf. It imports only linejs's BaseStorage contract,
 * so tests can drive it against a temp dir without the LINE session.
 */
import { BaseStorage, type Storage } from "@evex/linejs/storage";

type Data = Record<Storage["Key"], Storage["Value"]>;

export class SessionStore extends BaseStorage {
  /** Serialises read-modify-write per instance, as FileStorage did. */
  private writing: Promise<void> = Promise.resolve();

  /**
   * Creates an empty store when the file is absent and leaves an existing
   * one alone -- what FileStorage's constructor does, minus the 0644.
   */
  constructor(private readonly path: string) {
    super();
    try {
      Deno.writeTextFileSync(path, "{}", { createNew: true, mode: 0o600 });
    } catch (e) {
      if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
    }
  }

  private withLock(fn: () => Promise<void>): Promise<void> {
    const run = this.writing.then(fn);
    // The chain survives a failed write; the caller still sees the rejection.
    this.writing = run.catch(() => {});
    return run;
  }

  private async write(data: Data): Promise<void> {
    const tmp = `${this.path}.${Deno.pid}.tmp`;
    try {
      const file = await Deno.open(tmp, {
        write: true,
        create: true,
        truncate: true,
        mode: 0o600,
      });
      try {
        const bytes = new TextEncoder().encode(JSON.stringify(data));
        let offset = 0;
        // A successful write may accept only a prefix. Never publish the
        // temp file until every byte of the session has landed.
        while (offset < bytes.byteLength) {
          const written = await file.write(bytes.subarray(offset));
          if (written <= 0) throw new Error("session store accepted no bytes");
          offset += written;
        }
        await file.sync();
      } finally {
        file.close();
      }
      await Deno.rename(tmp, this.path);
    } catch (e) {
      await Deno.remove(tmp).catch(() => {});
      throw e;
    }
  }

  async getAll(): Promise<Data> {
    let text: string;
    try {
      text = await Deno.readTextFile(this.path);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return {};
      throw e;
    }
    return JSON.parse(text || "{}");
  }

  async get(key: Storage["Key"]): Promise<Storage["Value"] | undefined> {
    return (await this.getAll())[key];
  }

  set(key: Storage["Key"], value: Storage["Value"]): Promise<void> {
    return this.withLock(async () => {
      const data = await this.getAll();
      data[key] = value;
      await this.write(data);
    });
  }

  delete(key: Storage["Key"]): Promise<void> {
    return this.withLock(async () => {
      const data = await this.getAll();
      delete data[key];
      await this.write(data);
    });
  }

  clear(): Promise<void> {
    return this.withLock(() => this.write({}));
  }

  async migrate(storage: BaseStorage): Promise<void> {
    for (const [key, value] of Object.entries(await this.getAll())) {
      await storage.set(key, value);
    }
  }
}
