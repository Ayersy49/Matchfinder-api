import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto'; // ← burası

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  updateProfile(id: string, dto: UpdateProfileDto) { // ← tip burada
    return this.prisma.user.update({
      where: { id },
      data: {
        dominantFoot: dto.dominantFoot,
        positions: dto.positions ?? [],
        level: dto.level,
      },
    });
  }
}
