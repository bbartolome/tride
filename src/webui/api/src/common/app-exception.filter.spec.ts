import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { AppExceptionFilter } from './app-exception.filter';
import { ERROR_CODES } from './error-codes';

function createHost(): {
  host: ArgumentsHost;
  json: jest.Mock;
  status: jest.Mock;
} {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({}),
    }),
  } as unknown as ArgumentsHost;
  return { host, json, status };
}

describe('AppExceptionFilter', () => {
  let filter: AppExceptionFilter;

  beforeEach(() => {
    filter = new AppExceptionFilter();
  });

  it('passes through an HttpException whose body already matches the envelope shape', () => {
    const { host, json, status } = createHost();
    const exception = new HttpException(
      { code: ERROR_CODES.NOT_ALLOWED, message: 'nope', detail: { foo: 1 } },
      HttpStatus.FORBIDDEN,
    );

    filter.catch(exception, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(json).toHaveBeenCalledWith({
      code: ERROR_CODES.NOT_ALLOWED,
      message: 'nope',
      detail: { foo: 1 },
    });
  });

  it('wraps a plain HttpException as HTTP_<status>', () => {
    const { host, json, status } = createHost();
    const exception = new HttpException('Forbidden', HttpStatus.FORBIDDEN);

    filter.catch(exception, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(json).toHaveBeenCalledWith({
      code: 'HTTP_403',
      message: 'Forbidden',
    });
  });

  it('returns a generic 500 envelope for a non-HttpException and leaks no detail', () => {
    const { host, json, status } = createHost();
    const loggerSpy = jest
      .spyOn(
        (filter as unknown as { logger: { error: (msg?: string) => void } })
          .logger,
        'error',
      )
      .mockImplementation(() => undefined);
    const exception = new Error('sensitive db connection string');

    filter.catch(exception, host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'Internal server error',
    });
    expect(loggerSpy).toHaveBeenCalled();
  });
});
