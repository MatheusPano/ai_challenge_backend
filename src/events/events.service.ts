import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventLog } from '../entities/event-log.entity';
import { StudentProfile } from '../entities/student-profile.entity';
import { ProfileService } from '../profile/profile.service';

type StyleWeights = {
  visual: number;
  aural: number;
  reading: number;
  kinesthetic: number;
};

const NUDGE: Record<string, Partial<StyleWeights>> = {
  video: { visual: 0.08 },
  text: { reading: 0.08 },
  podcast: { aural: 0.1 },
  quiz: { kinesthetic: 0.08 },
};

function normalize(w: StyleWeights): StyleWeights {
  const total = w.visual + w.aural + w.reading + w.kinesthetic || 1;
  return {
    visual: w.visual / total,
    aural: w.aural / total,
    reading: w.reading / total,
    kinesthetic: w.kinesthetic / total,
  };
}

@Injectable()
export class EventsService {
  constructor(
    @InjectRepository(EventLog) private readonly logs: Repository<EventLog>,
    private readonly profiles: ProfileService,
  ) {}

  async record(
    sessionKey: string,
    type: string,
    payload: Record<string, unknown> | undefined,
  ): Promise<{ profile: StudentProfile }> {
    const profile = await this.profiles.upsert({ sessionKey });

    await this.logs.save(this.logs.create({ profile, type, payload }));

    if (type === 'format_chosen') {
      const kind = (payload?.kind as string) ?? '';
      const nudge = NUDGE[kind] ?? {};
      const current: StyleWeights = profile.styleWeights ?? {
        visual: 0.25,
        aural: 0.25,
        reading: 0.25,
        kinesthetic: 0.25,
      };
      const next = normalize({
        visual: current.visual + (nudge.visual ?? 0),
        aural: current.aural + (nudge.aural ?? 0),
        reading: current.reading + (nudge.reading ?? 0),
        kinesthetic: current.kinesthetic + (nudge.kinesthetic ?? 0),
      });
      await this.profiles.upsert({ sessionKey, styleWeights: next });
      profile.styleWeights = next;
    }

    return { profile };
  }
}
