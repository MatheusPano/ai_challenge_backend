import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ProfileModule } from './profile/profile.module';
import { EventsModule } from './events/events.module';
import { QuizModule } from './quiz/quiz.module';
import { PlanModule } from './plan/plan.module';
import { CefisModule } from './cefis/cefis.module';
import { RagModule } from './rag/rag.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'mysql',
        host: config.get<string>('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 3306),
        username: config.get<string>('DB_USER', 'app'),
        password: config.get<string>('DB_PASSWORD', 'app'),
        database: config.get<string>('DB_NAME', 'ai_challenge'),
        autoLoadEntities: true,
        synchronize: true,
      }),
    }),
    ProfileModule,
    EventsModule,
    QuizModule,
    PlanModule,
    CefisModule,
    RagModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
