// src/elo/elo.module.ts
import { Module } from '@nestjs/common';
import { EloController } from './elo.controller';
import { EloService } from './elo.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [EloController],
  providers: [EloService],
  exports: [EloService],
})
export class EloModule {}
