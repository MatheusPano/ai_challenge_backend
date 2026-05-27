import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { CourseDocument } from '../entities/course-document.entity';
import { LessonDocument } from '../entities/lesson-document.entity';
import {
  ChunkInsert,
  TranscriptChunkRepository,
} from '../repositories/transcript-chunk.repository';
import {
  EmbeddingsQuotaExceededError,
  EmbeddingsService,
} from '../embeddings/embeddings.service';
import { RAG_CONNECTION } from '../rag.constants';
import { chunkCues } from './chunker';
import { parseVtt } from './vtt-parser';

interface CourseDetailsJson {
  data?: {
    id: number;
    title: string;
    subtitle?: string;
    summary?: string;
    goals?: string[];
    categories?: number[];
    teacher?: { id?: number; name?: string };
    averageRating?: number;
    duration?: number;
  };
}

interface LessonDetailsJson {
  id: number;
  title: string;
  position: number;
  duration?: number;
}

const SUBTITLE_CANDIDATES = ['subtitle_pt-BR.vtt', 'subtitle_pt.vtt'];
const EMBED_BATCH_SIZE = 50;
const EMBED_BATCH_DELAY_MS = 1000;
const EMBED_LESSON_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export interface IngestStats {
  coursesProcessed: number;
  coursesSkippedNoTranscripts: number;
  lessonsProcessed: number;
  lessonsSkippedEmpty: number;
  chunksInserted: number;
  embeddingsFailed: number;
}

@Injectable()
export class IngestService {
  private readonly log = new Logger(IngestService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly embeddings: EmbeddingsService,
    private readonly chunkRepo: TranscriptChunkRepository,
    @InjectRepository(CourseDocument, RAG_CONNECTION)
    private readonly courseRepo: Repository<CourseDocument>,
    @InjectRepository(LessonDocument, RAG_CONNECTION)
    private readonly lessonRepo: Repository<LessonDocument>,
  ) {}

  get dataDir(): string {
    const configured = this.config.get<string>('RAG_DATA_DIR', 'src/rag/data');
    return configured.startsWith('/')
      ? configured
      : join(process.cwd(), configured);
  }

  async run(
    opts: { onlyCourseId?: number; limit?: number; resume?: boolean } = {},
  ): Promise<IngestStats> {
    const stats: IngestStats = {
      coursesProcessed: 0,
      coursesSkippedNoTranscripts: 0,
      lessonsProcessed: 0,
      lessonsSkippedEmpty: 0,
      chunksInserted: 0,
      embeddingsFailed: 0,
    };

    const allCourseDirs = await this.listCourseDirs(opts.onlyCourseId);
    const resume = opts.resume ?? true;
    const filteredDirs = resume
      ? await this.skipAlreadyIngested(allCourseDirs)
      : allCourseDirs;
    const targets = opts.limit
      ? filteredDirs.slice(0, opts.limit)
      : filteredDirs;
    this.log.log(
      `Ingest start — ${targets.length} course(s) to process (skipped ${allCourseDirs.length - filteredDirs.length} already ingested)`,
    );

    for (const courseDir of targets) {
      try {
        const result = await this.ingestCourse(courseDir);
        if (!result) {
          stats.coursesSkippedNoTranscripts++;
          continue;
        }
        stats.coursesProcessed++;
        stats.lessonsProcessed += result.lessonsProcessed;
        stats.lessonsSkippedEmpty += result.lessonsSkippedEmpty;
        stats.chunksInserted += result.chunksInserted;
        stats.embeddingsFailed += result.embeddingsFailed;
      } catch (e) {
        if (e instanceof EmbeddingsQuotaExceededError) {
          this.log.error(
            `Embeddings quota exhausted on course ${courseDir} — aborting ingest. Stats so far: ${JSON.stringify(stats)}`,
          );
          throw e;
        }
        this.log.error(`course ${courseDir} failed: ${(e as Error).message}`);
      }
    }
    this.log.log(`Ingest done — ${JSON.stringify(stats)}`);
    return stats;
  }

  private async skipAlreadyIngested(courseDirs: string[]): Promise<string[]> {
    if (!courseDirs.length) return courseDirs;
    const out: string[] = [];
    for (const dir of courseDirs) {
      const count = await this.chunkRepo.countByCourse(Number(dir));
      if (count === 0) out.push(dir);
    }
    return out;
  }

  private async listCourseDirs(onlyCourseId?: number): Promise<string[]> {
    const entries = await fs.readdir(this.dataDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .filter((e) => !onlyCourseId || Number(e.name) === onlyCourseId)
      .map((e) => e.name)
      .sort((a, b) => Number(a) - Number(b));
  }

  private async ingestCourse(courseDirName: string): Promise<{
    lessonsProcessed: number;
    lessonsSkippedEmpty: number;
    chunksInserted: number;
    embeddingsFailed: number;
  } | null> {
    const courseId = Number(courseDirName);
    const courseDir = join(this.dataDir, courseDirName);
    const detailsPath = join(courseDir, 'details.json');
    const lessonsDir = join(courseDir, 'lessons');

    const detailsRaw = await fs.readFile(detailsPath, 'utf8');
    const details = JSON.parse(detailsRaw) as CourseDetailsJson;
    const course = details.data;
    if (!course) {
      this.log.warn(`course ${courseId}: missing data — skipping`);
      return null;
    }

    const lessonDirs = await this.listLessonDirs(lessonsDir);
    const lessonsWithTranscript: { dir: string; vttPath: string }[] = [];
    for (const ld of lessonDirs) {
      const vtt = await this.findVttPath(join(lessonsDir, ld));
      if (vtt) lessonsWithTranscript.push({ dir: ld, vttPath: vtt });
    }
    if (!lessonsWithTranscript.length) {
      this.log.debug(`course ${courseId}: no transcripts — skipping`);
      return null;
    }

    await this.courseRepo.save(
      this.courseRepo.create({
        id: course.id,
        title: course.title,
        subtitle: course.subtitle ?? null,
        summary: course.summary ?? null,
        goals: course.goals ?? null,
        categories: course.categories ?? null,
        teacherId: course.teacher?.id ?? null,
        teacherName: course.teacher?.name ?? null,
        averageRating: course.averageRating ?? null,
        durationSec: course.duration ?? null,
      }),
    );

    let lessonsProcessed = 0;
    let lessonsSkippedEmpty = 0;
    let chunksInserted = 0;
    let embeddingsFailed = 0;

    for (let lessonIdx = 0; lessonIdx < lessonsWithTranscript.length; lessonIdx++) {
      const { dir, vttPath } = lessonsWithTranscript[lessonIdx];
      if (lessonIdx > 0) {
        await sleep(EMBED_LESSON_DELAY_MS);
      }
      const lessonDetailsPath = join(lessonsDir, dir, 'details.json');
      const lessonRaw = await fs.readFile(lessonDetailsPath, 'utf8');
      const lesson = JSON.parse(lessonRaw) as LessonDetailsJson;

      await this.lessonRepo.save(
        this.lessonRepo.create({
          id: lesson.id,
          courseId: course.id,
          position: lesson.position,
          title: lesson.title,
          durationSec: lesson.duration ?? null,
        }),
      );

      const vttRaw = await fs.readFile(vttPath, 'utf8');
      const cues = parseVtt(vttRaw);
      const chunks = chunkCues(cues);
      if (!chunks.length) {
        lessonsSkippedEmpty++;
        continue;
      }

      await this.chunkRepo.deleteByLesson(lesson.id);

      const inserts: ChunkInsert[] = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
        const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
        const vectors = await this.embeddings.embedBatch(
          batch.map((c) => c.text),
        );
        batch.forEach((c, idx) => {
          const emb = vectors[idx];
          if (!emb?.length) {
            embeddingsFailed++;
            return;
          }
          inserts.push({
            courseId: course.id,
            lessonId: lesson.id,
            chunkIndex: i + idx,
            startMs: c.startMs,
            endMs: c.endMs,
            text: c.text,
            tokenCount: c.tokenCount,
            embedding: emb,
          });
        });
        if (i + EMBED_BATCH_SIZE < chunks.length) {
          await sleep(EMBED_BATCH_DELAY_MS);
        }
      }
      if (inserts.length) {
        await this.chunkRepo.bulkInsert(inserts);
        chunksInserted += inserts.length;
      }
      lessonsProcessed++;
    }
    this.log.log(
      `course ${courseId} "${course.title}" — ${lessonsProcessed} lessons, ${chunksInserted} chunks`,
    );
    return {
      lessonsProcessed,
      lessonsSkippedEmpty,
      chunksInserted,
      embeddingsFailed,
    };
  }

  private async listLessonDirs(lessonsDir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(lessonsDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
        .map((e) => e.name)
        .sort((a, b) => Number(a) - Number(b));
    } catch {
      return [];
    }
  }

  private async findVttPath(lessonDir: string): Promise<string | null> {
    for (const name of SUBTITLE_CANDIDATES) {
      const candidate = join(lessonDir, name);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // try next
      }
    }
    return null;
  }
}
