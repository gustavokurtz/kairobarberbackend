import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { S3Client, DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PresignedUpload, PresignUploadInput, StorageProvider } from '../storage.provider';

@Injectable()
export class R2StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: ConfigService) {
    const accountId = cfg.getOrThrow<string>('R2_ACCOUNT_ID');
    this.bucket = cfg.getOrThrow<string>('R2_BUCKET');
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: cfg.getOrThrow<string>('R2_ACCESS_KEY_ID'),
        secretAccessKey: cfg.getOrThrow<string>('R2_SECRET_ACCESS_KEY'),
      },
    });
  }

  async presignUpload(input: PresignUploadInput): Promise<PresignedUpload> {
    const r2Key = `tenants/${input.tenantId}/photos/${randomUUID()}.${input.extension}`;
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: r2Key,
      ContentType: input.contentType,
      ContentLength: input.maxBytes,
    });
    const uploadUrl = await getSignedUrl(this.client, cmd, { expiresIn: input.ttlSeconds });
    return {
      uploadUrl,
      r2Key,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
      contentType: input.contentType,
      maxBytes: input.maxBytes,
    };
  }

  async delete(r2Key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: r2Key }));
    } catch {
      // best-effort
    }
  }
}
