import { Controller, Get, Put, Body, UseGuards, Req } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

@UseGuards(AuthGuard('jwt'))
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  async me(@Req() req: any) {
    const userId = req.user?.userId ?? req.user?.sub;
    return this.users.findById(userId);
  }

  @Put('me')
  async update(@Req() req: any, @Body() body: UpdateProfileDto) {
    const userId = req.user?.userId ?? req.user?.sub;
    return this.users.updateProfile(userId, body);
  }
}
