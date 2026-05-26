import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CefisModule } from '../cefis/cefis.module';
import { GeneratedPlan } from '../entities/generated-plan.entity';
import { StopCompletion } from '../entities/stop-completion.entity';
import { GeminiService } from '../llm/gemini.service';
import { ProfileModule } from '../profile/profile.module';
import { RagModule } from '../rag/rag.module';
import { PlanController } from './plan.controller';
import { PlanService } from './plan.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([GeneratedPlan, StopCompletion]),
    ProfileModule,
    CefisModule,
    RagModule,
  ],
  controllers: [PlanController],
  providers: [PlanService, GeminiService],
})
export class PlanModule {}
