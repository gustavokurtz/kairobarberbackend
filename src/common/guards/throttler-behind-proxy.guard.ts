import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

// Em produção a API roda atrás do proxy do Railway (e qualquer outro reverse-proxy
// no caminho). Sem custom tracker + trust proxy, req.ip vira o IP do gateway —
// todos os usuários compartilham o mesmo "IP" do ponto de vista do throttler,
// e a app inteira fica limitada a `limit` req/min somados.
//
// req.ips é populado pelo Express quando `trust proxy` está habilitado (main.ts).
// Quando vazio (chamada direta sem proxy), cai pro req.ip do socket.
@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const ips = (req.ips as string[] | undefined) ?? [];
    const tracker = ips.length > 0 ? ips[0] : ((req.ip as string | undefined) ?? 'unknown');
    return Promise.resolve(tracker);
  }
}
