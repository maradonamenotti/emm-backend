import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { Student } from '../entities/Student';
import { Nota } from '../entities/Nota';

@Module({
  imports: [TypeOrmModule.forFeature([Student, Nota])],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
