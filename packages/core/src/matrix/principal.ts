/**
 * Who a request acts for, as `auth` returned it (see `AuthResult`). `id` selects the store
 * namespace of the principal's history; other fields (roles, tenant, ...) are handed to agents
 * and tools as they are (`ctx.principal`).
 */
export type Principal = {
  readonly id: string;
  readonly [claim: string]: unknown;
};

/** @internal Throws unless `principal` has a non-empty string `id`. */
export function assertPrincipal(principal: unknown, where: string): asserts principal is Principal {
  const id = (principal as { id?: unknown } | null | undefined)?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${where}: a principal needs a non-empty string id, got ${JSON.stringify(id)}`);
  }
}
