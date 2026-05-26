import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { EventLog } from './event-log.entity';

@Entity('student_profiles')
export class StudentProfile {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  sessionKey!: string;

  @Index({ unique: true })
  @Column({ type: 'int', nullable: true })
  cefisUserId!: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  avatar!: string | null;

  @Column({ type: 'json', nullable: true })
  goals!: string[] | null;

  @Column({ type: 'json', nullable: true })
  categoryIds!: number[] | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  level!: string | null;

  @Column({ type: 'float', nullable: true })
  theta!: number | null;

  @Column({ type: 'json', nullable: true })
  styleWeights!: {
    visual: number;
    aural: number;
    reading: number;
    kinesthetic: number;
  } | null;

  @Column({ type: 'json', nullable: true })
  topicSignals!: unknown | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => EventLog, (e) => e.profile)
  events!: EventLog[];
}
