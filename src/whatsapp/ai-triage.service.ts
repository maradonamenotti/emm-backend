import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

export interface TriageResult {
  estado_sugerido: 'SPAM_BASURA' | 'LEAD_NUEVO' | 'SOPORTE_ALUMNO' | 'HUMANO_REQUERIDO';
  curso_mencionado: string | null;
  es_comprobante_pago: boolean;
}

@Injectable()
export class AiTriageService {
  private readonly logger = new Logger(AiTriageService.name);
  private openai: OpenAI | null = null;

  constructor() {
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    }
  }

  async classifyMessage(text: string): Promise<TriageResult | null> {
    if (!this.openai) {
      this.logger.warn('OPENAI_API_KEY no está definida en .env. Saltando triaje IA.');
      return null;
    }

    const systemPrompt = `Eres el sistema de triaje y clasificación automática para el CRM de la Escuela de Entrenadores César Luis Menotti (Escuela Maradona Menotti). Tu objetivo es analizar los mensajes entrantes de Facebook, Instagram y WhatsApp, e identificar la intención del usuario para mantener la base de datos limpia.

DEBES devolver ÚNICAMENTE un objeto JSON estricto. Cero charla, cero explicaciones.

REGLAS DE CLASIFICACIÓN (Campo "estado_sugerido"):
1. "SPAM_BASURA": El mensaje es solo un emoji (ej. 🔥, 😍), una sola palabra sin contexto (ej. "hola", "ok", "a"), insultos, o spam comercial no relacionado a la escuela.
2. "LEAD_NUEVO": El usuario muestra interés en la propuesta académica. Pregunta por precios, inscripciones, duración, "info", o menciona un curso/carrera específica.
3. "SOPORTE_ALUMNO": El mensaje indica que la persona ya tiene una relación con la institución (ej. envía comprobantes de pago de cuotas/liquidaciones, reporta problemas para entrar al campus virtual, o consulta sobre cursadas activas).
4. "HUMANO_REQUERIDO": El mensaje es complejo, ambiguo o no encaja en las categorías anteriores.

ESTRUCTURA OBLIGATORIA DEL JSON DE SALIDA:
{
  "estado_sugerido": "SPAM_BASURA" | "LEAD_NUEVO" | "SOPORTE_ALUMNO" | "HUMANO_REQUERIDO",
  "curso_mencionado": "Nombre del curso o carrera si lo menciona explícitamente, de lo contrario null",
  "es_comprobante_pago": true | false
}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) return null;

      const parsed = JSON.parse(content) as TriageResult;
      
      if (!['SPAM_BASURA', 'LEAD_NUEVO', 'SOPORTE_ALUMNO', 'HUMANO_REQUERIDO'].includes(parsed.estado_sugerido)) {
        return null;
      }
      return parsed;

    } catch (error) {
      this.logger.error('Error in AI triage', error);
      return null;
    }
  }
}
