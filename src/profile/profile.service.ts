import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StudentProfile } from '../entities/student-profile.entity';

export type UpsertProfileDto = {
  sessionKey: string;
  goals?: string[];
  categoryIds?: number[];
  level?: string;
  theta?: number;
  styleWeights?: StudentProfile['styleWeights'];
  topicSignals?: unknown;
  cefisUserId?: number | null;
  name?: string | null;
  email?: string | null;
  avatar?: string | null;
};

@Injectable()
export class ProfileService {
  constructor(
    @InjectRepository(StudentProfile)
    private readonly repo: Repository<StudentProfile>,
  ) {}

  async findBySession(sessionKey: string): Promise<StudentProfile | null> {
    return this.repo.findOne({ where: { sessionKey } });
  }

  async findByCefisUserId(
    cefisUserId: number,
  ): Promise<StudentProfile | null> {
    return this.repo.findOne({ where: { cefisUserId } });
  }

  /** Clears learning data but keeps user identity (name/email/cefisUserId). */
  async resetLearningState(sessionKey: string): Promise<void> {
    const p = await this.findBySession(sessionKey);
    if (!p) return;
    p.goals = null;
    p.categoryIds = null;
    p.level = null;
    p.theta = null;
    p.styleWeights = null;
    p.topicSignals = null;
    await this.repo.save(p);
  }

  async upsert(dto: UpsertProfileDto): Promise<StudentProfile> {
    // Prefer matching by stable cefisUserId so the same user keeps the same
    // profile (and its plans/completions) across logout/login cycles, even
    // when CEFIS issues a new session key.
    let p: StudentProfile | null = null;
    if (dto.cefisUserId != null) {
      p = await this.findByCefisUserId(dto.cefisUserId);
    }
    if (!p) p = await this.findBySession(dto.sessionKey);
    if (!p) p = this.repo.create({ sessionKey: dto.sessionKey });
    // Always keep sessionKey current so subsequent calls (events, plan, etc.)
    // resolve the right profile via the Authorization header.
    p.sessionKey = dto.sessionKey;
    if (dto.goals !== undefined) p.goals = dto.goals;
    if (dto.categoryIds !== undefined) p.categoryIds = dto.categoryIds;
    if (dto.level !== undefined) p.level = dto.level;
    if (dto.theta !== undefined) p.theta = dto.theta;
    if (dto.styleWeights !== undefined) p.styleWeights = dto.styleWeights;
    if (dto.topicSignals !== undefined)
      p.topicSignals = dto.topicSignals as never;
    if (dto.cefisUserId !== undefined) p.cefisUserId = dto.cefisUserId;
    if (dto.name !== undefined) p.name = dto.name;
    if (dto.email !== undefined) p.email = dto.email;
    if (dto.avatar !== undefined) p.avatar = dto.avatar;
    return this.repo.save(p);
  }
}
