// src/friends/friends.module.ts
import { Module } from '@nestjs/common';
import { FriendsController } from './friends.controller';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module'; // <-- EKLE

@Module({
  imports: [AuthModule],               // <-- EKLE (çok kritik)
  controllers: [FriendsController],
  providers: [PrismaService],
})
export class FriendsModule {}
