import { Module } from '@nestjs/common';
import { SeriesController } from './series.controller';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Module({
  imports: [], // PrismaService’i buradan al
  controllers: [SeriesController],
  providers: [PrismaService],
})
export class SeriesModule {}
