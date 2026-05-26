import { Column, Entity, OneToMany, PrimaryColumn } from 'typeorm';
import { LessonDocument } from './lesson-document.entity';

@Entity('course_documents')
export class CourseDocument {
  @PrimaryColumn({ type: 'int' })
  id!: number;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text', nullable: true })
  subtitle!: string | null;

  @Column({ type: 'text', nullable: true })
  summary!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  goals!: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  categories!: number[] | null;

  @Column({ name: 'teacher_id', type: 'int', nullable: true })
  teacherId!: number | null;

  @Column({ name: 'teacher_name', type: 'text', nullable: true })
  teacherName!: string | null;

  @Column({ name: 'average_rating', type: 'double precision', nullable: true })
  averageRating!: number | null;

  @Column({ name: 'duration_sec', type: 'int', nullable: true })
  durationSec!: number | null;

  @Column({ name: 'ingested_at', type: 'timestamptz', default: () => 'NOW()' })
  ingestedAt!: Date;

  @OneToMany(() => LessonDocument, (l) => l.course)
  lessons!: LessonDocument[];
}
