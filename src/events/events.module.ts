import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventLog } from '../entities/event-log.entity';
import { ProfileModule } from '../profile/profile.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

@Module({
  imports: [TypeOrmModule.forFeature([EventLog]), ProfileModule],
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
