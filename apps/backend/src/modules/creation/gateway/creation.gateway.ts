import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { DataSource } from 'typeorm';
import { CreationTask } from '../entities/creation-task.entity';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

/**
 * Creation WebSocket Gateway
 *
 * 断线重连策略:
 * - 客户端 socket.io 配置 reconnection:true, reconnectionAttempts:10,
 *   reconnectionDelay:1000, reconnectionDelayMax:5000
 * - 服务端无状态:断线期间丢失的 progress 事件可通过 HTTP GET /creation/:id
 *   补拉最新状态;重连后客户端应在 subscribe 回调中重新 join room
 *
 * 消息频率控制:
 * - progress 事件在轮询循环中每 4s 发一次,已通过 POLL_INTERVAL_MS 限频
 * - shot-progress 与 progress 同步发出,不做额外 throttle;
 *   若未来分镜数 >20 导致消息风暴,可在 emitShotProgress 内加 throttle(1s)
 */
@WebSocketGateway({
  namespace: '/creation',
  cors: {
    origin: (process.env.WEB_BASE_URL || 'http://localhost:3000').split(','),
    credentials: true,
  },
})
export class CreationGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(CreationGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly auth: JwtAuthGuard,
    private readonly db: DataSource
  ) {}
  async handleConnection(client: Socket) {
    try {
      await this.auth.verify(client.handshake.auth?.token || '');
    } catch {
      client.disconnect(true);
    }
  }
  handleDisconnect(_client: Socket) {}
  @SubscribeMessage('subscribe')
  async handleSubscribe(client: Socket, taskId: string) {
    try {
      const user = await this.auth.verify(client.handshake.auth?.token || '');
      if (
        typeof taskId !== 'string' ||
        !(await this.db.getRepository(CreationTask).findOneBy({ id: taskId, userId: user.sub }))
      )
        throw new Error();
      await client.join(`task:${taskId}`);
      return { subscribed: true };
    } catch {
      client.disconnect(true);
      return { subscribed: false };
    }
  }
  private async deliver(taskId: string, event: string, data: any) {
    if (!this.server) return;
    const sockets = await this.server.in(`task:${taskId}`).fetchSockets();
    for (const socket of sockets) {
      try {
        await this.auth.verify(socket.handshake.auth?.token || '');
        socket.emit(event, data);
      } catch {
        socket.disconnect(true);
      }
    }
  }
  emitShotProgress(
    taskId: string,
    data: { shotId: string; progress: number; status: string; message?: string }
  ) {
    void this.deliver(taskId, 'shot-progress', data);
  }

  emitProgress(taskId: string, data: { progress: number; status: string; message?: string }) {
    void this.deliver(taskId, 'progress', data);
  }

  emitComplete(taskId: string, data: any) {
    void this.deliver(taskId, 'complete', data);
  }

  emitError(taskId: string, error: string) {
    void this.deliver(taskId, 'error', { message: error });
  }
}
