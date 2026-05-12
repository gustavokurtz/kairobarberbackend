import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PresignedUpload, StorageProvider } from '../storage.provider';

@Injectable()
export class ConsoleStorageProvider implements StorageProvider {
  presignUpload(input: {
    tenantId: string;
    contentType: string;
    extension: string;
    maxBytes: number;
    ttlSeconds: number;
  }): Promise<PresignedUpload> {
    const r2Key = `tenants/${input.tenantId}/photos/${randomUUID()}.${input.extension}`;
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
    const uploadUrl = `http://storage.local/upload/${r2Key}?expires=${expiresAt.toISOString()}`;
    return Promise.resolve({
      uploadUrl,
      r2Key,
      expiresAt,
      contentType: input.contentType,
      maxBytes: input.maxBytes,
    });
  }

  delete(_r2Key: string): Promise<void> {
    // no-op in console mode
    return Promise.resolve();
  }
}
