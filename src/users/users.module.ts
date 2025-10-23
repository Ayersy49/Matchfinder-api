import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { PrismaService } from '../prisma/prisma.service';
import { UsersPositionsController } from './users-positions.controller';

@Module({
  controllers: [UsersController, UsersPositionsController],
  providers: [UsersService, PrismaService],
  exports: [UsersService],
})
export class UsersModule {}
