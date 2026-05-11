import { Injectable } from '@nestjs/common';
import { OneTimeTokenPurpose } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { OneTimeTokenRepository } from './repositories/one-time-token.repository';

@Injectable()
export class OneTimeTokenService {
  constructor(private readonly repo: OneTimeTokenRepository) {}

  async issue(userId: string, purpose: OneTimeTokenPurpose, ttlSeconds: number) {
    const plain = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(plain).digest('hex');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await this.repo.create({ userId, purpose, tokenHash, expiresAt });
    return { plain };
  }

  async consume(plain: string, purpose: OneTimeTokenPurpose) {
    const tokenHash = createHash('sha256').update(plain).digest('hex');
    const found = await this.repo.findValidByHash(tokenHash, purpose);
    if (!found) return null;
    await this.repo.markUsed(found.id);
    return { userId: found.userId };
  }
}
