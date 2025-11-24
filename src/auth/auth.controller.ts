// src/auth/auth.controller.ts
import {
  Body,
  Controller,
  HttpCode,
  Post,
  Get,
  UseGuards,
  Req,
  UnauthorizedException,
  Query,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { IsNotEmpty, IsString, Length, MinLength, MaxLength, Matches } from 'class-validator';

/* ================== DTOs ================== */

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

class LoginDto {
  @IsString()
  @IsNotEmpty()
  identifier!: string; // phone veya username

  @IsString()
  @IsNotEmpty()
  password!: string;
}

class SetCredentialsDto {
  @IsString()
  @MinLength(3, { message: 'Kullanıcı adı en az 3 karakter olmalı' })
  @MaxLength(24, { message: 'Kullanıcı adı en fazla 24 karakter olabilir' })
  @Matches(/^[a-zA-Z0-9_]+$/, { message: 'Kullanıcı adı sadece harf, rakam ve _ içerebilir' })
  username!: string;

  @IsString()
  @MinLength(6, { message: 'Şifre en az 6 karakter olmalı' })
  password!: string;

  @IsString()
  @MinLength(6, { message: 'Şifre tekrarı en az 6 karakter olmalı' })
  passwordConfirm!: string;
}

class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(6, { message: 'Yeni şifre en az 6 karakter olmalı' })
  newPassword!: string;
}

/* ================== CONTROLLER ================== */

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /* ---------- OTP ENDPOINTS ---------- */

  /**
   * OTP gönder
   * POST /auth/otp/request
   */
  @Post('otp/request')
  @HttpCode(200)
  async requestOtp(@Body() dto: RequestOtpDto) {
    try {
      return await this.auth.requestOtp(dto.phone);
    } catch (e) {
      console.error('OTP request error', e);
      return { ok: false, reason: 'server_error' };
    }
  }

  /**
   * OTP doğrula
   * POST /auth/otp/verify
   * Response: { ok, accessToken, isNew, hasPassword, hasUsername, phone, username }
   */
  @Post('otp/verify')
  @HttpCode(200)
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    try {
      const res = await this.auth.verifyOtp(dto.phone, dto.code);
      return res;
    } catch (e) {
      console.error('OTP verify error', e);
      return { ok: false, reason: 'server_error' };
    }
  }

  /* ---------- PASSWORD AUTH ENDPOINTS ---------- */

  /**
   * Şifre ile giriş (telefon veya username)
   * POST /auth/login
   */
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto) {
    try {
      return await this.auth.loginWithPassword(dto.identifier, dto.password);
    } catch (e) {
      console.error('Login error', e);
      return { ok: false, reason: 'server_error' };
    }
  }

  /**
   * İlk kayıt: username + password belirle
   * POST /auth/set-credentials
   * Requires: JWT (OTP verify sonrası alınan token)
   */
  @Post('set-credentials')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  async setCredentials(@Req() req: any, @Body() dto: SetCredentialsDto) {
    const userId = req.user?.id || req.user?.sub;
    if (!userId) throw new UnauthorizedException();

    // Şifre eşleşme kontrolü
    if (dto.password !== dto.passwordConfirm) {
      return { ok: false, reason: 'password_mismatch', message: 'Şifreler eşleşmiyor' };
    }

    try {
      return await this.auth.setCredentials(userId, dto.username, dto.password);
    } catch (e: any) {
      console.error('Set credentials error', e);
      return {
        ok: false,
        reason: e?.response?.error || 'server_error',
        message: e?.message || 'Bir hata oluştu',
      };
    }
  }

  /**
   * Şifre değiştir (mevcut kullanıcı)
   * POST /auth/change-password
   * Requires: JWT
   */
  @Post('change-password')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  async changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    const userId = req.user?.id || req.user?.sub;
    if (!userId) throw new UnauthorizedException();

    try {
      return await this.auth.changePassword(userId, dto.currentPassword, dto.newPassword);
    } catch (e: any) {
      console.error('Change password error', e);
      return {
        ok: false,
        reason: 'error',
        message: e?.message || 'Şifre değiştirilemedi',
      };
    }
  }

  /* ---------- UTILITY ENDPOINTS ---------- */

  /**
   * Username müsait mi kontrol et
   * GET /auth/check-username?username=xxx
   */
  @Get('check-username')
  @HttpCode(200)
  async checkUsername(@Query('username') username: string, @Query('excludeUserId') excludeUserId?: string) {
    try {
      return await this.auth.checkUsername(username, excludeUserId);
    } catch (e) {
      return { available: false };
    }
  }

  /* ---------- LEGACY ENDPOINTS (backward compatibility) ---------- */

  /**
   * Eski set-password endpoint (redirect to change-password logic)
   * POST /auth/otp/set-password
   */
  @Post('otp/set-password')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  async legacySetPassword(@Req() req: any, @Body() body: { password: string; currentPassword?: string }) {
    const userId = req.user?.id || req.user?.sub;
    if (!userId) throw new UnauthorizedException();

    try {
      return await this.auth.changePassword(userId, body.currentPassword || '', body.password);
    } catch (e: any) {
      return { ok: false, message: e?.message };
    }
  }

  /**
   * Eski login endpoint
   * POST /auth/otp/login
   */
  @Post('otp/login')
  @HttpCode(200)
  async legacyLogin(@Body() body: { identifier: string; password: string }) {
    return this.auth.loginWithPassword(body.identifier, body.password);
  }
}
