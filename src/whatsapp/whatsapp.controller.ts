import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { WhatsAppService } from './whatsapp.service';

@Controller('api/whatsapp')
export class WhatsAppController {
    constructor(private readonly whatsAppService: WhatsAppService) {}

    @Get('webhook')
    verifyWebhook(@Query() query: Record<string, string>, @Res() res: Response) {
        if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === process.env.META_WEBHOOK_VERIFY_TOKEN) {
            return res.status(200).send(query['hub.challenge']);
        }
        return res.sendStatus(403);
    }

    @Post('webhook')
    async webhook(@Body() body: any) {
        await this.whatsAppService.processWebhook(body);
        return { success: true };
    }

    @Get('conversations')
    conversations(@Query('limit') limit?: string, @Query('offset') offset?: string) {
        return this.whatsAppService.conversations({ limit, offset });
    }

    @Get('status')
    status() {
        return this.whatsAppService.getStatus();
    }

    @Post('logout')
    logout() {
        return this.whatsAppService.logout();
    }

    @Post('read')
    markRead(@Body() body: { prospecto_id?: string }) {
        return this.whatsAppService.markRead(body.prospecto_id || '');
    }

    @Get('messages')
    messages(
        @Query('prospecto_id') prospectoId: string,
        @Query('limit') limit?: string,
        @Query('before') before?: string,
        @Query('resolve_contact') resolveContact?: string,
    ) {
        return this.whatsAppService.messages(prospectoId, { limit, before, resolveContact });
    }

    @Post('send')
    send(@Body() body: { id_prospecto?: string; telefono?: string; cuerpo_mensaje?: string; text?: string }) {
        return this.whatsAppService.send(body);
    }
}
