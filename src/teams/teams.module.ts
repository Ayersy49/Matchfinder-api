// src/teams/teams.module.ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TeamsController } from './teams.controller';

@Module({
  imports: [PrismaModule],
  controllers: [TeamsController],
})
export class TeamsModule {}
