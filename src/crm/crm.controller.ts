import { Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, Res, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { CrmService } from './crm.service';

@Controller('api/crm')
export class CrmController {
    constructor(private readonly crmService: CrmService) {}

    // ─── CONFIG ────────────────────────────────────────────────────────
    @Get('config')
    async getConfig() {
        return this.crmService.getConfig();
    }

    @Post('config')
    async createConfigItem(@Body() body: any) {
        return this.crmService.createConfigItem(body);
    }

    @Put('config/:id')
    async updateConfigItem(@Param('id') id: string, @Body() body: any) {
        return this.crmService.updateConfigItem(id, body);
    }

    @Delete('config/:id')
    async deleteConfigItem(@Param('id') id: string) {
        return this.crmService.deleteConfigItem(id);
    }

    // ─── ESTADOS EMBUDO (Guía de Estados) ──────────────────────────────
    @Get('estados')
    async findAllEstados() {
        return this.crmService.findAllEstados();
    }

    @Post('estados')
    async createEstado(@Body() body: any) {
        return this.crmService.createEstado(body);
    }

    @Put('estados/:id')
    async updateEstadoConfig(@Param('id') id: string, @Body() body: any) {
        return this.crmService.updateEstadoConfig(id, body);
    }

    @Delete('estados/:id')
    async deleteEstado(@Param('id') id: string) {
        return this.crmService.deleteEstado(id);
    }

    // ─── STATS ─────────────────────────────────────────────────────────
    @Get('stats')
    async getStats() {
        return this.crmService.getStats();
    }

    // ─── EXPORT ────────────────────────────────────────────────────────
    @Get('export')
    async exportExcel(
        @Query('estado') estado?: string,
        @Query('origen') origen?: string,
        @Query('asignado_a') asignado_a?: string,
        @Query('curso') curso?: string,
        @Res() res?: Response,
    ) {
        const filters = { estado, origen, asignado_a, curso };
        const buffer = await this.crmService.exportExcel(filters);
        const fecha = new Date().toISOString().split('T')[0];
        res!.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res!.setHeader('Content-Disposition', `attachment; filename="CRM_Prospectos_${fecha}.xlsx"`);
        res!.send(buffer);
    }

    // ─── PROSPECTOS ────────────────────────────────────────────────────
    @Get('prospectos')
    async findAll(
        @Query('estado') estado?: string,
        @Query('id_estado') id_estado?: string,
        @Query('origen') origen?: string,
        @Query('asignado_a') asignado_a?: string,
        @Query('curso') curso?: string,
    ) {
        return this.crmService.findAll({ estado, id_estado, origen, asignado_a, curso });
    }

    @Post('prospectos')
    async create(@Body() body: any) {
        return this.crmService.create(body);
    }

    @Post('prospectos/limpiar-fantasmas')
    async limpiarFantasmas() {
        return this.crmService.limpiarFantasmas();
    }

    @Post('prospectos/importar-excel')
    @UseInterceptors(FileInterceptor('file'))
    async importarExcel(@UploadedFile() file: Express.Multer.File, @Body('curso') curso: string) {
        return this.crmService.importarExcel(file.buffer, curso);
    }

    @Get('prospectos/:id')
    async findOne(@Param('id') id: string) {
        return this.crmService.findOne(id);
    }

    @Put('prospectos/:id')
    async update(@Param('id') id: string, @Body() body: any) {
        return this.crmService.update(id, body);
    }

    @Patch('prospectos/:id/estado')
    async updateEstado(@Param('id') id: string, @Body() body: { estado: string, motivo_perdida?: string }) {
        return this.crmService.updateEstado(id, body.estado, body.motivo_perdida);
    }

    @Delete('prospectos/:id')
    async remove(@Param('id') id: string) {
        return this.crmService.remove(id);
    }

    // ─── HISTORIAL ─────────────────────────────────────────────────────
    @Post('prospectos/:id/seguimiento')
    async addSeguimiento(@Param('id') id: string, @Body() body: any) {
        return this.crmService.addSeguimiento(id, body);
    }

    @Delete('prospectos/:id/seguimiento/:sid')
    async removeSeguimiento(@Param('sid') sid: string) {
        return this.crmService.removeSeguimiento(sid);
    }

    // ─── PLANTILLAS ────────────────────────────────────────────────────
    @Get('plantillas')
    async findAllPlantillas(
        @Query('curso') curso?: string,
        @Query('categoria') categoria?: string,
        @Query('etapa') etapa?: string,
    ) {
        return this.crmService.findAllPlantillas({ curso, categoria: categoria || etapa });
    }

    @Post('plantillas')
    async createPlantilla(@Body() body: any) {
        return this.crmService.createPlantilla(body);
    }

    @Put('plantillas/:id')
    async updatePlantilla(@Param('id') id: string, @Body() body: any) {
        return this.crmService.updatePlantilla(id, body);
    }

    @Delete('plantillas/:id')
    async deletePlantilla(@Param('id') id: string) {
        return this.crmService.deletePlantilla(id);
    }
}
