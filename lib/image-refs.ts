/**
 * Pure rules for optional images. Kept free of server imports so they are unit-tested directly.
 *
 * Field presence matters: `undefined` (omitted) means "leave as is", while `[]` / `''` is an explicit request to remove.
 * Never use truthiness here, or an intentional removal would be turned back into "reuse the previous image".
 */

/** Images a product should have after a save. Omitted = keep the stored ones; an explicit array (even empty) wins. */
export const resolveProductImages = (requested: readonly string[] | undefined, stored: readonly string[]): string[] => (requested === undefined ? [...stored] : [...requested]);

/** Image a category should have after a save. Omitted = keep; '' = removed. */
export const resolveCategoryImage = (requested: string | undefined, stored: string): string => (requested === undefined ? stored : requested);

/** Stored objects that an update stopped using: candidates for cleanup (still subject to the reference check). */
export const releasedImages = (before: readonly string[], after: readonly string[]): string[] => {
  const kept = new Set(after);
  return [...new Set(before)].filter(path => path !== '' && !kept.has(path));
};

/** Only objects proven unreferenced may be deleted. An unknown answer (a failed lookup) counts as "still referenced". */
export const deletableImages = (released: readonly string[], referenced: ReadonlyMap<string, boolean | null>): string[] => released.filter(path => referenced.get(path) === false);
