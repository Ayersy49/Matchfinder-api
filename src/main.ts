import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Next.js (localhost:3000) için CORS
  app.enableCors({
    origin: ['http://localhost:3000'],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Authorization'],
    credentials: true,
  });

  
  // DTO doğrulama + otomatik dönüşüm
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,            // DTO'da tanımlı olmayan alanları at
      forbidNonWhitelisted: true, // tanımsız alan gelirse 400 dön
      transform: true,            // payload'ı DTO sınıflarına çevir
    }),
  );

  const cfg = app.get(ConfigService);
  const port = Number(cfg.get<string>('PORT') ?? '4000');

  await app.listen(port);
  console.log(`API listening on http://localhost:${port}`);
}

bootstrap();
