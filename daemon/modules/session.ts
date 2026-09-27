/**
 * Session identity: the live LINE client and the generation counter that
 * marks which session asynchronous work belongs to.
 *
 * Both `client` and `sessionGeneration` are reassigned only here (login owns
 * the edges: onLoggedIn and logoutClaimed); every other module reads them as
 * ESM live bindings, so a read after a logout observes the new session. The
 * reassignments go through the setClient/bumpSessionGeneration accessors
 * because an imported binding cannot be assigned from outside its module --
 * the values, timing and ordering are unchanged.
 *
 * Dependency direction: session.ts is a leaf (type-only imports). Every other
 * module may import from it.
 */
import type { Client } from "@evex/linejs";

let client: Client | null = null;
/**
 * Monotonic owner for asynchronous session work. A client can finish a talk
 * request after logout (or after another account logged in); the generation
 * makes that completion observable as stale before it touches shared state.
 */
let sessionGeneration = 0;
function sessionIsCurrent(c: Client, generation: number): boolean {
  return client === c && sessionGeneration === generation;
}

/** Login/logout are the only writers; see the module doc above. */
export function setClient(c: Client | null): void {
  client = c;
}

/** Advances the generation, retiring every in-flight task of the old session. */
export function bumpSessionGeneration(): void {
  sessionGeneration++;
}

export { client, sessionGeneration, sessionIsCurrent };
