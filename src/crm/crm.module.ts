import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Prospecto } from '../entities/Prospecto';
import { HistorialSeguimiento } from '../entities/HistorialSeguimiento';
import { CrmConfigItem } from '../entities/CrmConfigItem';
import { CrmPlantilla } from '../entities/CrmPlantilla';
import { EstadoEmbudo } from '../entities/EstadoEmbudo';
import { CrmService } from './crm.service';
import { CrmCronService } from './crm-cron.service';
import { CrmController } from './crm.controller';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([Prospecto, HistorialSeguimiento, CrmConfigItem, CrmPlantilla, EstadoEmbudo], 'crm'),
        WhatsAppModule,
    ],
    controllers: [CrmController],
    providers: [CrmService, CrmCronService],
})
export class CrmModule {}
