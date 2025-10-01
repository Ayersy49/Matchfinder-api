// src/auth/auth.controller.ts
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
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
  constructor(private readonly auth: AuthService) {}

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
      return res.ok ? { ok: true, accessToken: (res as any).accessToken } : res;
    } catch (e) {
      console.error('verify error', e);
      return { ok: false, reason: 'server_error' };
    }
  }
}
