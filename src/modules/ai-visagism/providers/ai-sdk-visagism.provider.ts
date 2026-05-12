import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject, generateImage } from 'ai';
import { VisagismProvider } from './visagism.provider';
import {
  VisagismProviderAnalyzeResult,
  VisagismProviderGenerateResult,
  VisagismSuggestion,
} from '../ai-visagism.types';
import { visagismAnalysisSchema } from '../ai-visagism.schemas';
import { VISAGISM_SYSTEM_PROMPT } from '../prompts/visagism.system';
import { buildGenerationPrompt } from '../prompts/visagism.generation-prompt';

/**
 * Implementação real do VisagismProvider usando AI SDK v6.
 *
 * Notas de API v6 (vs v4 onde o plano original foi escrito):
 * - `experimental_generateImage` ainda existe como alias deprecated; usamos
 *   `generateImage` (export estável).
 * - `LanguageModelUsage` em v6 expõe `inputTokens` / `outputTokens` (não mais
 *   `promptTokens` / `completionTokens` como em v4). Os campos podem ser
 *   `undefined`, então tratamos como 0.
 * - `generateImage` aceita prompt como string OU como objeto
 *   `{ text?, images: DataContent[], mask? }`. Passamos o Buffer da foto direto
 *   como `images[0]` (DataContent inclui Buffer).
 * - `GenerateObjectResult.object` já vem tipado conforme schema Zod.
 * - `GeneratedFile.base64` é a string base64 do resultado de imagem.
 */
@Injectable()
export class AiSdkVisagismProvider implements VisagismProvider {
  private readonly groqModel: string;
  private readonly openaiImageModel: string;
  private readonly groqPricePerMtokCents: number;
  private readonly openaiImageCostCents: number;
  private readonly groq: ReturnType<typeof createGroq>;
  private readonly openai: ReturnType<typeof createOpenAI>;

  constructor(cfg: ConfigService) {
    this.groqModel = cfg.getOrThrow<string>('AI_VISAGISM_GROQ_MODEL');
    this.openaiImageModel = cfg.getOrThrow<string>('AI_VISAGISM_OPENAI_IMAGE_MODEL');
    this.groqPricePerMtokCents = cfg.getOrThrow<number>('AI_VISAGISM_GROQ_PRICE_PER_MTOK_CENTS');
    this.openaiImageCostCents = cfg.getOrThrow<number>('AI_VISAGISM_OPENAI_IMAGE_COST_CENTS');
    this.groq = createGroq({ apiKey: cfg.getOrThrow<string>('GROQ_API_KEY') });
    this.openai = createOpenAI({ apiKey: cfg.getOrThrow<string>('OPENAI_API_KEY') });
  }

  async analyze(input: {
    photoBuffer: Buffer;
    mimeType: string;
  }): Promise<VisagismProviderAnalyzeResult> {
    const { object, usage } = await generateObject({
      model: this.groq(this.groqModel),
      schema: visagismAnalysisSchema,
      system: VISAGISM_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Analise esta foto e siga as instruções do sistema.',
            },
            {
              type: 'file',
              mediaType: input.mimeType,
              data: input.photoBuffer,
            },
          ],
        },
      ],
    });

    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;
    const costCents = Math.ceil((totalTokens / 1_000_000) * this.groqPricePerMtokCents);

    return {
      analysis: object,
      costCents,
      providerMeta: {
        provider: 'groq',
        model: this.groqModel,
        inputTokens,
        outputTokens,
      },
    };
  }

  async generateImage(input: {
    photoBuffer: Buffer;
    mimeType: string;
    suggestion: VisagismSuggestion;
  }): Promise<VisagismProviderGenerateResult> {
    const prompt = buildGenerationPrompt(input.suggestion);

    const { image } = await generateImage({
      model: this.openai.image(this.openaiImageModel),
      prompt: {
        text: prompt,
        images: [input.photoBuffer],
      },
    });

    const imageBuffer = Buffer.from(image.base64, 'base64');

    return {
      imageBuffer,
      imageMimeType: 'image/png',
      costCents: this.openaiImageCostCents,
      providerMeta: {
        provider: 'openai',
        model: this.openaiImageModel,
        suggestionId: input.suggestion.id,
      },
    };
  }

  async healthCheck(): Promise<{ ok: boolean }> {
    // Não chamamos rede aqui — apenas validamos que os clients foram inicializados
    // (typeof === 'function' porque createGroq/createOpenAI retornam providers callable).
    const ok = typeof this.groq === 'function' && typeof this.openai === 'function';
    return { ok };
  }
}
