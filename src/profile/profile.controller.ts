import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ProfileService, UpsertProfileDto } from './profile.service';

function requireSession(authHeader?: string): string {
  if (!authHeader) {
    throw new HttpException('Missing Authorization', HttpStatus.UNAUTHORIZED);
  }
  return authHeader.replace(/^Bearer\s+/i, '').trim();
}

@Controller('api/profile')
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Post('identify')
  async identify(
    @Headers('authorization') auth: string | undefined,
    @Body() body: {
      cefisUserId?: number;
      name?: string;
      email?: string;
      avatar?: string;
    },
  ) {
    const sessionKey = requireSession(auth);
    const p = await this.profiles.upsert({ sessionKey, ...body });
    return { ok: true, profile: this.serialize(p) };
  }

  @Post('onboarding')
  async onboarding(
    @Headers('authorization') auth: string | undefined,
    @Body() body: Omit<UpsertProfileDto, 'sessionKey'>,
  ) {
    const sessionKey = requireSession(auth);
    const p = await this.profiles.upsert({ sessionKey, ...body });
    return { ok: true, profile: this.serialize(p) };
  }

  @Get('me')
  async me(@Headers('authorization') auth: string | undefined) {
    const sessionKey = requireSession(auth);
    const p = await this.profiles.findBySession(sessionKey);
    if (!p) throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    return { profile: this.serialize(p) };
  }

  private serialize(p: import('../entities/student-profile.entity').StudentProfile) {
    return {
      id: p.id,
      cefisUserId: p.cefisUserId,
      name: p.name,
      email: p.email,
      avatar: p.avatar,
      goals: p.goals,
      categoryIds: p.categoryIds,
      level: p.level,
      theta: p.theta,
      styleWeights: p.styleWeights,
      topicSignals: p.topicSignals,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }
}
