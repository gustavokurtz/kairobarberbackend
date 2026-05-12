import { VisagismSuggestion } from '../ai-visagism.types';

/**
 * Constrói o prompt textual passado para o modelo de geração de imagem (gpt-image-1).
 * O modelo recebe também a foto original como imagem de referência.
 */
export function buildGenerationPrompt(suggestion: VisagismSuggestion): string {
  return [
    'Edite a foto fornecida aplicando o seguinte corte de cabelo masculino no mesmo modelo.',
    `Corte: ${suggestion.name}.`,
    `Estilo: ${suggestion.style}.`,
    `Comprimento: ${suggestion.length}.`,
    `Justificativa do corte: ${suggestion.rationale}`,
    'Preserve traços faciais, iluminação, ângulo, fundo e roupa. Foco: modificar apenas o cabelo.',
    'Resultado realista, sem cartoonização.',
  ].join(' ');
}
