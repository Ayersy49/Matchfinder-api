// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, LogLevel, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';

async function bootstrap() {
  const raw = process.env.NEST_LOG_LEVELS || 'log,warn,error';
  const levels = raw.split(',').map((s) => s.trim()) as LogLevel[];

  const app = await NestFactory.create(AppModule, { logger: levels });

  app.enableCors({
    origin: ['http://localhost:3000'],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Authorization'],
    credentials: true,
  });

  // --- AUTH HEADER DEBUG (isteğe bağlı ama çok faydalı) ---
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.path.startsWith('/users') || req.path.startsWith('/auth')) {
      const auth   = req.headers['authorization'];
      const cookie = req.headers['cookie'];
      Logger.debug(
        `path=${req.path} origin=${req.headers.origin ?? '-'} auth=${auth ?? '-'} cookie=${cookie ? '(var)' : '(yok)'}`,
        'AuthDebug',
      );
    }
    next();
  });
  // ---------------------------------------------------------

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const cfg = app.get(ConfigService);
  const port = Number(cfg.get<string>('PORT') ?? '4000');
  await app.listen(port);
  Logger.log(`HTTP up on http://localhost:${port}`, 'Bootstrap');
}
bootstrap();
