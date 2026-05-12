import { ConsoleStorageProvider } from './console-storage.provider';

describe('ConsoleStorageProvider', () => {
  const provider = new ConsoleStorageProvider();

  it('returns a presigned URL containing the tenant-scoped r2Key', async () => {
    const res = await provider.presignUpload({
      tenantId: 'tenant-1',
      contentType: 'image/jpeg',
      extension: 'jpg',
      maxBytes: 100,
      ttlSeconds: 60,
    });
    expect(res.r2Key).toMatch(/^tenants\/tenant-1\/photos\/[a-f0-9-]{36}\.jpg$/);
    expect(res.uploadUrl).toContain('storage.local');
    expect(res.uploadUrl).toContain(res.r2Key);
    expect(res.contentType).toBe('image/jpeg');
    expect(res.maxBytes).toBe(100);
    expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('delete() never throws even for unknown keys', async () => {
    await expect(provider.delete('nope')).resolves.toBeUndefined();
  });
});
