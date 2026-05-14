import { Controller, Get, Post, Put, Delete, Body, Param, Req } from '@nestjs/common';
import { StudentsService } from './students.service';

@Controller('api/students')
export class StudentsController {
  constructor(private readonly studentsService: StudentsService) {}

  @Get()
  async findAll() {
    const data = await this.studentsService.findAll();
    return { data };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const data = await this.studentsService.findOne(id);
    return { data };
  }

  @Post()
  async create(@Body() body: any, @Req() req: any) {
    const data = await this.studentsService.create(body, req);
    return { success: true, data };
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.studentsService.remove(id);
  }

  @Put(':id/estado')
  async updateEstado(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.studentsService.updateEstado(id, body, req);
  }

  @Put(':id/dates')
  async updateDates(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.studentsService.updateDates(id, body, req);
  }

  @Put(':id/legajo')
  async updateLegajo(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.studentsService.updateLegajo(id, body, req);
  }

  @Put(':id/datos')
  async updateDatos(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.studentsService.updateDatos(id, body, req);
  }

  @Post('bulk')
  async removeBulk(@Body() body: any) {
    return this.studentsService.removeBulk(body.ids);
  }

  // Notas
  @Post(':id/nota')
  async updateNota(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.studentsService.updateNota(id, body, req);
  }

  @Delete(':id/nota')
  async removeNota(@Param('id') id: string, @Body() body: any) {
    return this.studentsService.removeNota(id, body);
  }

  @Delete(':id/notas')
  async removeAllNotas(@Param('id') id: string, @Req() req: any) {
    return this.studentsService.removeAllNotas(id, req);
  }
}
