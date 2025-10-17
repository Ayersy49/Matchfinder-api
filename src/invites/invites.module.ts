// src/invites/invites.module.ts
import { Module } from '@nestjs/common';
import { InvitesService } from './invites.service';
import { InvitesController } from './invites.controller';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [InvitesController],
  providers: [InvitesService, PrismaService],
})
export class InvitesModule {}
