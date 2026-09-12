import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { ERROR_CODES } from './error-codes';

export interface ErrorEnvelope {
  code: string;
  message: string;
  detail?: unknown;
}

interface MinimalResponse {
  status(code: number): this;
  json(body: unknown): this;
}

function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as Record<string, unknown>).code === 'string' &&
    typeof (body as Record<string, unknown>).message === 'string'
  );
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<MinimalResponse>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      if (isErrorEnvelope(body)) {
        response.status(status).json(body);
        return;
      }

      const message = exception.message || 'Http Exception';
      const envelope: ErrorEnvelope = {
        code: `HTTP_${status}`,
        message,
      };
      response.status(status).json(envelope);
      return;
    }

    if (exception instanceof Error) {
      this.logger.error(exception.stack);
    } else {
      this.logger.error(
        `Non-error exception thrown: ${JSON.stringify(exception)}`,
      );
    }
    const envelope: ErrorEnvelope = {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'Internal server error',
    };
    response.status(500).json(envelope);
  }
}
