import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { CourseDocument } from './course-document.entity';

@Entity('lesson_documents')
export class LessonDocument {
  @PrimaryColumn({ type: 'int' })
  id!: number;

  @Column({ name: 'course_id', type: 'int' })
  courseId!: number;

  @ManyToOne(() => CourseDocument, (c) => c.lessons, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'course_id' })
  course!: CourseDocument;

  @Column({ type: 'int' })
  position!: number;

  @Column({ type: 'text' })
  title!: string;

  @Column({ name: 'duration_sec', type: 'int', nullable: true })
  durationSec!: number | null;

  @Column({ name: 'ingested_at', type: 'timestamptz', default: () => 'NOW()' })
  ingestedAt!: Date;
}
