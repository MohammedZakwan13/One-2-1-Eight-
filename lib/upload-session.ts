/**
 * Tracks the files uploaded while ONE editor is open, so none is left behind in Storage when the editor ends without them being used.
 * Pure (no React, no network): each upload registers how to delete itself, and the editor decides the outcome.
 *
 *   track(url, remove)  a file was uploaded in this session and nothing saved refers to it yet
 *   forget(url)         that file was already deleted (replaced or removed in the form), stop tracking it
 *   commit(keep)        the save SUCCEEDED: keep the files the saved record uses, delete the rest of what this session uploaded
 *   abandon()           the editor closed or the save failed: delete everything this session uploaded and nothing saved refers to
 *
 * Files that were saved before this session began are never registered, so no path here can delete them. The server still refuses to
 * delete a file any banner references, which is the safety net if the answer to a save was lost on the way back.
 * Both end states leave the session empty and reusable (React may run an effect cleanup and set it up again in development).
 */
export type UploadSession = {
  track: (url: string, remove: () => Promise<unknown>) => void;
  forget: (url: string) => void;
  has: (url: string) => boolean;
  readonly size: number;
  commit: (keep: Iterable<string>) => Promise<void>;
  abandon: () => Promise<void>;
};

export function createUploadSession(): UploadSession {
  const pending = new Map<string, () => Promise<unknown>>();
  const removeAll = async (entries: [string, () => Promise<unknown>][]) => {
    // A failed delete only leaves a file for the periodic cleanup; it must never break closing the editor.
    await Promise.allSettled(entries.map(([, remove]) => Promise.resolve().then(remove)));
  };
  return {
    track: (url, remove) => { pending.set(url, remove); },
    forget: url => { pending.delete(url); },
    has: url => pending.has(url),
    get size() { return pending.size; },
    commit: async keep => {
      const kept = new Set(keep);
      const unused = [...pending].filter(([url]) => !kept.has(url));
      pending.clear();
      await removeAll(unused);
    },
    abandon: async () => {
      const all = [...pending];
      pending.clear();
      await removeAll(all);
    },
  };
}
