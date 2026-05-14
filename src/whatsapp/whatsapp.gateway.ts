import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';

@WebSocketGateway({
    cors: {
        origin: true,
        credentials: true,
    },
})
export class WhatsAppGateway {
    @WebSocketServer()
    server!: Server;

    emit(event: string, payload: unknown) {
        this.server?.emit(event, payload);
    }
}
