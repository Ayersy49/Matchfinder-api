import { z } from 'zod';
export const RequestOtpDto = z.object({ phone: z.string().min(10).max(20) });
export type RequestOtpDto = z.infer<typeof RequestOtpDto>;
export const VerifyOtpDto = z.object({ phone: z.string().min(10).max(20), code: z.string().length(6) });
export type VerifyOtpDto = z.infer<typeof VerifyOtpDto>;
