import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { EmbeddingsQuotaExceededError } from '../embeddings/embeddings.service';
import { IngestService } from './ingest.service';

function parseArgs(): {
  onlyCourseId?: number;
  limit?: number;
  resume?: boolean;
} {
  const out: { onlyCourseId?: number; limit?: number; resume?: boolean } = {};
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    if (k === 'course' && v) out.onlyCourseId = Number(v);
    if (k === 'limit' && v) out.limit = Number(v);
    if (k === 'no-resume') out.resume = false;
  }
  return out;
}

async function bootstrap(): Promise<void> {
  const log = new Logger('IngestCLI');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const ingest = app.get(IngestService);
    const opts = parseArgs();
    log.log(`Running with opts: ${JSON.stringify(opts)}`);
    const stats = await ingest.run(opts);
    log.log(`Final stats: ${JSON.stringify(stats, null, 2)}`);
  } finally {
    await app.close();
  }
}

bootstrap().catch((e) => {
  console.error('ingest failed:', e);
  process.exit(1);
});
