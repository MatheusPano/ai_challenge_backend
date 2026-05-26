import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { GeneratedPlan } from './generated-plan.entity';
import { StudentProfile } from './student-profile.entity';

@Entity('stop_completions')
@Index(['profile', 'plan', 'stopId'], { unique: true })
export class StopCompletion {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => StudentProfile, { onDelete: 'CASCADE' })
  profile!: StudentProfile;

  @ManyToOne(() => GeneratedPlan, { onDelete: 'CASCADE' })
  plan!: GeneratedPlan;

  @Column({ type: 'varchar', length: 64 })
  stopId!: string;

  @Column({ type: 'varchar', length: 16 })
  formatKind!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
