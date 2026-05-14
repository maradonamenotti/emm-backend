import { Controller, Get, Post, Param, Body, Res, UseInterceptors, UploadedFiles, Req } from '@nestjs/common';
import type { Response } from 'express';
import { CertificatesService } from './certificates.service';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import * as path from 'path';
import * as fs from 'fs';
import { getDocsPath } from '../common/helpers';

@Controller('api')
export class CertificatesController {
  constructor(private readonly certificatesService: CertificatesService) {}

  @Get('students/:id/certificate')
  async getCertificate(@Param('id') id: string, @Res() res: Response) {
    const { pdfBuf, filename } = await this.certificatesService.getCertificate(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(pdfBuf);
  }

  @Post('students/:id/diploma')
  async createDiploma(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const { buffer, filename } = await this.certificatesService.createDiploma(id, body);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  }

  @Get('students/:id/diploma')
  async getDiploma(@Param('id') id: string, @Res() res: Response) {
    const { buffer, filename } = await this.certificatesService.getDiploma(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  }

  @Post('generate-certificates')
  @UseInterceptors(FileFieldsInterceptor([{ name: 'excelFile' }, { name: 'pdfTemplate' }]))
  async generateMassiveCertificates(@UploadedFiles() files: any, @Body() body: any, @Res() res: Response) {
      try {
        const result: any = await this.certificatesService.generateMassiveCertificates(files, body);
        return res.json(result);
      } catch (err: any) {
        return res.status(500).json({ error: err.message || "Error generando PDFs." });
      }
  }

  @Get('certificates/download-zip')
  async downloadZip(@Res() res: Response) {
    const outPath = path.join(getDocsPath(), "certificados_generados.zip");
    if (fs.existsSync(outPath)) {
        res.download(outPath, "certificados.zip");
    } else {
        res.status(404).send("El archivo no existe o ya caducó.");
    }
  }

  @Get('download-zip') // Fallback a la antigua ruta en caso de que esté quemada en el frontend
  async downloadZipLegacy(@Res() res: Response) {
      return this.downloadZip(res);
  }
}
