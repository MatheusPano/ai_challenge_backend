import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeminiService } from '../llm/gemini.service';
import { RagService } from '../rag/rag.service';
import { SimilarityHit } from '../rag/repositories/transcript-chunk.repository';

const CATEGORIES: Record<number, string> = {
  1: 'Fiscal',
  2: 'Contábil',
  3: 'Trabalhista',
  4: 'Outro',
  5: 'Gestão',
  6: 'Desenvolvimento Pessoal',
  7: 'Tecnologia',
};

const GOAL_LABELS: Record<string, string> = {
  carreira: 'evoluir na carreira (habilidades profissionais)',
  crc: 'acumular pontos CRC (créditos para o conselho)',
  concurso: 'passar em concurso público / certificação',
  conhecimento: 'ampliar conhecimento geral por curiosidade',
};

const SCHEMA = {
  type: 'object',
  properties: {
    enunciado: { type: 'string' },
    alternativas: {
      type: 'array',
      items: { type: 'string' },
      minItems: 4,
      maxItems: 4,
    },
    correta: { type: 'integer', minimum: 0, maximum: 3 },
    topico: { type: 'string' },
    explicacao: { type: 'string' },
  },
  required: ['enunciado', 'alternativas', 'correta', 'topico', 'explicacao'],
};

export type GenerateQuizInput = {
  goals: string[];
  categoryIds: number[];
  difficulty: 'easy' | 'medium' | 'hard';
  askedTopics: string[];
  /** Optional: restrict RAG grounding to a specific course (course-focused quiz). */
  courseId?: number;
};

export type Question = {
  id: string;
  enunciado: string;
  alternativas: string[];
  correta: number;
  dificuldade: 'easy' | 'medium' | 'hard';
  topico: string;
  explicacao: string;
};

const RAG_TOP_K = 4;
const RAG_EXCERPT_CHARS = 600;

@Injectable()
export class QuizService {
  private readonly log = new Logger(QuizService.name);

  constructor(
    private readonly gemini: GeminiService,
    private readonly rag: RagService,
    private readonly config: ConfigService,
  ) {}

  // Primary: gemini-2.5-flash-lite — native responseSchema, reliable JSON, fast (~1s).
  // Fallback: gemini-2.5-flash — same family, slightly larger, separate quota.
  // Gemma was tried as fallback but is 10x slower (~10s) and emits prose
  // before the JSON object, which torches tokens and breaks UX.
  private get quizModel(): string {
    return this.config.get<string>('QUIZ_MODEL', 'gemini-2.5-flash');
  }

  private get quizFallbackModel(): string {
    return this.config.get<string>(
      'QUIZ_FALLBACK_MODEL',
      'gemini-2.5-flash-lite',
    );
  }

  private buildRagQuery(input: GenerateQuizInput, categoryLabel: string): string {
    const goals =
      input.goals.map((g) => GOAL_LABELS[g] ?? g).join(', ') || 'conhecimento geral';
    const recentTopics = input.askedTopics.slice(-3).join(', ');
    const avoid = recentTopics
      ? ` (explore tópicos diferentes de: ${recentTopics})`
      : '';
    if (input.courseId) {
      return `principais conceitos e técnicas ensinadas no curso${avoid}`;
    }
    return `conceitos fundamentais de ${categoryLabel} para ${goals}${avoid}`;
  }

  private renderRagContext(hits: SimilarityHit[]): string {
    if (!hits.length) return '';
    return hits
      .map((h, i) => {
        const excerpt =
          h.text.length > RAG_EXCERPT_CHARS
            ? `${h.text.slice(0, RAG_EXCERPT_CHARS)}…`
            : h.text;
        return `[Trecho ${i + 1} — curso "${h.courseTitle}", aula "${h.lessonTitle}"]\n${excerpt}`;
      })
      .join('\n\n');
  }

  private mock(input: GenerateQuizInput): Question {
    const cat =
      input.categoryIds
        .map((id) => CATEGORIES[id])
        .filter(Boolean)
        .join(', ') || 'geral';
    return {
      id: `mock-${Date.now()}`,
      enunciado: `[MOCK ${input.difficulty}] Questão de ${cat} — IA temporariamente indisponível.`,
      alternativas: [
        'Alternativa A (correta)',
        'Alternativa B',
        'Alternativa C',
        'Alternativa D',
      ],
      correta: 0,
      dificuldade: input.difficulty,
      topico: cat,
      explicacao: 'Questão de exemplo (Gemini indisponível).',
    };
  }

  async generate(input: GenerateQuizInput): Promise<Question> {
    console.error('[QUIZ] generate called, provider=', this.gemini.provider, 'hasLlm=', this.gemini.hasLlm);
    if (!this.gemini.hasLlm) {
      this.log.warn(
        `Returning MOCK: no LLM configured (provider=${this.gemini.provider}, apiKey?=${!!this.gemini.apiKey})`,
      );
      return this.mock(input);
    }

    const cat =
      input.categoryIds
        .map((id) => CATEGORIES[id])
        .filter(Boolean)
        .join(', ') || 'geral';
    const goals =
      input.goals.map((g) => GOAL_LABELS[g] ?? g).join('; ') || 'geral';

    // Categoria é dono da verdade: o RAG SÓ é usado para grounding quando
    // existem cursos indexados pertencentes às categorias escolhidas pelo
    // aluno (ou quando um courseId específico foi pedido). Caso contrário,
    // o quiz é gerado puramente a partir do perfil + categoria, sem
    // contaminar com conteúdo de outro domínio.
    let courseIdsForSearch: number[] | undefined;
    if (input.courseId) {
      courseIdsForSearch = [input.courseId];
    } else if (input.categoryIds.length > 0) {
      const indexed = await this.rag
        .findIndexedCoursesInCategories(input.categoryIds)
        .catch((e: Error) => {
          this.log.warn(`RAG category lookup failed: ${e.message}`);
          return [] as number[];
        });
      if (indexed.length === 0) {
        this.log.debug(
          `No indexed courses in categories [${input.categoryIds.join(',')}] — generating ungrounded`,
        );
        courseIdsForSearch = []; // sentinel: skip RAG
      } else {
        courseIdsForSearch = indexed;
      }
    } else {
      courseIdsForSearch = []; // no category, no course → skip RAG
    }

    const ragHits =
      courseIdsForSearch && courseIdsForSearch.length > 0
        ? await this.rag
            .search({
              query: this.buildRagQuery(input, cat),
              topK: RAG_TOP_K,
              courseIds: courseIdsForSearch,
            })
            .catch((e: Error) => {
              this.log.warn(
                `RAG search failed, falling back to ungrounded: ${e.message}`,
              );
              return [] as SimilarityHit[];
            })
        : [];
    const ragContext = this.renderRagContext(ragHits);
    const grounded = ragContext.length > 0;
    if (grounded) {
      this.log.debug(
        `RAG grounded with ${ragHits.length} chunk(s) from ${new Set(ragHits.map((h) => h.courseId)).size} course(s)`,
      );
    }

    const prompt = `Gere UMA questão de múltipla escolha em português brasileiro para avaliar conhecimento.

Contexto do aluno:
- Objetivos: ${goals}
- Áreas: ${cat}
- Dificuldade desejada: ${input.difficulty} (easy=básico, medium=aplicação, hard=análise)
${input.askedTopics.length ? `- Evite estes tópicos já cobertos: ${input.askedTopics.join(', ')}` : ''}
${
  grounded
    ? `\nTRECHOS REAIS DAS AULAS DOS PROFESSORES (use como base da pergunta — NÃO invente conceitos fora deles):\n${ragContext}\n`
    : ''
}
Regras:
- Enunciado claro, máximo 3 frases
- 4 alternativas plausíveis, apenas UMA correta
- "correta" é o índice (0-3) da alternativa correta
- "topico" é um sub-tópico específico
- "explicacao" justifica a resposta correta em 1 frase${
      grounded
        ? '\n- A pergunta DEVE testar conhecimento contido nos trechos acima\n- A "explicacao" deve refletir o que o professor explicou nos trechos'
        : ''
    }`;

    type QuizPayload = {
      enunciado: string;
      alternativas: string[];
      correta: number;
      topico: string;
      explicacao: string;
    };

    // Primary attempt — gemini-2.5-flash-lite by default.
    let parsed = await this.gemini.generateJson<QuizPayload>(prompt, SCHEMA, {
      model: this.quizModel,
      temperature: 0.7,
      maxOutputTokens: 1024,
    });

    // Fallback to gemini-2.5-flash (separate quota tier) when the primary
    // model fails for any reason (quota / malformed JSON / empty response).
    if (!parsed) {
      this.log.warn(
        `${this.quizModel} failed for this question — falling back to ${this.quizFallbackModel}`,
      );
      parsed = await this.gemini.generateJson<QuizPayload>(prompt, SCHEMA, {
        model: this.quizFallbackModel,
        temperature: 0.7,
        maxOutputTokens: 1024,
      });
    }

    if (!parsed) return this.mock(input);

    return {
      id: `q-${Date.now()}`,
      enunciado: parsed.enunciado,
      alternativas: parsed.alternativas,
      correta: parsed.correta,
      dificuldade: input.difficulty,
      topico: parsed.topico,
      explicacao: parsed.explicacao,
    };
  }
}
