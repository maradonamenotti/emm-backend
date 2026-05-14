import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Prospecto } from '../entities/Prospecto';
import { MensajeWhatsApp } from '../entities/MensajeWhatsApp';
import { EstadoEmbudo } from '../entities/EstadoEmbudo';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppGateway } from './whatsapp.gateway';
import { WhatsAppService } from './whatsapp.service';

@Module({
    imports: [TypeOrmModule.forFeature([Prospecto, MensajeWhatsApp, EstadoEmbudo], 'crm')],
    controllers: [WhatsAppController],
    providers: [WhatsAppService, WhatsAppGateway],
    exports: [WhatsAppService],
})
export class WhatsAppModule {}
