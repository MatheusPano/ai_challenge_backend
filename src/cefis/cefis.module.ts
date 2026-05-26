import { Module } from '@nestjs/common';
import { CefisController } from './cefis.controller';
import { CefisService } from './cefis.service';

@Module({
  controllers: [CefisController],
  providers: [CefisService],
  exports: [CefisService],
})
export class CefisModule {}
