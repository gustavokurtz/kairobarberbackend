import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { RefreshTokenRepository } from './repositories/refresh-token.repository';

export type AccessPayload = {
  sub: string;
  role: string;
  tenantId?: string;
};

@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly repo: RefreshTokenRepository,
  ) {}

  async issuePair(input: { userId: string; role: string; tenantId?: string }) {
    const accessToken = await this.jwt.signAsync(
      { sub: input.userId, role: input.role, tenantId: input.tenantId } satisfies AccessPayload,
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
        expiresIn: (this.config.get<string>('JWT_ACCESS_TTL') ?? '15m') as any,
      },
    );

    const refreshToken = randomBytes(48).toString('base64url');
    const tokenHash = this.hashRefresh(refreshToken);
    const ttlSeconds = this.parseTtl(this.config.get<string>('JWT_REFRESH_TTL') ?? '7d');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const stored = await this.repo.create({ userId: input.userId, tokenHash, expiresAt });

    return { accessToken, refreshToken, refreshTokenId: stored.id };
  }

  async verifyAccess(token: string): Promise<AccessPayload> {
    return this.jwt.verifyAsync<AccessPayload>(token, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  hashRefresh(plain: string): string {
    return createHash('sha256').update(plain).digest('hex');
  }

  private parseTtl(ttl: string): number {
    const m = ttl.match(/^(\d+)([smhd])$/);
    if (!m) throw new Error(`Invalid TTL: ${ttl}`);
    const n = Number(m[1]);
    return n * ({ s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2]];
  }
}
