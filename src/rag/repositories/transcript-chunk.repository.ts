import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RAG_DATA_SOURCE } from '../rag.constants';

export interface TranscriptChunkRow {
  id: number;
  courseId: number;
  lessonId: number;
  chunkIndex: number;
  startMs: number;
  endMs: number;
  text: string;
  tokenCount: number;
}

export interface SimilarityHit extends TranscriptChunkRow {
  distance: number;
  lessonTitle: string;
  coursePosition: number;
  courseTitle: string;
}

export interface ChunkInsert {
  courseId: number;
  lessonId: number;
  chunkIndex: number;
  startMs: number;
  endMs: number;
  text: string;
  tokenCount: number;
  embedding: number[];
}

function toVectorLiteral(vec: number[]): string {
  return `[${vec.map((n) => (Number.isFinite(n) ? n.toString() : '0')).join(',')}]`;
}

@Injectable()
export class TranscriptChunkRepository {
  constructor(
    @Inject(RAG_DATA_SOURCE) private readonly dataSource: DataSource,
  ) {}

  async deleteByLesson(lessonId: number): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM transcript_chunks WHERE lesson_id = $1`,
      [lessonId],
    );
  }

  async bulkInsert(chunks: ChunkInsert[]): Promise<void> {
    if (!chunks.length) return;
    const values: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const c of chunks) {
      values.push(
        `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::vector)`,
      );
      params.push(
        c.courseId,
        c.lessonId,
        c.chunkIndex,
        c.startMs,
        c.endMs,
        c.text,
        c.tokenCount,
        toVectorLiteral(c.embedding),
      );
    }
    await this.dataSource.query(
      `INSERT INTO transcript_chunks
        (course_id, lesson_id, chunk_index, start_ms, end_ms, text, token_count, embedding)
       VALUES ${values.join(', ')}
       ON CONFLICT (lesson_id, chunk_index) DO UPDATE SET
         text = EXCLUDED.text,
         start_ms = EXCLUDED.start_ms,
         end_ms = EXCLUDED.end_ms,
         token_count = EXCLUDED.token_count,
         embedding = EXCLUDED.embedding`,
      params,
    );
  }

  async search(opts: {
    embedding: number[];
    topK: number;
    courseIds?: number[];
    lessonIds?: number[];
  }): Promise<SimilarityHit[]> {
    const { embedding, topK, courseIds, lessonIds } = opts;
    const params: unknown[] = [toVectorLiteral(embedding)];
    const wheres: string[] = [];
    if (courseIds?.length) {
      params.push(courseIds);
      wheres.push(`tc.course_id = ANY($${params.length}::int[])`);
    }
    if (lessonIds?.length) {
      params.push(lessonIds);
      wheres.push(`tc.lesson_id = ANY($${params.length}::int[])`);
    }
    const whereSql = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    params.push(topK);
    const sql = `
      SELECT
        tc.id,
        tc.course_id     AS "courseId",
        tc.lesson_id     AS "lessonId",
        tc.chunk_index   AS "chunkIndex",
        tc.start_ms      AS "startMs",
        tc.end_ms        AS "endMs",
        tc.text,
        tc.token_count   AS "tokenCount",
        (tc.embedding <=> $1::vector) AS distance,
        ld.title         AS "lessonTitle",
        ld.position      AS "coursePosition",
        cd.title         AS "courseTitle"
      FROM transcript_chunks tc
      JOIN lesson_documents ld ON ld.id = tc.lesson_id
      JOIN course_documents cd ON cd.id = tc.course_id
      ${whereSql}
      ORDER BY tc.embedding <=> $1::vector
      LIMIT $${params.length}
    `;
    return this.dataSource.query(sql, params) as Promise<SimilarityHit[]>;
  }

  async countByCourse(courseId: number): Promise<number> {
    const rows = (await this.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM transcript_chunks WHERE course_id = $1`,
      [courseId],
    )) as { c: number }[];
    return rows[0]?.c ?? 0;
  }

  /**
   * Returns indexed course IDs whose `categories` jsonb array contains
   * any of the given category IDs. Used by QuizService to ground RAG
   * only in courses that actually belong to the user-selected categories.
   */
  async findCourseIdsByCategories(categoryIds: number[]): Promise<number[]> {
    if (!categoryIds?.length) return [];
    const rows = (await this.dataSource.query(
      `SELECT DISTINCT cd.id
       FROM course_documents cd
       WHERE EXISTS (
         SELECT 1
         FROM jsonb_array_elements_text(cd.categories) AS cat(val)
         WHERE (cat.val)::int = ANY($1::int[])
       )`,
      [categoryIds],
    )) as { id: number }[];
    return rows.map((r) => r.id);
  }

  /**
   * Returns all chunks of a course ordered by lesson position then chunk index.
   * Used to build full-course summaries.
   */
  async listByCourse(courseId: number): Promise<
    Array<
      TranscriptChunkRow & {
        lessonTitle: string;
        coursePosition: number;
        courseTitle: string;
      }
    >
  > {
    const sql = `
      SELECT
        tc.id,
        tc.course_id     AS "courseId",
        tc.lesson_id     AS "lessonId",
        tc.chunk_index   AS "chunkIndex",
        tc.start_ms      AS "startMs",
        tc.end_ms        AS "endMs",
        tc.text,
        tc.token_count   AS "tokenCount",
        ld.title         AS "lessonTitle",
        ld.position      AS "coursePosition",
        cd.title         AS "courseTitle"
      FROM transcript_chunks tc
      JOIN lesson_documents ld ON ld.id = tc.lesson_id
      JOIN course_documents cd ON cd.id = tc.course_id
      WHERE tc.course_id = $1
      ORDER BY ld.position ASC, tc.chunk_index ASC
    `;
    return this.dataSource.query(sql, [courseId]) as Promise<
      Array<
        TranscriptChunkRow & {
          lessonTitle: string;
          coursePosition: number;
          courseTitle: string;
        }
      >
    >;
  }
}
