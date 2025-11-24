import { Body, Controller, HttpCode, Post, UseGuards, Req, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { IsNotEmpty, IsString, Length } from 'class-validator';

class RequestOtpDto {
  @IsString()
  @IsNotEmpty()
  phone!: string;
}

class VerifyOtpDto {
  @IsString()
  @IsNotEmpty()
  phone!: string;

  @IsString()
  @IsNotEmpty()
  @Length(4, 6)
  code!: string;
}

@Controller('auth/otp')
export class AuthController {
  constructor(private readonly auth: AuthService) { }

  @Post('request')
  @HttpCode(200)
  async request(@Body() dto: RequestOtpDto) {
    try {
      return await this.auth.requestOtp(dto.phone);
    } catch (e) {
      console.error('request error', e);
      return { ok: false, reason: 'server_error' };
    }
  }

  @Post('verify')
  @HttpCode(200)
  async verify(@Body() dto: VerifyOtpDto) {
    try {
      const res = await this.auth.verifyOtp(dto.phone, dto.code);
      return res.ok ? { ok: true, accessToken: (res as any).accessToken, isNew: (res as any).isNew } : res;
    } catch (e) {
      console.error('verify error', e);
      return { ok: false, reason: 'server_error' };
    }
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: { identifier: string; password: string }) {
    return this.auth.loginWithPassword(body.identifier, body.password);
  }

  @Post('set-password')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  async setPassword(@Req() req: any, @Body() body: { password: string; currentPassword?: string }) {
    const userId = req.user?.id || req.user?.sub;
    if (!userId) throw new UnauthorizedException();
    return this.auth.setPassword(userId, body.password, body.currentPassword);
  }
}
