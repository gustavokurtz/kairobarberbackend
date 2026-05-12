import {
  VisagismProviderAnalyzeResult,
  VisagismProviderGenerateResult,
  VisagismSuggestion,
} from '../ai-visagism.types';

export interface VisagismProvider {
  analyze(input: { photoBuffer: Buffer; mimeType: string }): Promise<VisagismProviderAnalyzeResult>;
  generateImage(input: {
    photoBuffer: Buffer;
    mimeType: string;
    suggestion: VisagismSuggestion;
  }): Promise<VisagismProviderGenerateResult>;
  healthCheck(): Promise<{ ok: boolean }>;
}
