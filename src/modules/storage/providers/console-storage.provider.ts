import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  PresignedUpload,
  PresignUploadInput,
  StorageProvider,
  UploadBufferInput,
  UploadBufferResult,
} from '../storage.provider';

@Injectable()
export class ConsoleStorageProvider implements StorageProvider {
  /** In-memory store for testing — key → buffer. */
  private readonly store = new Map<string, { buffer: Buffer; contentType: string }>();

  presignUpload(input: PresignUploadInput): Promise<PresignedUpload> {
    const r2Key = `tenants/${input.tenantId}/photos/${randomUUID()}.${input.extension}`;
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
    return Promise.resolve({
      uploadUrl: `http://storage.local/upload/${r2Key}?expires=${expiresAt.toISOString()}`,
      r2Key,
      expiresAt,
      contentType: input.contentType,
      maxBytes: input.maxBytes,
    });
  }

  uploadBuffer(input: UploadBufferInput): Promise<UploadBufferResult> {
    const prefix = input.prefix ?? 'photos';
    const r2Key = `tenants/${input.tenantId}/${prefix}/${randomUUID()}.${input.extension}`;
    this.store.set(r2Key, { buffer: input.buffer, contentType: input.contentType });
    return Promise.resolve({ r2Key });
  }

  download(r2Key: string): Promise<Buffer> {
    const obj = this.store.get(r2Key);
    if (!obj) {
      return Promise.reject(new Error(`Object not found in console storage: ${r2Key}`));
    }
    return Promise.resolve(obj.buffer);
  }

  presignGet(r2Key: string, ttlSeconds: number): Promise<string> {
    return Promise.resolve(
      `http://storage.local/get/${r2Key}?expires=${new Date(Date.now() + ttlSeconds * 1000).toISOString()}`,
    );
  }

  delete(r2Key: string): Promise<void> {
    this.store.delete(r2Key);
    return Promise.resolve();
  }
}
