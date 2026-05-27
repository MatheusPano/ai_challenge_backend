import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CefisCourse, CefisService } from '../cefis/cefis.service';
import { GeneratedPlan } from '../entities/generated-plan.entity';
import { StopCompletion } from '../entities/stop-completion.entity';
import { StudentProfile } from '../entities/student-profile.entity';
import { GeminiService } from '../llm/gemini.service';
import { ProfileService } from '../profile/profile.service';
import { LearnerTextResult, RagService } from '../rag/rag.service';

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
  carreira: 'evoluir na carreira',
  crc: 'acumular pontos CRC',
  concurso: 'passar em concurso',
  conhecimento: 'ampliar conhecimento geral',
};

const SCHEMA = {
  type: 'object',
  properties: {
    stops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['topic', 'review'] },
          topic: { type: 'string' },
          summary: { type: 'string' },
          formats: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: {
                  type: 'string',
                  enum: ['video', 'text', 'quiz'],
                },
                label: { type: 'string' },
                estimatedMinutes: { type: 'integer' },
                courseId: { type: 'integer' },
                quizScope: { type: 'string', enum: ['review', 'topic'] },
                prompt: { type: 'string' },
              },
              required: ['kind', 'label', 'estimatedMinutes'],
            },
          },
        },
        required: ['kind', 'topic', 'summary', 'formats'],
      },
    },
  },
  required: ['stops'],
};

const DEFAULT_WEIGHTS = {
  visual: 0.25,
  aural: 0.25,
  reading: 0.25,
  kinesthetic: 0.25,
};

type FormatKind = 'video' | 'text' | 'quiz';

type StopKind = 'topic' | 'review';

type Stop = {
  id: string;
  kind: StopKind;
  topic: string;
  summary: string;
  /** Para stops kind="review": lista dos stop.id que esta revisão cobre */
  reviewsStopIds?: string[];
  formats: {
    kind: FormatKind;
    label: string;
    estimatedMinutes: number;
    courseId?: number;
    courseBanner?: string;
    courseTitle?: string;
    crcActive?: boolean;
    crcCreditHours?: number | null;
    quizScope?: 'review' | 'topic';
    prompt?: string;
  }[];
};

type Plan = {
  generatedAt: string;
  level: string;
  stops: Stop[];
  styleWeights: typeof DEFAULT_WEIGHTS;
};

@Injectable()
export class PlanService {
  constructor(
    private readonly gemini: GeminiService,
    private readonly cefis: CefisService,
    private readonly profiles: ProfileService,
    private readonly rag: RagService,
    @InjectRepository(GeneratedPlan)
    private readonly plans: Repository<GeneratedPlan>,
    @InjectRepository(StopCompletion)
    private readonly completions: Repository<StopCompletion>,
  ) {}

  async generateText(
    sessionKey: string,
    courseId: number,
    stopTopic?: string,
  ): Promise<LearnerTextResult> {
    const profile = await this.profiles.findBySession(sessionKey);
    if (!profile) throw new Error('Profile not found');
    const course = await this.cefis.getCourse(sessionKey, courseId);
    return this.rag.generateLearnerText({
      courseId,
      courseTitle: course?.title,
      courseSummary: course?.summary,
      courseGoals: course?.goals,
      learnerGoals: profile.goals ?? [],
      learnerLevel: profile.level ?? undefined,
      stopTopic,
    });
  }

  async deleteAllForUser(sessionKey: string): Promise<{ deleted: number }> {
    const profile = await this.profiles.findBySession(sessionKey);
    if (!profile) return { deleted: 0 };
    await this.completions.delete({ profile: { id: profile.id } });
    const res = await this.plans.delete({ profile: { id: profile.id } });
    await this.profiles.resetLearningState(sessionKey);
    return { deleted: res.affected ?? 0 };
  }

  async findCurrent(sessionKey: string): Promise<{
    plan: Plan;
    planId: number;
    completions: { stopId: string; formatKind: string; createdAt: Date }[];
  } | null> {
    const profile = await this.profiles.findBySession(sessionKey);
    if (!profile) return null;
    const latest = await this.plans.findOne({
      where: { profile: { id: profile.id } },
      order: { createdAt: 'DESC' },
    });
    if (!latest) return null;
    const completions = await this.completions.find({
      where: { plan: { id: latest.id } },
      order: { createdAt: 'ASC' },
    });
    return {
      planId: latest.id,
      plan: latest.payload as Plan,
      completions: completions.map((c) => ({
        stopId: c.stopId,
        formatKind: c.formatKind,
        createdAt: c.createdAt,
      })),
    };
  }

  async completeStop(
    sessionKey: string,
    planId: number,
    stopId: string,
    formatKind: string,
  ): Promise<StopCompletion> {
    const profile = await this.profiles.findBySession(sessionKey);
    if (!profile) throw new Error('Profile not found');
    const plan = await this.plans.findOne({
      where: { id: planId, profile: { id: profile.id } },
    });
    if (!plan) throw new Error('Plan not found');
    const existing = await this.completions.findOne({
      where: {
        profile: { id: profile.id },
        plan: { id: plan.id },
        stopId,
      },
    });
    if (existing) {
      existing.formatKind = formatKind;
      return this.completions.save(existing);
    }
    return this.completions.save(
      this.completions.create({ profile, plan, stopId, formatKind }),
    );
  }

  private genericTopics(profile: StudentProfile): string[] {
    const CAT_TOPICS: Record<number, string[]> = {
      1: ['Tributos básicos', 'Apuração de impostos', 'Notas fiscais'],
      2: ['Lançamentos contábeis', 'Balanço patrimonial', 'DRE'],
      3: ['Direitos trabalhistas', 'Folha de pagamento', 'Rescisão'],
      4: ['Fundamentos gerais', 'Boas práticas', 'Aplicações'],
      5: ['Liderança', 'Gestão de equipes', 'Planejamento estratégico'],
      6: ['Mentalidade de crescimento', 'Comunicação eficaz', 'Produtividade'],
      7: ['Lógica de programação', 'IA aplicada', 'Cibersegurança'],
    };
    const topics: string[] = [];
    (profile.categoryIds ?? []).forEach((id) => {
      (CAT_TOPICS[id] ?? CAT_TOPICS[4]).forEach((t) => topics.push(t));
    });
    return topics.length ? topics.slice(0, 6) : ['Conceitos introdutórios', 'Tópicos intermediários', 'Aplicações práticas'];
  }

  private fallback(profile: StudentProfile, courses: CefisCourse[]): Plan {
    if (courses.length === 0) {
      const topics = this.genericTopics(profile);
      const topicStops: Stop[] = topics.map((t, i) => ({
        id: `s-${i}`,
        kind: 'topic',
        topic: t,
        summary: 'Tópico gerado automaticamente — sem cursos no catálogo.',
        formats: [
          {
            kind: 'text',
            label: 'Resumo escrito',
            estimatedMinutes: 6,
            prompt: `Resumo sobre: ${t}`,
          },
          {
            kind: 'quiz',
            label: 'Quiz rápido',
            estimatedMinutes: 4,
            quizScope: 'topic',
          },
        ],
      }));
      const stops = this.interleaveReviews(topicStops);
      return {
        generatedAt: new Date().toISOString(),
        level: profile.level ?? 'iniciante',
        stops,
        styleWeights: profile.styleWeights ?? DEFAULT_WEIGHTS,
      };
    }
    const topicStops: Stop[] = courses.map((c, i) => ({
      id: `s-${i}`,
      kind: 'topic',
      topic: c.title,
      summary: c.subtitle ?? c.summary?.slice(0, 140) ?? '',
      formats: [
        {
          kind: 'video',
          label: 'Aula CEFIS',
          estimatedMinutes: Math.min(40, Math.round((c.duration ?? 1200) / 60)),
          courseId: c.id,
          courseBanner: c.banner,
          courseTitle: c.title,
          crcActive: c.crcActive,
          crcCreditHours: c.crcCreditHours,
        },
        {
          kind: 'text',
          label: 'Resumo escrito',
          estimatedMinutes: 6,
          prompt: `Resumo conciso sobre: ${c.title}`,
        },
        {
          kind: 'quiz',
          label: 'Quiz rápido',
          estimatedMinutes: 4,
          quizScope: 'topic',
        },
      ],
    }));

    const stops = this.interleaveReviews(topicStops);
    return {
      generatedAt: new Date().toISOString(),
      level: profile.level ?? 'iniciante',
      stops,
      styleWeights: profile.styleWeights ?? DEFAULT_WEIGHTS,
    };
  }

  private interleaveReviews(topicStops: Stop[]): Stop[] {
    const stops: Stop[] = [];
    topicStops.forEach((s, i) => {
      stops.push(s);
      const isHalfway = (i + 1) % 2 === 0 && i < topicStops.length - 1;
      if (isHalfway) {
        const recent = topicStops.slice(Math.max(0, i - 1), i + 1);
        stops.push({
          id: `r-${i}`,
          kind: 'review',
          topic: `Revisão: ${recent.map((r) => r.topic).join(' + ')}`,
          summary: 'Checkpoint de revisão dos últimos tópicos.',
          reviewsStopIds: recent.map((r) => r.id),
          formats: [
            {
              kind: 'quiz',
              label: 'Quiz de revisão',
              estimatedMinutes: 6,
              quizScope: 'review',
            },
          ],
        });
      }
    });
    if (topicStops.length) {
      stops.push({
        id: 'r-final',
        kind: 'review',
        topic: 'Revisão final',
        summary: 'Avaliação geral cobrindo tudo o que você estudou.',
        reviewsStopIds: topicStops.map((s) => s.id),
        formats: [
          {
            kind: 'quiz',
            label: 'Quiz de revisão geral',
            estimatedMinutes: 8,
            quizScope: 'review',
          },
        ],
      });
    }
    return stops;
  }

  async generate(
    sessionKey: string,
  ): Promise<{ planId: number; plan: Plan }> {
    const profile = await this.profiles.findBySession(sessionKey);
    if (!profile) {
      throw new Error('Profile not found. Complete onboarding first.');
    }

    const wantsCrc = (profile.goals ?? []).includes('crc');
    let courses = await this.cefis.listCoursesByCategories(
      sessionKey,
      profile.categoryIds ?? [],
      15,
      wantsCrc ? ['scored_crc'] : [],
    );
    // If the CRC filter trimmed everything, retry without it so the plan
    // is never empty.
    if (wantsCrc && courses.length === 0) {
      courses = await this.cefis.listCoursesByCategories(
        sessionKey,
        profile.categoryIds ?? [],
        15,
      );
    }

    let plan: Plan;
    if (!this.gemini.hasLlm || courses.length === 0) {
      plan = this.fallback(profile, courses);
    } else {
      plan = (await this.callGemini(profile, courses)) ?? this.fallback(profile, courses);
    }

    const saved = await this.plans.save(
      this.plans.create({
        profile,
        level: plan.level,
        thetaAtGeneration: profile.theta,
        styleWeightsAtGeneration: plan.styleWeights,
        payload: plan,
      }),
    );

    return { planId: saved.id, plan };
  }

  private async callGemini(
    profile: StudentProfile,
    courses: CefisCourse[],
  ): Promise<Plan | null> {
    const style = profile.styleWeights ?? DEFAULT_WEIGHTS;
    const entries = Object.entries(style) as [keyof typeof style, number][];
    const top = entries.sort((a, b) => b[1] - a[1])[0][0];
    const STYLE_LABEL: Record<typeof top, string> = {
      visual: 'visual (gráficos, vídeos, diagramas)',
      aural: 'auditivo (prefere vídeo-aulas com narração do professor)',
      reading: 'leitura/escrita (texto, resumos)',
      kinesthetic: 'cinestésico (prática, exercícios, quiz)',
    };
    const dominantStyle = STYLE_LABEL[top];

    const catNames = (profile.categoryIds ?? [])
      .map((id) => CATEGORIES[id])
      .filter(Boolean)
      .join(', ');
    const goalNames = (profile.goals ?? [])
      .map((g) => GOAL_LABELS[g] ?? g)
      .join('; ');

    const courseList = courses
      .map(
        (c) =>
          `- [id ${c.id}] ${c.title}${c.subtitle ? ' — ' + c.subtitle : ''} (${Math.round(
            (c.duration ?? 0) / 60,
          )}min, nota ${c.averageRating ?? '?'})\n  Resumo: ${c.summary?.slice(0, 220) ?? '—'}\n  Objetivos: ${(c.goals ?? []).join(' | ').slice(0, 220)}`,
      )
      .join('\n');

    const prompt = `Você é um tutor de aprendizado da CEFIS. Monte uma TRILHA DE ESTUDOS personalizada.

Perfil do aluno:
- Objetivos: ${goalNames}
- Áreas: ${catNames}
- Nível: ${profile.level} (θ=${(profile.theta ?? 0).toFixed(2)})
- Estilo dominante atual: ${dominantStyle}

Cursos disponíveis no catálogo:
${courseList}

Regras:
- Crie quantos STOPS forem necessários para cobrir os cursos relevantes do catálogo (use seu julgamento — pode ser mais que 11 se o catálogo for grande), INTERCALANDO dois tipos:
  - kind="topic" (use TODOS os cursos relevantes do catálogo abaixo — não limite a 5; deixe a quantidade ser proporcional ao catálogo recebido): cada um cobre UM TÓPICO/CONCEITO específico. Ofereça 2-3 FORMATOS de aprender o mesmo tópico ("video" com courseId real, "text", "quiz" scope="topic"). NÃO use o formato "podcast" (não é suportado).
  - kind="review" (3 a 4 stops, espalhados): checkpoints de revisão a cada 2-3 stops de tópico e UM no final. Use topic="Revisão: <temas>", summary explicando o que será revisado. Esses stops DEVEM ter APENAS UM formato: { kind: "quiz", quizScope: "review", label: "Quiz de revisão", estimatedMinutes: 5-8 }.
- Stops de tópico DEVEM ter ao menos um "video" se houver curso adequado.
- "estimatedMinutes" entre 5 e 30 por formato.
- Pondere a oferta de formatos pelo estilo dominante (${dominantStyle}) nos stops de tópico, mas SEMPRE ofereça 2+ alternativas.
- Ordem: comece com kind="topic", insira kind="review" após cada 2-3 stops de tópico, e termine sempre com kind="review" cobrindo todos os tópicos anteriores.`;

    const parsed = await this.gemini.generateJson<{
      stops: Array<{
        kind?: string;
        topic: string;
        summary: string;
        formats: Array<{
          kind: string;
          label: string;
          estimatedMinutes?: number;
          courseId?: number;
          quizScope?: string;
          prompt?: string;
        }>;
      }>;
    }>(prompt, SCHEMA);
    if (!parsed) return null;

    const courseMap = new Map(courses.map((c) => [c.id, c]));
    const stops: Stop[] = parsed.stops.map((s, i) => {
      const kind = (s.kind === 'review' ? 'review' : 'topic') as StopKind;
      const formats = (s.formats ?? [])
        .filter((f) => f.kind !== 'podcast')
        .map((f) => {
          const course = f.courseId ? courseMap.get(f.courseId) : undefined;
          return {
            kind: f.kind as FormatKind,
            label: f.label,
            estimatedMinutes: Math.max(3, Math.min(40, f.estimatedMinutes ?? 10)),
            courseId: f.courseId,
            courseBanner: course?.banner,
            courseTitle: course?.title,
            crcActive: course?.crcActive,
            crcCreditHours: course?.crcCreditHours,
            quizScope: f.quizScope as 'review' | 'topic' | undefined,
            prompt: f.prompt,
          };
        });

      // Topic stops must always offer video + text + quiz when there's a
      // course attached, regardless of what the LLM returned.
      if (kind === 'topic') {
        const video = formats.find((f) => f.kind === 'video');
        if (video && !formats.some((f) => f.kind === 'text')) {
          formats.push({
            kind: 'text',
            label: 'Resumo escrito',
            estimatedMinutes: 6,
            courseId: video.courseId,
            courseBanner: video.courseBanner,
            courseTitle: video.courseTitle,
            crcActive: video.crcActive,
            crcCreditHours: video.crcCreditHours,
            quizScope: undefined,
            prompt: `Resumo conciso sobre: ${s.topic}`,
          });
        }
        if (!formats.some((f) => f.kind === 'quiz')) {
          formats.push({
            kind: 'quiz',
            label: 'Quiz rápido',
            estimatedMinutes: 4,
            courseId: video?.courseId,
            courseBanner: video?.courseBanner,
            courseTitle: video?.courseTitle,
            crcActive: video?.crcActive,
            crcCreditHours: video?.crcCreditHours,
            quizScope: 'topic',
            prompt: undefined,
          });
        }
      }

      return {
        id: `s-${i}`,
        kind,
        topic: s.topic,
        summary: s.summary,
        formats,
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      level: profile.level ?? 'iniciante',
      stops: this.dedupeStops(stops),
      styleWeights: style,
    };
  }

  /**
   * Removes topic stops that point to a course already covered by an earlier
   * stop. Review stops are kept as-is. Stop ids are reindexed so the IDs
   * stay sequential after removal.
   */
  private dedupeStops(stops: Stop[]): Stop[] {
    const seenCourseIds = new Set<number>();
    const seenTopics = new Set<string>();
    const kept: Stop[] = [];
    for (const s of stops) {
      if (s.kind === 'topic') {
        const courseId = s.formats.find((f) => f.kind === 'video')?.courseId;
        const topicKey = s.topic.trim().toLowerCase();
        if (courseId !== undefined && seenCourseIds.has(courseId)) continue;
        if (seenTopics.has(topicKey)) continue;
        if (courseId !== undefined) seenCourseIds.add(courseId);
        seenTopics.add(topicKey);
      }
      kept.push(s);
    }
    // Reindex topic stop ids; review stops keep their original id pattern
    // so reviewsStopIds references (if any) don't need rewriting here.
    return kept.map((s, i) =>
      s.kind === 'topic' ? { ...s, id: `s-${i}` } : s,
    );
  }
}
