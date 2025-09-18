import { Exception, ExceptionRegistry } from '@cashlab/common/exceptions.js';
import type { IBaseExceptionConstructor } from '@cashlab/common/exceptions.js';
export * from '@cashlab/common/exceptions.js';

export class NetworkError extends Exception { };

export class AbortException extends Exception {
  constructor (message?: string) {
    super(message || '');
  }
}

for (let [ name, exception ] of [
  [ 'NetworkError', NetworkError ],
  [ 'AbortException', AbortException ],
]) {
  ExceptionRegistry.add(name as string, exception as IBaseExceptionConstructor)
}
