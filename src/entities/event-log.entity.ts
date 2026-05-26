import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { StudentProfile } from './student-profile.entity';

@Entity('event_logs')
export class EventLog {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => StudentProfile, (p) => p.events, { onDelete: 'CASCADE' })
  profile!: StudentProfile;

  @Column({ type: 'varchar', length: 64 })
  type!: string;

  @Column({ type: 'json', nullable: true })
  payload!: unknown | null;

  @CreateDateColumn()
  createdAt!: Date;
}
