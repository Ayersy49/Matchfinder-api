import { Module } from '@nestjs/common';
import { PitchesController } from './pitches.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PitchesController],
})
export class PitchesModule {}
