import { PhotosService } from './photos.service';
import { PhotoRepository } from './repositories/photo.repository';
import { StorageProvider } from 'src/modules/storage/storage.provider';
import { ErrorCodes } from 'src/common/exceptions/error-codes';

describe('PhotosService', () => {
  let repo: jest.Mocked<PhotoRepository>;
  let storage: jest.Mocked<StorageProvider>;
  let svc: PhotosService;

  beforeEach(() => {
    repo = {
      list: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      softDelete: jest.fn(),
    } as unknown as jest.Mocked<PhotoRepository>;
    storage = {
      presignUpload: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      uploadBuffer: jest.fn(),
      download: jest.fn(),
      presignGet: jest.fn(),
    };
    svc = new PhotosService(repo, storage);
  });

  it('createUploadUrl() rejects invalid contentType', async () => {
    await expect(svc.createUploadUrl('t1', 'application/pdf')).rejects.toMatchObject({
      opts: { code: ErrorCodes.STORAGE_CONTENT_TYPE_INVALID },
    });
  });

  it('createUploadUrl() returns presigned URL for jpeg', async () => {
    storage.presignUpload.mockResolvedValue({
      uploadUrl: 'http://x/y',
      r2Key: 'tenants/t1/photos/uuid.jpg',
      expiresAt: new Date(Date.now() + 60_000),
      contentType: 'image/jpeg',
      maxBytes: 5 * 1024 * 1024,
    });
    const out = await svc.createUploadUrl('t1', 'image/jpeg');
    expect(out.r2Key).toMatch(/tenants\/t1\/photos\//);
    expect(out.uploadUrl).toBe('http://x/y');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(storage.presignUpload).toHaveBeenCalledWith({
      tenantId: 't1',
      contentType: 'image/jpeg',
      extension: 'jpg',
      maxBytes: 5 * 1024 * 1024,
      ttlSeconds: 60,
    });
  });

  it('confirm() persists photo record', async () => {
    repo.create.mockResolvedValue({ id: 'p1', r2Key: 'k', tenantId: 't1' } as never);
    const out = await svc.confirm({ r2Key: 'k', caption: 'cap' });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.create).toHaveBeenCalledWith({ r2Key: 'k', caption: 'cap' });
    expect(out.id).toBe('p1');
  });

  it('delete() throws when not found', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(svc.delete('p1')).rejects.toMatchObject({
      opts: { code: ErrorCodes.PHOTO_NOT_FOUND },
    });
  });

  it('delete() marks deleted (storage cleanup deferred to cron)', async () => {
    repo.findById.mockResolvedValue({ id: 'p1', r2Key: 'k' } as never);
    await svc.delete('p1');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.softDelete).toHaveBeenCalledWith('p1');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
