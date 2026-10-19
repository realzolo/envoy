import { describe, expect, it, vi } from 'vitest';
import { createContentService } from '@/modules/identity/application/content';
import type { ContentRepository, ContentUnitOfWork, LockOwnedContentRow } from '@/modules/identity/application/content-ports';

function harness(row: LockOwnedContentRow | null, overrides: Partial<ContentRepository> = {}) {
  const calls: string[] = [];
  const empty = () => Promise.resolve({ rows: [], rowCount: 0 });
  const implementation: Partial<ContentRepository> = {
    lockOwnedContent: vi.fn(async () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 })),
    lockMessageSubmissions: empty,
    lockMessageDeliveries: empty,
    findUnsettledMessageWork: empty,
    findRetainedFileReferences: empty,
    lockContentCallbacks: empty,
    ...overrides,
  };
  const repository = new Proxy(implementation, {
    get(target, property) {
      const operation = target[property as keyof ContentRepository];
      return (...args: unknown[]) => {
        calls.push(String(property));
        if (!operation) throw new Error(`Unexpected operation: ${String(property)}`);
        return Reflect.apply(operation, target, args);
      };
    },
  }) as ContentRepository;
  const run = vi.fn(async (work: Parameters<ContentUnitOfWork['run']>[0]) => work(repository));
  const purge = createContentService({ run } as ContentUnitOfWork);
  return { purge, calls, implementation, run };
}

describe('content purge application invariants', () => {
  it('checks ownership inside the transaction and hides inaccessible resources', async () => {
    const { purge, calls, implementation, run } = harness(null);
    expect(await purge('message', 'message-1', 'service-1')).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    expect(implementation.lockOwnedContent).toHaveBeenCalledWith({ kind: 'message', id: 'message-1', serviceId: 'service-1' });
    expect(calls).toEqual(['lockOwnedContent']);
  });

  it('returns an existing tombstone without re-enqueuing deletion', async () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const { purge, calls } = harness({ content_purged_at: date });
    expect(await purge('file', 'file-1', 'service-1')).toEqual({ id: 'file-1', contentPurgedAt: date.toISOString(), objectDeletion: 'pending_or_complete' });
    expect(calls).toEqual(['lockOwnedContent']);
  });

  it('preserves files referenced by a retained message snapshot', async () => {
    const { purge, calls } = harness({ content_purged_at: null, object_key: 'private-key' }, {
      findRetainedFileReferences: async () => ({ rows: [], rowCount: 1 }),
    });
    await expect(purge('file', 'file-1', 'service-1')).rejects.toMatchObject({ code: 'CONTENT_SHARED' });
    expect(calls).toEqual(['lockOwnedContent', 'findRetainedFileReferences']);
  });

  it('locks submissions and deliveries before checking unsettled work', async () => {
    const { purge, calls } = harness({ content_purged_at: null }, {
      findUnsettledMessageWork: async () => ({ rows: [], rowCount: 1 }),
    });
    await expect(purge('message', 'message-1', 'service-1')).rejects.toMatchObject({ code: 'CONTENT_BUSY' });
    expect(calls).toEqual(['lockOwnedContent', 'lockMessageSubmissions', 'lockMessageDeliveries', 'findUnsettledMessageWork']);
  });

  it('preserves inbound content while attachment scanning is active', async () => {
    const { purge, calls } = harness({ content_purged_at: null, status: 'scanning' });
    await expect(purge('inbound', 'inbound-1', 'service-1')).rejects.toMatchObject({ code: 'CONTENT_BUSY' });
    expect(calls).toEqual(['lockOwnedContent']);
  });

  it('preserves callback payloads while delivery is active', async () => {
    const { purge, calls } = harness({ content_purged_at: null, status: 'ready' }, {
      lockContentCallbacks: async () => ({ rows: [{ id: 'callback-1', status: 'delivering' }], rowCount: 1 }),
    });
    await expect(purge('inbound', 'inbound-1', 'service-1')).rejects.toMatchObject({ code: 'CONTENT_BUSY' });
    expect(calls).toEqual(['lockOwnedContent', 'lockContentCallbacks']);
  });

  it('records object deletion intent before tombstoning in the same unit of work', async () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const deletion = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const { purge, calls, run } = harness({ content_purged_at: null, object_key: 'private-key' }, {
      enqueueObjectDeletion: deletion,
      purgeOutboundFile: async () => ({ rows: [], rowCount: 1 }),
      recordContentPurge: async () => ({ rows: [], rowCount: 1 }),
      readContentTombstone: async () => ({ rows: [{ content_purged_at: date }], rowCount: 1 }),
    });
    expect(await purge('file', 'file-1', 'service-1')).toMatchObject({ contentPurgedAt: date.toISOString() });
    expect(deletion).toHaveBeenCalledWith({ key: 'private-key' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['lockOwnedContent', 'findRetainedFileReferences', 'enqueueObjectDeletion', 'purgeOutboundFile', 'recordContentPurge', 'readContentTombstone']);
  });
});
