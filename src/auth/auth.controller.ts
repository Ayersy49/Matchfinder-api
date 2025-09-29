import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RequestOtpDto, VerifyOtpDto } from './dto';

@Controller('auth/otp')
export class AuthController {
  constructor(private auth: AuthService) {}
  @Post('request')
  async request(@Body() body: unknown) {
    const parsed = RequestOtpDto.safeParse(body);
    if (!parsed.success) return { ok: false, reason: 'BAD_REQUEST' };
    return this.auth.requestOtp(parsed.data.phone);
  }
  @Post('verify')
  async verify(@Body() body: unknown) {
    const parsed = VerifyOtpDto.safeParse(body);
    if (!parsed.success) return { ok: false, reason: 'BAD_REQUEST' };
    return this.auth.verifyOtp(parsed.data.phone, parsed.data.code);
  }
}
