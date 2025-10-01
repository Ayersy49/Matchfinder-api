// src/messages/messages.module.ts
import { Module } from '@nestjs/common';
import { MessagesController } from './messages.controller';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [MessagesController],
  providers: [PrismaService],
})
export class MessagesModule {}
