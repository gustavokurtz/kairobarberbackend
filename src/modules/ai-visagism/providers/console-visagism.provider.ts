import { Injectable } from '@nestjs/common';
import { VisagismProvider } from './visagism.provider';
import {
  VisagismProviderAnalyzeResult,
  VisagismProviderGenerateResult,
  VisagismSuggestion,
} from '../ai-visagism.types';

/**
 * Implementação determinística. Usada em NODE_ENV=test e como fallback
 * quando AI_VISAGISM_PROVIDER=console. Não toca em provider externo.
 */
@Injectable()
export class ConsoleVisagismProvider implements VisagismProvider {
  analyze(input: {
    photoBuffer: Buffer;
    mimeType: string;
  }): Promise<VisagismProviderAnalyzeResult> {
    // Fixture estável para testes — derivada por hash do buffer para variar entre payloads.
    const seed = input.photoBuffer.byteLength % 6;
    const shapes = ['oval', 'round', 'square', 'heart', 'oblong', 'diamond'] as const;
    return Promise.resolve({
      analysis: {
        faceShape: shapes[seed],
        description: `Análise determinística (console provider). Formato detectado: ${shapes[seed]}. Cabelo presumido médio.`,
        suggestions: [
          {
            id: 'mid-fade-curtain',
            name: 'Mid fade com franja',
            rationale:
              'Equilibra proporções verticais e mantém volume no topo, suavizando o formato do rosto.',
            length: 'medium',
            style: 'moderno',
            suitableFor: [`rosto ${shapes[seed]}`, 'cabelo liso ou ondulado'],
          },
          {
            id: 'buzz-cut-classic',
            name: 'Buzz cut clássico',
            rationale: 'Limpo, baixa manutenção, valoriza traços faciais marcantes.',
            length: 'short',
            style: 'minimalista',
            suitableFor: ['rosto bem definido', 'rotina prática'],
          },
        ],
      },
      costCents: 0,
      providerMeta: { provider: 'console', deterministic: true },
    });
  }

  generateImage(input: {
    photoBuffer: Buffer;
    mimeType: string;
    suggestion: VisagismSuggestion;
  }): Promise<VisagismProviderGenerateResult> {
    // Retorna um PNG mínimo 1x1 (fixture) — basta pra rotear pelo storage no teste.
    const pngMin = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
      'hex',
    );
    return Promise.resolve({
      imageBuffer: pngMin,
      imageMimeType: 'image/png',
      costCents: 0,
      providerMeta: { provider: 'console', suggestionId: input.suggestion.id },
    });
  }

  healthCheck(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }
}
