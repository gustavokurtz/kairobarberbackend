import { z } from 'zod';

export const faceShapeSchema = z.enum(['oval', 'round', 'square', 'heart', 'oblong', 'diamond']);

export const visagismSuggestionSchema = z.object({
  id: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'id deve ser kebab-case'),
  name: z.string().min(2).max(80),
  rationale: z.string().min(20).max(600),
  length: z.enum(['short', 'medium', 'long']),
  style: z.string().min(2).max(40),
  suitableFor: z.array(z.string().min(2).max(80)).min(1).max(6),
});

export const visagismAnalysisSchema = z.object({
  faceShape: faceShapeSchema,
  description: z.string().min(40).max(800),
  suggestions: z.array(visagismSuggestionSchema).min(2).max(4),
});

export type VisagismAnalysisSchema = z.infer<typeof visagismAnalysisSchema>;
