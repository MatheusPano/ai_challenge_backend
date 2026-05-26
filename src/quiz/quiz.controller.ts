import { Body, Controller, Post } from '@nestjs/common';
import { QuizService, type GenerateQuizInput } from './quiz.service';

@Controller('api/quiz')
export class QuizController {
  constructor(private readonly quiz: QuizService) {}

  @Post('next')
  async next(@Body() body: GenerateQuizInput) {
    return this.quiz.generate(body);
  }
}
