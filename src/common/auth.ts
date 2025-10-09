export function getUserIdFromReq(req: any): string | undefined {
  return req?.user?.id || req?.user?.sub || req?.user?.userId || undefined;
}
