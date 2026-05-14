import { Controller, Post, UseInterceptors, UploadedFile, Body, Req, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ImportsService } from './imports.service';

@Controller('api')
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  @Post('quinttos')
  @UseInterceptors(FileInterceptor('file'))
  async importQuinttos(@UploadedFile() file: any, @Req() req: any) {
    if (!file) throw new BadRequestException({ error: "Archivo faltante" });
    return this.importsService.importQuinttos(file.buffer, req);
  }

  @Post('process-excel')
  @UseInterceptors(FileInterceptor('file'))
  async processExcel(@UploadedFile() file: any, @Body() body: any, @Req() req: any) {
    if (!file) throw new BadRequestException({ error: "Archivo faltante" });
    return this.importsService.processExcel(file.buffer, body, req);
  }
}
