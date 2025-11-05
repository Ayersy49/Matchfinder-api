import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TeamsController } from './teams.controller';
import { TeamRequestsController } from './team-requests.controller'; // <-- EKLE

@Module({
  imports: [PrismaModule],
  controllers: [TeamsController, TeamRequestsController], // <-- EKLE
})
export class TeamsModule {}
