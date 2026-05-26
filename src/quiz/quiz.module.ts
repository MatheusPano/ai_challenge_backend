import { Module } from '@nestjs/common';
import { GeminiService } from '../llm/gemini.service';
import { RagModule } from '../rag/rag.module';
import { QuizController } from './quiz.controller';
import { QuizService } from './quiz.service';

@Module({
  imports: [RagModule],
  controllers: [QuizController],
  providers: [QuizService, GeminiService],
})
export class QuizModule {}
