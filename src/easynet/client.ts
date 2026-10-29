import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { parseBool, parseInt16, toHex16 } from './codec.js';

export const DEFAULT_CGI_PATH = '/recepcion_datos_4.cgi';

export enum Operation {
  ReadCoils = 2001,
  ReadRegisters = 2002,
  WriteCoil = 2011,
  WriteRegister = 2012,
}

export interface EasyNetClientOptions {
  host: string;
  username: string;
  password: string;
  cgiPath?: string;
  timeoutMs?: number;
  /** Optional hook to log raw request/response traffic. */
  onTrace?: (message: string) => void;
}

export class EasyNetError extends Error {
  constructor(message: string, readonly raw?: string, readonly retryable = false) {
    super(message);
    this.name = 'EasyNetError';
  }
}

const RETRY_BASE_DELAY_MS = 1000;
const MAX_ATTEMPTS = 3;

/**
 * Minimal client for the easyNet CGI exposed by Ecoforest heat pumps.
 * Requests are serialized because the embedded web server is not designed for
 * concurrent access.
 */
export class EasyNetClient {
  private readonly url: URL;
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: EasyNetClientOptions) {
    const base = /^[a-z][a-z\d+.-]*:\/\//i.test(options.host) ? options.host : `https://${options.host}`;
    this.url = new URL(options.cgiPath ?? DEFAULT_CGI_PATH, base);
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.username || this.url.password) {
      throw new Error('easyNet host must be an HTTP(S) URL without embedded credentials');
    }
    this.authHeader = 'Basic ' + Buffer.from(`${options.username}:${options.password}`).toString('base64');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError('easyNet timeout must be a positive number');
    }
  }

  /** Reads `count` holding registers starting at `address`. Returns raw hex strings keyed by address. */
  readRegisters(address: number, count: number): Promise<Map<number, string>> {
    return this.read(Operation.ReadRegisters, address, count);
  }

  /** Reads `count` coils starting at `address`. Returns raw "0"/"1" strings keyed by address. */
  readCoils(address: number, count: number): Promise<Map<number, string>> {
    return this.read(Operation.ReadCoils, address, count);
  }

  /**
   * Calls a page-level "composite" read operation (e.g. 2148 for the main screen).
   * Returns the value lines between the status header and the trailing status line.
   */
  readBlock(op: number): Promise<string[]> {
    this.validateInteger(op, 'operation', 1, 65535);
    return this.enqueue(async () => {
      const raw = await this.post(`idOperacion=${op}`);
      const lines = EasyNetClient.responseLines(raw, op);
      if (lines.length < 3 || lines.at(-1) !== '0') {
        throw new EasyNetError(`Incomplete easyNet block ${op}`, raw);
      }
      return lines.slice(1, -1).map((l) => l.trim());
    });
  }

  /** Writes a signed 16-bit integer to a register. Analog values must be pre-scaled (x10). */
  writeRegister(address: number, value: number): Promise<void> {
    this.validateInteger(value, 'register value', -32768, 32767);
    return this.write(Operation.WriteRegister, address, toHex16(value));
  }

  writeCoil(address: number, value: boolean): Promise<void> {
    if (typeof value !== 'boolean') {
      throw new TypeError('Coil value must be boolean');
    }
    return this.write(Operation.WriteCoil, address, value ? '1' : '0');
  }

  /**
   * Same format as the easyNet web UI: the value is appended as a bare field,
   * e.g. "idOperacion=2012&dir=6106&num=1&01f4". Success is "error_2012=0\n0".
   */
  private write(op: Operation, address: number, value: string): Promise<void> {
    this.validateInteger(address, 'address', 0, 65535);
    return this.enqueue(async () => {
      const raw = await this.post(`idOperacion=${op}&dir=${address}&num=1&${value}`);
      const lines = EasyNetClient.responseLines(raw, op);
      if (lines.length !== 2 || lines[1] !== '0') {
        throw new EasyNetError(`easyNet write to ${address} failed (${lines[0]})`, raw);
      }
    });
  }

  private async read(op: Operation, address: number, count: number): Promise<Map<number, string>> {
    this.validateInteger(address, 'address', 0, 65535);
    this.validateInteger(count, 'count', 1, 65536 - address);
    const body = new URLSearchParams({ idOperacion: String(op), dir: String(address), num: String(count) });
    const values = await this.enqueue(async () => {
      const raw = await this.post(body.toString());
      const parsed = EasyNetClient.parseResponse(raw, op);
      const metadata = EasyNetClient.responseLines(raw, op)[1].split('&');
      if (metadata[0] !== `dir=${address}` || metadata[1] !== `num=${count}`) {
        throw new EasyNetError('easyNet returned a different address range', raw);
      }
      if (parsed.length !== count) {
        throw new EasyNetError(`Expected ${count} values from address ${address}, got ${parsed.length}`, raw);
      }
      for (const value of parsed) {
        if (op === Operation.ReadCoils) {
          parseBool(value);
        } else {
          parseInt16(value);
        }
      }
      return parsed;
    });

    const result = new Map<number, string>();
    for (let i = 0; i < count; i++) {
      result.set(address + i, values[i]);
    }
    return result;
  }

  /**
   * Response format (firmware 2024):
   *   error_2002=0
   *   dir=6100&num=3&0001&0078&0104
   *   0
   * Invalid addresses are reported inline as "address= N error".
   */
  static parseResponse(raw: string, op?: Operation): string[] {
    const lines = EasyNetClient.responseLines(raw, op);
    if (lines.length !== 3 || lines[2] !== '0') {
      throw new EasyNetError('Unexpected easyNet response', raw);
    }

    if (lines[1].includes(' error')) {
      throw new EasyNetError('easyNet rejected the address range', raw, false);
    }

    if (!/^dir=\d+&num=\d+&/.test(lines[1])) {
      throw new EasyNetError('Invalid easyNet register response', raw);
    }
    return lines[1].split('&').slice(2);
  }

  private static responseLines(raw: string, op?: number): string[] {
    const lines = raw.replace(/\r/g, '').trimEnd().split('\n').map((line) => line.trim());
    const header = /^error_(\d+|geo_get_reg|geo_get_bit|geo_set_reg|geo_set_bit|get_alarmas)=(-?\d+)$/.exec(lines[0]);
    const legacy = new Map<number, string>([
      [2001, 'geo_get_bit'], [2002, 'geo_get_reg'], [2011, 'geo_set_bit'], [2012, 'geo_set_reg'],
      [1079, 'get_alarmas'],
    ]);
    if (!header || (op !== undefined && header[1] !== String(op) && header[1] !== legacy.get(op))) {
      throw new EasyNetError('Unexpected easyNet response header', raw);
    }
    if (header[2] !== '0') {
      throw new EasyNetError(`easyNet returned an error (${lines[0]})`, raw, header[2] === '-7');
    }
    return lines;
  }

  private validateInteger(value: number, name: string, min: number, max: number): void {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new RangeError(`Invalid easyNet ${name}: ${value} (expected ${min}..${max})`);
    }
  }

  /**
   * Serializes requests and retries with backoff: the controller occasionally answers with
   * transient errors (e.g. "error_2002=-7"). All operations are idempotent.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const withRetry = async (): Promise<T> => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await task();
        } catch (err) {
          const retryable = err instanceof EasyNetError ? err.retryable
            : err instanceof Error && 'code' in err
              && ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN'].includes(String(err.code));
          if (!retryable || attempt >= MAX_ATTEMPTS) {
            throw err;
          }
          this.options.onTrace?.(`retrying after error: ${(err as Error).message}`);
          await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * attempt));
        }
      }
    };
    const run = this.queue.then(withRetry, withRetry);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private post(body: string): Promise<string> {
    const isHttps = this.url.protocol === 'https:';
    const doRequest = isHttps ? httpsRequest : httpRequest;
    this.options.onTrace?.(`POST ${this.url.href} ${body}`);

    return new Promise((resolve, reject) => {
      const req = doRequest(
        this.url,
        {
          method: 'POST',
          headers: {
            'Authorization': this.authHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
          },
          // easyNet uses a self-signed certificate.
          ...(isHttps ? { rejectUnauthorized: false } : {}),
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('latin1');
            this.options.onTrace?.(`<- ${res.statusCode} ${JSON.stringify(text)}`);
            if (res.statusCode === 401) {
              reject(new EasyNetError('Authentication failed (check serial number / password)', text, false));
            } else if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              reject(new EasyNetError(`HTTP ${res.statusCode}`, text, (res.statusCode ?? 0) >= 500));
            } else {
              resolve(text);
            }
          });
          res.on('error', reject);
          res.on('aborted', () => reject(new EasyNetError('easyNet response aborted', undefined, true)));
        },
      );

      const deadline = setTimeout(
        () => req.destroy(new EasyNetError(`Timeout after ${this.timeoutMs} ms`, undefined, true)),
        this.timeoutMs,
      );
      req.on('close', () => clearTimeout(deadline));
      req.on('timeout', () => req.destroy(new EasyNetError(`Timeout after ${this.timeoutMs} ms`, undefined, true)));
      req.on('error', reject);
      req.end(body);
    });
  }
}
