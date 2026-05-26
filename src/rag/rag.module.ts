import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Inject, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GeminiService } from '../llm/gemini.service';
import { CourseDocument } from './entities/course-document.entity';
import { LessonDocument } from './entities/lesson-document.entity';
import { EmbeddingsService } from './embeddings/embeddings.service';
import { IngestService } from './ingest/ingest.service';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';
import { RAG_CONNECTION, RAG_DATA_SOURCE } from './rag.constants';
import { TranscriptChunkRepository } from './repositories/transcript-chunk.repository';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRootAsync({
      name: RAG_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const sslEnabled =
          (config.get<string>('RAG_DB_SSL') ?? '').toLowerCase() === 'true';
        return {
          type: 'postgres' as const,
          name: RAG_CONNECTION,
          host: config.get<string>('RAG_DB_HOST', 'localhost'),
          port: config.get<number>('RAG_DB_PORT', 5432),
          username: config.get<string>('RAG_DB_USER', 'rag'),
          password: config.get<string>('RAG_DB_PASSWORD', 'rag'),
          database: config.get<string>('RAG_DB_NAME', 'ai_challenge_rag'),
          entities: [CourseDocument, LessonDocument],
          synchronize: false,
          ssl: sslEnabled ? { rejectUnauthorized: false } : false,
          extra: sslEnabled ? { ssl: { rejectUnauthorized: false } } : undefined,
        };
      },
    }),
    TypeOrmModule.forFeature(
      [CourseDocument, LessonDocument],
      RAG_CONNECTION,
    ),
  ],
  controllers: [RagController],
  providers: [
    {
      provide: RAG_DATA_SOURCE,
      useExisting: getDataSourceToken(RAG_CONNECTION),
    },
    EmbeddingsService,
    GeminiService,
    TranscriptChunkRepository,
    IngestService,
    RagService,
  ],
  exports: [RagService, IngestService, EmbeddingsService],
})
export class RagModule implements OnModuleInit {
  private readonly log = new Logger(RagModule.name);

  constructor(
    @Inject(RAG_DATA_SOURCE) private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    const candidates = [
      join(__dirname, 'schema.sql'),
      join(process.cwd(), 'src/rag/schema.sql'),
    ];
    let sql: string | null = null;
    for (const path of candidates) {
      try {
        sql = await fs.readFile(path, 'utf8');
        break;
      } catch {
        // try next candidate
      }
    }
    if (!sql) {
      this.log.error(`pgvector schema.sql not found in: ${candidates.join(', ')}`);
      return;
    }
    try {
      const statements = sql
        .split(/;\s*$/m)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const stmt of statements) {
        await this.dataSource.query(stmt);
      }
      this.log.log('pgvector schema ready');
    } catch (e) {
      this.log.error(`pgvector schema init failed: ${(e as Error).message}`);
    }
  }
}
