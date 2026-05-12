import { ConsoleVisagismProvider } from './console-visagism.provider';

describe('ConsoleVisagismProvider', () => {
  const provider = new ConsoleVisagismProvider();

  it('analyze retorna fixture com 2 sugestões e providerMeta.deterministic=true', async () => {
    const out = await provider.analyze({
      photoBuffer: Buffer.alloc(100),
      mimeType: 'image/jpeg',
    });
    expect(out.analysis.suggestions).toHaveLength(2);
    expect(out.analysis.faceShape).toBeDefined();
    expect(out.providerMeta.deterministic).toBe(true);
    expect(out.costCents).toBe(0);
  });

  it('analyze varia o faceShape conforme tamanho do buffer (determinístico por seed)', async () => {
    const a = await provider.analyze({ photoBuffer: Buffer.alloc(0), mimeType: 'image/jpeg' });
    const b = await provider.analyze({ photoBuffer: Buffer.alloc(3), mimeType: 'image/jpeg' });
    expect(a.analysis.faceShape).not.toBe(b.analysis.faceShape);
  });

  it('generateImage retorna PNG válido (header magic bytes)', async () => {
    const out = await provider.generateImage({
      photoBuffer: Buffer.alloc(10),
      mimeType: 'image/jpeg',
      suggestion: {
        id: 'mid-fade-curtain',
        name: 'x',
        rationale: 'y',
        length: 'medium',
        style: 'moderno',
        suitableFor: ['a'],
      },
    });
    expect(out.imageMimeType).toBe('image/png');
    // PNG signature: 89 50 4E 47
    expect(out.imageBuffer.slice(0, 4).toString('hex')).toBe('89504e47');
  });

  it('healthCheck sempre OK', async () => {
    await expect(provider.healthCheck()).resolves.toEqual({ ok: true });
  });
});
