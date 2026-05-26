import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { AskResult, RagService, SummaryResult } from './rag.service';
import { SimilarityHit } from './repositories/transcript-chunk.repository';

interface SearchDto {
  query: string;
  topK?: number;
  courseIds?: number[];
  lessonIds?: number[];
}

interface AskDto extends SearchDto {
  contextSize?: number;
}

interface SummaryDto {
  courseId: number;
  maxChunks?: number;
}

@Controller('api/rag')
export class RagController {
  constructor(private readonly rag: RagService) {}

  @Get('search')
  search(
    @Query('q') q: string,
    @Query('topK') topK?: string,
    @Query('courseId') courseId?: string,
  ): Promise<SimilarityHit[]> {
    return this.rag.search({
      query: q,
      topK: topK ? Number(topK) : undefined,
      courseIds: courseId ? [Number(courseId)] : undefined,
    });
  }

  @Post('search')
  @HttpCode(HttpStatus.OK)
  searchPost(@Body() body: SearchDto): Promise<SimilarityHit[]> {
    return this.rag.search(body);
  }

  @Post('ask')
  @HttpCode(HttpStatus.OK)
  ask(@Body() body: AskDto): Promise<AskResult> {
    return this.rag.ask(body);
  }

  @Post('summary')
  @HttpCode(HttpStatus.OK)
  summary(@Body() body: SummaryDto): Promise<SummaryResult> {
    return this.rag.summarize(body);
  }
}
