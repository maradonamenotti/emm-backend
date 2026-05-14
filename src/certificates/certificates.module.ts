import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';
import { Student } from '../entities/Student';

@Module({
  imports: [TypeOrmModule.forFeature([Student])],
  controllers: [CertificatesController],
  providers: [CertificatesService],
})
export class CertificatesModule {}
