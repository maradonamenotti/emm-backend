import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as path from 'path';
import * as fs from 'fs';

// Cargar variables de entorno del archivo .env nativamente en Node 20.12+
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    if (typeof (process as any).loadEnvFile === 'function') {
      (process as any).loadEnvFile(envPath);
      console.log('Variables de entorno cargadas correctamente desde:', envPath);
    } else {
      console.warn('process.loadEnvFile no está disponible en este Node.js');
    }
  } else {
    console.warn('No se encontró el archivo .env en:', envPath);
  }
} catch (err) {
  console.warn('Error cargando .env con process.loadEnvFile:', err);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: true,
    credentials: true,
  });

  const config = new DocumentBuilder()
    .setTitle('EMM API')
    .setDescription('The EMM API description')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const documentFactory = () => SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, documentFactory);

  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
