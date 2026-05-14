import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppUser } from './entities/AppUser';
import { Nota } from './entities/Nota';
import { Student } from './entities/Student';
import { Prospecto } from './entities/Prospecto';
import { HistorialSeguimiento } from './entities/HistorialSeguimiento';
import { CrmConfigItem } from './entities/CrmConfigItem';
import { CrmPlantilla } from './entities/CrmPlantilla';
import { MensajeWhatsApp } from './entities/MensajeWhatsApp';
import { EstadoEmbudo } from './entities/EstadoEmbudo';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { StudentsModule } from './students/students.module';
import { ImportsModule } from './imports/imports.module';
import { CertificatesModule } from './certificates/certificates.module';
import { CrmModule } from './crm/crm.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL || 'postgresql://postgres:Riverplate912@localhost:5432/analiticos',
      entities: [AppUser, Nota, Student],
      synchronize: true,
    }),
    TypeOrmModule.forRoot({
      name: 'crm',
      type: 'postgres',
      url: process.env.CRM_DATABASE_URL || 'postgresql://postgres:Riverplate912@localhost:5432/emm_crm',
      entities: [Prospecto, HistorialSeguimiento, CrmConfigItem, CrmPlantilla, MensajeWhatsApp, EstadoEmbudo],
      synchronize: true,
    }),
    ScheduleModule.forRoot(),
    AuthModule,
    UsersModule,
    StudentsModule,
    ImportsModule,
    CertificatesModule,
    CrmModule,
    WhatsAppModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
