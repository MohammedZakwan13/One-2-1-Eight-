import { describe, expect, it, vi } from 'vitest';
import { createUploadSession } from '@/lib/upload-session';

const remover = () => vi.fn(async () => undefined);

describe('upload session', () => {
  it('abandon deletes every file uploaded in the session and empties it', async () => {
    const a = remover(); const b = remover();
    const session = createUploadSession();
    session.track('url-a', a); session.track('url-b', b);
    expect(session.size).toBe(2);
    await session.abandon();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(session.size).toBe(0);
  });

  it('commit keeps what the saved record uses and deletes the rest of this session\'s uploads', async () => {
    const used = remover(); const unused = remover();
    const session = createUploadSession();
    session.track('used', used); session.track('unused', unused);
    await session.commit(['used', 'something-saved-earlier']);
    expect(used).not.toHaveBeenCalled();
    expect(unused).toHaveBeenCalledTimes(1);
    expect(session.size).toBe(0);
  });

  it('after a commit the editor closing deletes nothing', async () => {
    const used = remover();
    const session = createUploadSession();
    session.track('used', used);
    await session.commit(['used']);
    await session.abandon();
    expect(used).not.toHaveBeenCalled();
  });

  it('forget removes a file that was already deleted, so it is never deleted twice', async () => {
    const a = remover();
    const session = createUploadSession();
    session.track('a', a);
    session.forget('a');
    await session.abandon();
    expect(a).not.toHaveBeenCalled();
  });

  it('a failing delete never breaks closing the editor, and the other files are still deleted', async () => {
    const broken = vi.fn(async () => { throw new Error('storage down'); });
    const fine = remover();
    const throwsSync = vi.fn(() => { throw new Error('boom'); });
    const session = createUploadSession();
    session.track('x', broken); session.track('y', fine); session.track('z', throwsSync as unknown as () => Promise<unknown>);
    await expect(session.abandon()).resolves.toBeUndefined();
    expect(fine).toHaveBeenCalledTimes(1);
    expect(session.size).toBe(0);
  });

  it('stays usable after abandon (React may run a cleanup and set the effect up again in development)', async () => {
    const first = remover(); const second = remover();
    const session = createUploadSession();
    await session.abandon();
    session.track('first', first);
    await session.abandon();
    session.track('second', second);
    await session.commit(['second']);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('files that were saved before the session began are never registered, so nothing here can delete them', async () => {
    const session = createUploadSession();
    await session.commit([]);
    await session.abandon();
    expect(session.size).toBe(0);
  });
});
