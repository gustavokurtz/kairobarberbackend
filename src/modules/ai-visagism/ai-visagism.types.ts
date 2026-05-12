export type FaceShape = 'oval' | 'round' | 'square' | 'heart' | 'oblong' | 'diamond';

export interface VisagismSuggestion {
  id: string; // ex: "fade-mid-curtain"
  name: string; // "Mid fade com franja"
  rationale: string;
  length: 'short' | 'medium' | 'long';
  style: string; // ex: "casual" | "formal" | "moderno"
  suitableFor: string[]; // ex: ["rosto oval", "cabelo liso"]
}

export interface VisagismAnalysis {
  faceShape: FaceShape;
  description: string;
  suggestions: VisagismSuggestion[];
}

export interface VisagismProviderAnalyzeResult {
  analysis: VisagismAnalysis;
  costCents: number;
  providerMeta: Record<string, unknown>;
}

export interface VisagismProviderGenerateResult {
  imageBuffer: Buffer;
  imageMimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  costCents: number;
  providerMeta: Record<string, unknown>;
}
