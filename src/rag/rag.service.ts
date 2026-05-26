import { Injectable, Logger } from '@nestjs/common';
import { GeminiService } from '../llm/gemini.service';
import { EmbeddingsService } from './embeddings/embeddings.service';
import {
  SimilarityHit,
  TranscriptChunkRepository,
} from './repositories/transcript-chunk.repository';

export interface SearchOptions {
  query: string;
  topK?: number;
  courseIds?: number[];
  lessonIds?: number[];
}

export interface AskOptions extends SearchOptions {
  /** Maximum chunks fed to the LLM as context. */
  contextSize?: number;
}

export interface AskResult {
  answer: string;
  sources: {
    courseId: number;
    courseTitle: string;
    lessonId: number;
    lessonTitle: string;
    coursePosition: number;
    startMs: number;
    endMs: number;
    excerpt: string;
    distance: number;
  }[];
}

export interface SummarizeOptions {
  courseId: number;
  /** Maximum chunks/lessons fed to the LLM (avoid context overflow). */
  maxChunks?: number;
}

export interface SummaryLesson {
  lessonId: number;
  lessonTitle: string;
  position: number;
  startMs: number;
  bullets: string[];
}

export interface SummaryResult {
  courseId: number;
  courseTitle: string;
  /** Short paragraph (TL;DR). */
  tldr: string;
  /** Per-lesson key points. */
  lessons: SummaryLesson[];
  /** Whether the course is indexed in the RAG store. */
  available: boolean;
}

export interface LearnerTextOptions {
  courseId: number;
  /** Course title from the CEFIS catalog (fallback when transcripts missing). */
  courseTitle?: string;
  /** Course summary from the CEFIS catalog (used as extra grounding). */
  courseSummary?: string;
  /** Course goals from the CEFIS catalog. */
  courseGoals?: string[];
  /** Goals selected by the learner during onboarding (e.g. "crc"). */
  learnerGoals?: string[];
  /** Optional topic title from the plan stop being expanded. */
  stopTopic?: string;
  /** Learner level (iniciante/intermediario/avancado). */
  learnerLevel?: string;
  /** Maximum chunks fed to the LLM (avoid context overflow). */
  maxChunks?: number;
}

export interface LearnerTextResult {
  courseId: number;
  courseTitle: string;
  /** Short paragraph tailored to the learner. */
  tldr: string;
  /** Per-lesson key points tailored to the learner. */
  lessons: SummaryLesson[];
  /** Free-form essay-style read aligned to learner goals. */
  body: string;
  /** Whether the course is indexed in the RAG store. */
  available: boolean;
}

function msToTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

@Injectable()
export class RagService {
  private readonly log = new Logger(RagService.name);

  constructor(
    private readonly embeddings: EmbeddingsService,
    private readonly chunkRepo: TranscriptChunkRepository,
    private readonly gemini: GeminiService,
  ) {}

  async search(opts: SearchOptions): Promise<SimilarityHit[]> {
    const query = opts.query?.trim();
    if (!query) return [];
    const vec = await this.embeddings.embedQuery(query);
    if (!vec?.length) {
      this.log.warn('search aborted — empty embedding');
      return [];
    }
    return this.chunkRepo.search({
      embedding: vec,
      topK: opts.topK ?? 8,
      courseIds: opts.courseIds,
      lessonIds: opts.lessonIds,
    });
  }

  /**
   * Returns the subset of indexed course IDs whose categories intersect
   * with the given category IDs. Used to decide whether to apply RAG
   * grounding when generating quiz questions for specific categories.
   */
  findIndexedCoursesInCategories(categoryIds: number[]): Promise<number[]> {
    return this.chunkRepo.findCourseIdsByCategories(categoryIds);
  }

  async ask(opts: AskOptions): Promise<AskResult> {
    const contextSize = opts.contextSize ?? 6;
    const hits = await this.search({ ...opts, topK: contextSize });
    if (!hits.length) {
      return {
        answer:
          'Não encontrei trechos relevantes nas transcrições para responder. Tente reformular a pergunta ou ampliar o escopo de cursos.',
        sources: [],
      };
    }
    const contextBlock = hits
      .map(
        (h, i) =>
          `[#${i + 1}] Curso "${h.courseTitle}" — aula "${h.lessonTitle}" (pos. ${h.coursePosition}, ${msToTimestamp(h.startMs)}–${msToTimestamp(h.endMs)}):\n${h.text}`,
      )
      .join('\n\n');

    const prompt = `Você é um tutor que ajuda alunos a entender o conteúdo de cursos.

PERGUNTA DO ALUNO:
${opts.query}

TRECHOS DE AULAS RECUPERADOS (use APENAS estes para responder):
${contextBlock}

INSTRUÇÕES:
- Responda em português brasileiro, de forma clara e didática.
- Cite as fontes usando os números entre colchetes (ex: [#1], [#2]).
- Se os trechos forem insuficientes para responder com segurança, diga isso explicitamente.
- Não invente informações que não estejam nos trechos.`;

    const responseSchema = {
      type: 'OBJECT',
      properties: {
        answer: { type: 'STRING' },
      },
      required: ['answer'],
    };

    const llmOut = await this.gemini.generateJson<{ answer: string }>(
      prompt,
      responseSchema,
      { temperature: 0.3, model: 'gemini-2.5-flash' },
    );

    return {
      answer:
        llmOut?.answer?.trim() ??
        'Falha ao gerar resposta com o modelo. Tente novamente.',
      sources: hits.map((h) => ({
        courseId: h.courseId,
        courseTitle: h.courseTitle,
        lessonId: h.lessonId,
        lessonTitle: h.lessonTitle,
        coursePosition: h.coursePosition,
        startMs: h.startMs,
        endMs: h.endMs,
        excerpt: h.text.length > 280 ? `${h.text.slice(0, 280)}…` : h.text,
        distance: h.distance,
      })),
    };
  }

  /**
   * Builds a structured summary of a course using its transcripts.
   * Returns `available: false` when the course is not indexed in pgvector.
   */
  async summarize(opts: SummarizeOptions): Promise<SummaryResult> {
    const rows = await this.chunkRepo.listByCourse(opts.courseId);
    if (!rows.length) {
      return {
        courseId: opts.courseId,
        courseTitle: '',
        tldr: '',
        lessons: [],
        available: false,
      };
    }
    const maxChunks = opts.maxChunks ?? 40;
    const trimmed = rows.slice(0, maxChunks);
    const courseTitle = trimmed[0].courseTitle;

    type LessonMeta = {
      lessonId: number;
      lessonTitle: string;
      position: number;
      startMs: number;
      texts: string[];
    };
    const lessonMap = new Map<number, LessonMeta>();
    for (const r of trimmed) {
      const cur = lessonMap.get(r.lessonId);
      if (cur) {
        cur.texts.push(r.text);
      } else {
        lessonMap.set(r.lessonId, {
          lessonId: r.lessonId,
          lessonTitle: r.lessonTitle,
          position: r.coursePosition,
          startMs: r.startMs,
          texts: [r.text],
        });
      }
    }
    const lessons = Array.from(lessonMap.values()).sort(
      (a, b) => a.position - b.position,
    );

    const lessonsBlock = lessons
      .map((l, i) => {
        const joined = l.texts.join(' ').replace(/\s+/g, ' ').trim();
        const excerpt = joined.length > 1400 ? `${joined.slice(0, 1400)}…` : joined;
        return `[Aula ${i + 1} — "${l.lessonTitle}"]\n${excerpt}`;
      })
      .join('\n\n');

    const prompt = `Você é um assistente que cria resumos didáticos de cursos para alunos.

Curso: "${courseTitle}"

TRANSCRIÇÕES DAS AULAS (em ordem):
${lessonsBlock}

INSTRUÇÕES:
- Gere um resumo estruturado em português brasileiro.
- "tldr": um parágrafo curto (3-4 frases) explicando o que o aluno aprenderá no curso como um todo.
- "lessons": para cada aula listada, retorne 2 a 3 bullets curtos (máx 14 palavras cada) com os pontos-chave que o aluno deve guardar.
- Use APENAS o conteúdo das transcrições — não invente informação.
- Mantenha a MESMA ordem e o MESMO número de aulas que apareceram acima.`;

    const responseSchema = {
      type: 'OBJECT',
      properties: {
        tldr: { type: 'STRING' },
        lessons: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              title: { type: 'STRING' },
              bullets: {
                type: 'ARRAY',
                items: { type: 'STRING' },
              },
            },
            required: ['title', 'bullets'],
          },
        },
      },
      required: ['tldr', 'lessons'],
    };

    const llmOut = await this.gemini.generateJson<{
      tldr: string;
      lessons: { title: string; bullets: string[] }[];
    }>(prompt, responseSchema, {
      temperature: 0.3,
      maxOutputTokens: 1536,
    });

    if (!llmOut) {
      return {
        courseId: opts.courseId,
        courseTitle,
        tldr: '',
        lessons: lessons.map((l) => ({
          lessonId: l.lessonId,
          lessonTitle: l.lessonTitle,
          position: l.position,
          startMs: l.startMs,
          bullets: [],
        })),
        available: true,
      };
    }

    const bulletsByIndex = new Map<number, string[]>();
    llmOut.lessons.forEach((l, i) => {
      bulletsByIndex.set(i, Array.isArray(l.bullets) ? l.bullets : []);
    });

    return {
      courseId: opts.courseId,
      courseTitle,
      tldr: llmOut.tldr?.trim() ?? '',
      lessons: lessons.map((l, i) => ({
        lessonId: l.lessonId,
        lessonTitle: l.lessonTitle,
        position: l.position,
        startMs: l.startMs,
        bullets: bulletsByIndex.get(i) ?? [],
      })),
      available: true,
    };
  }

  /**
   * Builds a text-format study material for a plan stop, grounded on the
   * course transcripts and tailored using the learner's goals and the
   * course catalog metadata (summary + goals).
   */
  async generateLearnerText(
    opts: LearnerTextOptions,
  ): Promise<LearnerTextResult> {
    const rows = await this.chunkRepo.listByCourse(opts.courseId);
    if (!rows.length) {
      return this.generateLearnerTextFromCatalog(opts);
    }
    const maxChunks = opts.maxChunks ?? 40;
    const trimmed = rows.slice(0, maxChunks);
    const courseTitle = trimmed[0].courseTitle;

    type LessonMeta = {
      lessonId: number;
      lessonTitle: string;
      position: number;
      startMs: number;
      texts: string[];
    };
    const lessonMap = new Map<number, LessonMeta>();
    for (const r of trimmed) {
      const cur = lessonMap.get(r.lessonId);
      if (cur) {
        cur.texts.push(r.text);
      } else {
        lessonMap.set(r.lessonId, {
          lessonId: r.lessonId,
          lessonTitle: r.lessonTitle,
          position: r.coursePosition,
          startMs: r.startMs,
          texts: [r.text],
        });
      }
    }
    const lessons = Array.from(lessonMap.values()).sort(
      (a, b) => a.position - b.position,
    );

    const lessonsBlock = lessons
      .map((l, i) => {
        const joined = l.texts.join(' ').replace(/\s+/g, ' ').trim();
        const excerpt =
          joined.length > 1400 ? `${joined.slice(0, 1400)}…` : joined;
        return `[Aula ${i + 1} — "${l.lessonTitle}"]\n${excerpt}`;
      })
      .join('\n\n');

    const learnerGoals = (opts.learnerGoals ?? []).join(', ') || '—';
    const courseGoals = (opts.courseGoals ?? []).join(' | ') || '—';
    const courseSummary = (opts.courseSummary ?? '').slice(0, 600) || '—';
    const stopTopic = opts.stopTopic ?? courseTitle;
    const learnerLevel = opts.learnerLevel ?? 'iniciante';

    const prompt = `Você é um tutor que escreve um RESUMÃO em texto do curso inteiro da CEFIS para o aluno ler como alternativa às aulas em vídeo.

CONTEXTO DO ALUNO:
- Nível: ${learnerLevel}
- Objetivos pessoais: ${learnerGoals}
- Tópico atual da trilha: "${stopTopic}"

CONTEXTO DO CURSO "${courseTitle}" (do catálogo CEFIS):
- Resumo oficial: ${courseSummary}
- Objetivos declarados do curso: ${courseGoals}

TRANSCRIÇÕES DAS AULAS DO CURSO (em ordem cronológica):
${lessonsBlock}

INSTRUÇÕES:
- Escreva em português brasileiro, didático, fluente — como um texto que substitui assistir o curso.
- Use o RESUMO OFICIAL e os OBJETIVOS DO CURSO acima para orientar a estrutura e o tom: o texto deve entregar aquilo que o catálogo promete ao aluno.
- "tldr": pode retornar string vazia "" — não será exibido ao aluno.
- "body": resumão CORRIDO de 3 a 5 parágrafos cobrindo o curso inteiro em ordem lógica (introdução → conceitos centrais → aplicações/fechamento). Separe parágrafos com linha em branco (\\n\\n). NÃO use bullets, listas, títulos nem markdown. Texto fluente, didático. Faça ligações com os objetivos do aluno quando natural.
- "lessons": retorne array VAZIO [] — não será exibido.
- REGRA ANTI-ALUCINAÇÃO: o conteúdo factual deve vir das TRANSCRIÇÕES. Resumo/objetivos do catálogo servem para enquadrar e priorizar, NÃO para inventar fatos.
- Se as transcrições não cobrirem algo que o catálogo promete, sinalize ("o curso aborda X principalmente nas aulas práticas") em vez de inventar detalhes.`;

    const responseSchema = {
      type: 'object',
      properties: {
        tldr: { type: 'string' },
        body: { type: 'string' },
        lessons: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              bullets: { type: 'array', items: { type: 'string' } },
            },
            required: ['title', 'bullets'],
          },
        },
      },
      required: ['tldr', 'body', 'lessons'],
    };

    const llmOut = await this.gemini.generateJson<{
      tldr: string;
      body: string;
      lessons: { title: string; bullets: string[] }[];
    }>(prompt, responseSchema, {
      temperature: 0.2,
      maxOutputTokens: 2048,
    });

    if (!llmOut) {
      return {
        courseId: opts.courseId,
        courseTitle,
        tldr: '',
        body: '',
        lessons: lessons.map((l) => ({
          lessonId: l.lessonId,
          lessonTitle: l.lessonTitle,
          position: l.position,
          startMs: l.startMs,
          bullets: [],
        })),
        available: true,
      };
    }

    const bulletsByIndex = new Map<number, string[]>();
    llmOut.lessons.forEach((l, i) => {
      bulletsByIndex.set(i, Array.isArray(l.bullets) ? l.bullets : []);
    });

    return {
      courseId: opts.courseId,
      courseTitle,
      tldr: llmOut.tldr?.trim() ?? '',
      body: llmOut.body?.trim() ?? '',
      lessons: lessons.map((l, i) => ({
        lessonId: l.lessonId,
        lessonTitle: l.lessonTitle,
        position: l.position,
        startMs: l.startMs,
        bullets: bulletsByIndex.get(i) ?? [],
      })),
      available: true,
    };
  }

  /**
   * Fallback used when a course has no indexed transcripts. Builds the
   * learner-facing text purely from the catalog metadata (summary + goals)
   * and the learner profile.
   */
  private async generateLearnerTextFromCatalog(
    opts: LearnerTextOptions,
  ): Promise<LearnerTextResult> {
    const courseTitle = opts.courseTitle ?? '';
    const courseSummary = (opts.courseSummary ?? '').trim();
    const courseGoals = (opts.courseGoals ?? []).filter(Boolean);
    const learnerGoals = (opts.learnerGoals ?? []).join(', ') || '—';
    const learnerLevel = opts.learnerLevel ?? 'iniciante';
    const stopTopic = opts.stopTopic ?? courseTitle;

    if (!courseSummary && courseGoals.length === 0) {
      return {
        courseId: opts.courseId,
        courseTitle,
        tldr: '',
        lessons: [],
        body: '',
        available: false,
      };
    }

    const goalsBlock = courseGoals.length
      ? courseGoals.map((g, i) => `${i + 1}. ${g}`).join('\n')
      : '—';

    const prompt = `Você é um tutor da CEFIS. O curso "${courseTitle}" AINDA NÃO tem transcrições indexadas, então você vai produzir um material em texto usando APENAS o resumo oficial e os objetivos declarados do curso, conectando ao perfil do aluno.

CONTEXTO DO ALUNO:
- Nível: ${learnerLevel}
- Objetivos pessoais: ${learnerGoals}
- Tópico atual da trilha: "${stopTopic}"

CURSO "${courseTitle}" (catálogo CEFIS):
- Resumo oficial: ${courseSummary || '—'}
- Objetivos declarados do curso:
${goalsBlock}

INSTRUÇÕES:
- Escreva em português brasileiro, didático.
- "tldr": pode retornar string vazia "" — não será exibido.
- "body": texto CORRIDO de 3 a 5 parágrafos cobrindo, em ordem lógica, os pontos que o curso PROMETE entregar segundo o resumo e os objetivos. Separe parágrafos com linha em branco (\\n\\n). NÃO use bullets, listas nem markdown. Use linguagem como "o curso aborda…", "ao final você será capaz de…" — deixe claro que é uma visão geral do escopo.
- "lessons": retorne array VAZIO [].
- REGRA ANTI-ALUCINAÇÃO: trabalhe SÓ com o que está no resumo oficial e nos objetivos declarados. Não invente conceitos, números, definições ou exemplos que não estejam ali.`;

    const responseSchema = {
      type: 'object',
      properties: {
        tldr: { type: 'string' },
        body: { type: 'string' },
        lessons: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              bullets: { type: 'array', items: { type: 'string' } },
            },
            required: ['title', 'bullets'],
          },
        },
      },
      required: ['tldr', 'body', 'lessons'],
    };

    const llmOut = await this.gemini.generateJson<{
      tldr: string;
      body: string;
      lessons: { title: string; bullets: string[] }[];
    }>(prompt, responseSchema, {
      temperature: 0.2,
      maxOutputTokens: 1536,
    });

    return {
      courseId: opts.courseId,
      courseTitle,
      tldr: llmOut?.tldr?.trim() ?? '',
      body: llmOut?.body?.trim() ?? '',
      lessons: [],
      available: true,
    };
  }
}
