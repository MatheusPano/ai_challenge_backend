import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { PlanService } from './plan.service';

function requireSession(authHeader?: string): string {
  if (!authHeader) {
    throw new HttpException('Missing Authorization', HttpStatus.UNAUTHORIZED);
  }
  return authHeader.replace(/^Bearer\s+/i, '').trim();
}

@Controller('api/plan')
export class PlanController {
  constructor(private readonly plans: PlanService) {}

  @Post('generate')
  async generate(@Headers('authorization') auth: string | undefined) {
    const sessionKey = requireSession(auth);
    try {
      return await this.plans.generate(sessionKey);
    } catch (e) {
      throw new HttpException(
        (e as Error).message,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('current')
  async current(@Headers('authorization') auth: string | undefined) {
    const sessionKey = requireSession(auth);
    const result = await this.plans.findCurrent(sessionKey);
    if (!result) {
      throw new HttpException('No plan yet', HttpStatus.NOT_FOUND);
    }
    return result;
  }

  @Delete('all')
  async reset(@Headers('authorization') auth: string | undefined) {
    const sessionKey = requireSession(auth);
    return this.plans.deleteAllForUser(sessionKey);
  }

  @Post('text')
  async text(
    @Headers('authorization') auth: string | undefined,
    @Body() body: { courseId: number; stopTopic?: string },
  ) {
    const sessionKey = requireSession(auth);
    if (!body?.courseId) {
      throw new HttpException('courseId required', HttpStatus.BAD_REQUEST);
    }
    try {
      return await this.plans.generateText(
        sessionKey,
        body.courseId,
        body.stopTopic,
      );
    } catch (e) {
      throw new HttpException(
        (e as Error).message,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('complete-stop')
  async completeStop(
    @Headers('authorization') auth: string | undefined,
    @Body() body: { planId: number; stopId: string; formatKind: string },
  ) {
    const sessionKey = requireSession(auth);
    if (!body?.planId || !body?.stopId || !body?.formatKind) {
      throw new HttpException(
        'planId, stopId and formatKind required',
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      const c = await this.plans.completeStop(
        sessionKey,
        body.planId,
        body.stopId,
        body.formatKind,
      );
      return {
        ok: true,
        completion: {
          stopId: c.stopId,
          formatKind: c.formatKind,
          createdAt: c.createdAt,
        },
      };
    } catch (e) {
      throw new HttpException(
        (e as Error).message,
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
