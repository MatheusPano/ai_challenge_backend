import {
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import { CefisService } from './cefis.service';

@Controller('api/cefis/courses')
export class CefisController {
  constructor(private readonly cefis: CefisService) {}

  @Get(':id')
  async getCourse(
    @Headers('authorization') auth: string | undefined,
    @Param('id', ParseIntPipe) id: number,
  ) {
    if (!auth) {
      throw new HttpException('Missing Authorization', HttpStatus.UNAUTHORIZED);
    }
    const sessionKey = auth.replace(/^Bearer\s+/i, '').trim();
    const course = await this.cefis.getCourse(sessionKey, id);
    if (!course) {
      throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    }
    return { data: course };
  }
}
