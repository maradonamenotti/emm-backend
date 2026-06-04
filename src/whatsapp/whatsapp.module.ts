import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Prospecto } from '../entities/Prospecto';
import { MensajeWhatsApp } from '../entities/MensajeWhatsApp';
import { EstadoEmbudo } from '../entities/EstadoEmbudo';
import { CrmPlantilla } from '../entities/CrmPlantilla';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppGateway } from './whatsapp.gateway';
import { WhatsAppService } from './whatsapp.service';
import { AiTriageService } from './ai-triage.service';

@Module({
    imports: [TypeOrmModule.forFeature([Prospecto, MensajeWhatsApp, EstadoEmbudo, CrmPlantilla], 'crm')],
    controllers: [WhatsAppController],
    providers: [WhatsAppService, WhatsAppGateway, AiTriageService],
    exports: [WhatsAppService],
})
export class WhatsAppModule {}
