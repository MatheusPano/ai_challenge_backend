import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { StudentProfile } from './student-profile.entity';

@Entity('generated_plans')
export class GeneratedPlan {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => StudentProfile, { onDelete: 'CASCADE' })
  profile!: StudentProfile;

  @Column({ type: 'varchar', length: 32, nullable: true })
  level!: string | null;

  @Column({ type: 'float', nullable: true })
  thetaAtGeneration!: number | null;

  @Column({ type: 'json' })
  styleWeightsAtGeneration!: unknown;

  /** Full plan payload (stops + metadata) */
  @Column({ type: 'json' })
  payload!: unknown;

  @CreateDateColumn()
  createdAt!: Date;
}
