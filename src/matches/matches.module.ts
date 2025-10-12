import { Module } from '@nestjs/common';
import { MatchesController } from './matches.controller';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    AuthModule, // JWT guard/strategy buradan geliyor
  ],
  controllers: [MatchesController],
  providers: [PrismaService],
})
export class MatchesModule {}
