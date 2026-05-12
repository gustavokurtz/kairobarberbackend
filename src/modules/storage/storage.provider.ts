export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

export type PresignedUpload = {
  uploadUrl: string;
  r2Key: string;
  expiresAt: Date;
  contentType: string;
  maxBytes: number;
};

export interface StorageProvider {
  /**
   * Returns a presigned PUT URL that lets the client upload directly to the underlying object store.
   * Caller MUST validate contentType before calling.
   */
  presignUpload(input: {
    tenantId: string;
    contentType: string;
    extension: string;
    maxBytes: number;
    ttlSeconds: number;
  }): Promise<PresignedUpload>;

  /** Best-effort delete; missing object is not an error. */
  delete(r2Key: string): Promise<void>;
}

export const ALLOWED_PHOTO_CONTENT_TYPES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export const PHOTO_MAX_BYTES = 5 * 1024 * 1024; // 5MB

export function extensionFromContentType(contentType: string): string {
  switch (contentType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    default:
      throw new Error(`Unsupported content type: ${contentType}`);
  }
}
