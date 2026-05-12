import { ConfigService } from '@nestjs/config';

const generateObjectMock = jest.fn();
const generateImageMock = jest.fn();

// Mock do pacote `ai` (AI SDK v6). Em v6 `generateImage` é o export estável
// e `experimental_generateImage` é um alias deprecated — mockamos ambos para
// que o provider funcione mesmo se trocarmos o import durante manutenção.
jest.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
  generateImage: (...args: unknown[]) => generateImageMock(...args),
  experimental_generateImage: (...args: unknown[]) => generateImageMock(...args),
}));

// `createGroq` em v6 retorna um GroqProvider que é callable (provider(modelId))
// e também tem .languageModel(modelId). Mockamos a forma callable.
jest.mock('@ai-sdk/groq', () => ({
  createGroq: jest.fn(() => {
    const fn = (model: string) => ({ __mock: 'groq-model', model });
    return fn;
  }),
}));

// `createOpenAI` em v6 retorna um OpenAIProvider callable que expõe `.image(modelId)`
// e `.imageModel(modelId)` para image generation.
jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: jest.fn(() => {
    const fn = (() => ({})) as unknown as {
      (modelId: string): unknown;
      image: (m: string) => unknown;
      imageModel: (m: string) => unknown;
    };
    fn.image = (m: string) => ({ __mock: 'openai-image-model', m });
    fn.imageModel = (m: string) => ({ __mock: 'openai-image-model', m });
    return fn;
  }),
}));

// eslint-disable-next-line import/first
import { AiSdkVisagismProvider } from './ai-sdk-visagism.provider';

function makeCfg(overrides: Record<string, string | number> = {}): ConfigService {
  const defaults: Record<string, string | number> = {
    AI_VISAGISM_GROQ_MODEL: 'meta-llama/llama-4-scout-17b-16e-instruct',
    AI_VISAGISM_OPENAI_IMAGE_MODEL: 'gpt-image-1',
    AI_VISAGISM_GROQ_PRICE_PER_MTOK_CENTS: 1,
    AI_VISAGISM_OPENAI_IMAGE_COST_CENTS: 4,
    GROQ_API_KEY: 'gsk_test',
    OPENAI_API_KEY: 'sk_test',
    ...overrides,
  };
  return {
    getOrThrow: <T,>(k: string) => defaults[k] as T,
  } as unknown as ConfigService;
}

describe('AiSdkVisagismProvider', () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
    generateImageMock.mockReset();
  });

  it('analyze envia messages com text + file e calcula costCents pelos tokens', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        faceShape: 'oval',
        description:
          'Rosto oval com proporções equilibradas; cabelo médio liso. Boa base para variedade de cortes.',
        suggestions: [
          {
            id: 'mid-fade-curtain',
            name: 'Mid fade com franja',
            rationale:
              'Mantém comprimento no topo e suaviza a largura das têmporas, equilibrando o rosto.',
            length: 'medium',
            style: 'moderno',
            suitableFor: ['rosto oval'],
          },
          {
            id: 'buzz-cut-classic',
            name: 'Buzz cut clássico',
            rationale: 'Realça mandíbula e exige pouca manutenção diária.',
            length: 'short',
            style: 'minimalista',
            suitableFor: ['rosto oval'],
          },
        ],
      },
      // v6: usage tem inputTokens/outputTokens (não promptTokens/completionTokens).
      usage: { inputTokens: 1_500_000, outputTokens: 500_000 }, // 2M tokens → 2 cents @ 1
    });

    const provider = new AiSdkVisagismProvider(makeCfg());
    const out = await provider.analyze({
      photoBuffer: Buffer.from('jpegdata'),
      mimeType: 'image/jpeg',
    });

    expect(out.analysis.faceShape).toBe('oval');
    expect(out.costCents).toBe(2);
    expect(out.providerMeta).toMatchObject({
      provider: 'groq',
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      inputTokens: 1_500_000,
      outputTokens: 500_000,
    });

    const args = generateObjectMock.mock.calls[0][0] as {
      messages: { role: string; content: { type: string }[] }[];
      schema: unknown;
      system: string;
    };
    expect(args.messages[0].content[0].type).toBe('text');
    expect(args.messages[0].content[1].type).toBe('file');
    expect(args.schema).toBeDefined();
    expect(args.system).toContain('visagismo');
  });

  it('generateImage usa o modelo OpenAI e devolve buffer + custo fixo', async () => {
    generateImageMock.mockResolvedValueOnce({
      // v6: GeneratedFile expõe base64 (string). uint8Array também existe, mas
      // o provider usa apenas base64.
      image: { base64: Buffer.from('fake-png').toString('base64') },
    });

    const provider = new AiSdkVisagismProvider(makeCfg());
    const out = await provider.generateImage({
      photoBuffer: Buffer.from('orig'),
      mimeType: 'image/jpeg',
      suggestion: {
        id: 'mid-fade-curtain',
        name: 'Mid fade',
        rationale: 'X',
        length: 'medium',
        style: 'moderno',
        suitableFor: ['rosto oval'],
      },
    });

    expect(out.imageBuffer.toString()).toBe('fake-png');
    expect(out.imageMimeType).toBe('image/png');
    expect(out.costCents).toBe(4);
    expect(out.providerMeta).toMatchObject({
      provider: 'openai',
      model: 'gpt-image-1',
      suggestionId: 'mid-fade-curtain',
    });

    // Confere que o prompt foi montado com text + images (forma de objeto do v6).
    const args = generateImageMock.mock.calls[0][0] as {
      prompt: { text: string; images: unknown[] };
    };
    expect(args.prompt.text).toContain('Mid fade');
    expect(args.prompt.images).toHaveLength(1);
  });

  it('analyze com usage ausente conta como 0 tokens → custo 0', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        faceShape: 'round',
        description:
          'Rosto redondo; recomendamos cortes com volume no topo para alongar visualmente as proporções verticais.',
        suggestions: [
          {
            id: 'high-fade-pomp',
            name: 'Topete alto',
            rationale: 'Alonga o rosto verticalmente.',
            length: 'medium',
            style: 'clássico',
            suitableFor: ['rosto redondo'],
          },
          {
            id: 'undercut-volume',
            name: 'Undercut com volume',
            rationale: 'Cria contraste vertical no rosto redondo.',
            length: 'medium',
            style: 'moderno',
            suitableFor: ['rosto redondo'],
          },
        ],
      },
      // sem usage
    });

    const provider = new AiSdkVisagismProvider(makeCfg());
    const out = await provider.analyze({
      photoBuffer: Buffer.from('x'),
      mimeType: 'image/png',
    });
    expect(out.costCents).toBe(0);
    expect(out.providerMeta).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});
