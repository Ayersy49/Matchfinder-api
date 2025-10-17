import { Module } from '@nestjs/common';
import { RatingsController } from './ratings.controller';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [RatingsController],
  providers: [PrismaService],
})
export class RatingsModule {}
