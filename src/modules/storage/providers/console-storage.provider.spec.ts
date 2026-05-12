import { ConsoleStorageProvider } from './console-storage.provider';
import { extensionFromContentType } from '../storage.provider';

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

  it('extensionFromContentType() throws on unsupported content type', () => {
    expect(() => extensionFromContentType('application/pdf')).toThrow('Unsupported content type');
  });

  it('uploadBuffer salva e download recupera o mesmo buffer', async () => {
    const provider = new ConsoleStorageProvider();
    const buf = Buffer.from('hello-bytes');
    const { r2Key } = await provider.uploadBuffer({
      tenantId: 't1',
      buffer: buf,
      contentType: 'image/jpeg',
      extension: 'jpg',
      prefix: 'ai-visagism/input',
    });
    expect(r2Key).toMatch(/^tenants\/t1\/ai-visagism\/input\/[a-f0-9-]+\.jpg$/);
    const got = await provider.download(r2Key);
    expect(got.equals(buf)).toBe(true);
  });

  it('download lança erro quando key não existe', async () => {
    const provider = new ConsoleStorageProvider();
    await expect(provider.download('tenants/t1/photos/missing.jpg')).rejects.toThrow(
      /not found in console storage/,
    );
  });

  it('delete remove do store e download subsequente falha', async () => {
    const provider = new ConsoleStorageProvider();
    const { r2Key } = await provider.uploadBuffer({
      tenantId: 't1',
      buffer: Buffer.from('x'),
      contentType: 'image/png',
      extension: 'png',
    });
    await provider.delete(r2Key);
    await expect(provider.download(r2Key)).rejects.toThrow();
  });

  it('presignGet retorna URL determinística do console', async () => {
    const provider = new ConsoleStorageProvider();
    const url = await provider.presignGet('tenants/t1/photos/abc.jpg', 60);
    expect(url).toContain('http://storage.local/get/tenants/t1/photos/abc.jpg');
    expect(url).toContain('expires=');
  });
});
