import { generateViewToken, hashViewToken } from './ai-visagism.service';

describe('AiVisagismService — token determinism', () => {
  it('hashViewToken é determinístico e !== plain', () => {
    const { plain, hash } = generateViewToken();
    expect(hash).not.toEqual(plain);
    expect(hashViewToken(plain)).toEqual(hash);
    expect(hash).toHaveLength(64); // sha256 hex
  });
});
