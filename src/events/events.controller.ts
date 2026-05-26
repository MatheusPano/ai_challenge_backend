import {
  Body,
  Controller,
  Headers,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { EventsService } from './events.service';

@Controller('api/events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post()
  async post(
    @Headers('authorization') auth: string | undefined,
    @Body() body: { type: string; payload?: Record<string, unknown> },
  ) {
    if (!auth) {
      throw new HttpException('Missing Authorization', HttpStatus.UNAUTHORIZED);
    }
    const sessionKey = auth.replace(/^Bearer\s+/i, '').trim();
    if (!body?.type) {
      throw new HttpException('type required', HttpStatus.BAD_REQUEST);
    }
    const { profile } = await this.events.record(
      sessionKey,
      body.type,
      body.payload,
    );
    return { ok: true, styleWeights: profile.styleWeights };
  }
}
