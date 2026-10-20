import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { HealthResponse, RuntimeDescriptor } from './types';

/**
 * Discovery of a core that is already running for a workspace.
 *
 * The liveness decision is made by asking the API, never by probing the pid.
 * On Windows a signal probe is not a harmless read, and a pid can be reused, so
 * the process id is treated as a label and `/api/health` as the authority.
 */

export interface LiveCore {
  descriptor: RuntimeDescriptor;
  health: HealthResponse;
  baseUrl: string;
  token: string;
}

/** Mirrors the core's own resolution order for its descriptor. */
export function runtimeDescriptorPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.LEXIQODE_RUNTIME_FILE ?? '').trim();
  if (override) {
    return override;
  }
  return path.join(configDir(env), 'core-runtime.json');
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.LEXIQODE_CONFIG_DIR ?? '').trim();
  if (override) {
    return override;
  }
  if (process.platform === 'win32') {
    const roaming = env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(roaming, 'LexiQode');
  }
  const xdg = env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(xdg, 'LexiQode');
}

export function readDescriptor(env: NodeJS.ProcessEnv = process.env): RuntimeDescriptor | undefined {
  const file = runtimeDescriptorPath(env);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as RuntimeDescriptor;
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Unauthenticated liveness probe. Never throws; a failure is simply "not there". */
export function probeHealth(baseUrl: string, timeoutMs = 1500): Promise<HealthResponse | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: HealthResponse | undefined): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    let url: URL;
    try {
      url = new URL('/api/health', baseUrl);
    } catch {
      finish(undefined);
      return;
    }

    const request = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeout: timeoutMs,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(undefined);
          return;
        }
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HealthResponse;
            finish(payload.ok ? payload : undefined);
          } catch {
            finish(undefined);
          }
        });
      }
    );

    request.on('timeout', () => {
      request.destroy();
      finish(undefined);
    });
    request.on('error', () => finish(undefined));
  });
}

export function sameWorkspace(a: string, b: string): boolean {
  if (!a || !b) {
    return false;
  }
  const normalise = (value: string): string => {
    const resolved = path.resolve(value).replace(/\\/g, '/');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalise(a) === normalise(b);
}

/**
 * Find a reusable core for this workspace, or report why the last one cannot be
 * reused. A descriptor whose API does not answer is left alone: the core that
 * owns it removes it, and only if it still carries that core's own pid.
 */
export async function findLiveCore(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<LiveCore | undefined> {
  const descriptor = readDescriptor(env);
  if (!descriptor?.base_url) {
    return undefined;
  }
  const health = await probeHealth(descriptor.base_url);
  if (!health) {
    return undefined;
  }
  if (descriptor.workspace && !sameWorkspace(descriptor.workspace, workspace)) {
    return undefined;
  }
  if (!sameWorkspace(health.workspace, workspace)) {
    return undefined;
  }
  if (health.protocol !== undefined && descriptor.protocol !== undefined && health.protocol !== descriptor.protocol) {
    return undefined;
  }
  return {
    descriptor,
    health,
    baseUrl: descriptor.base_url,
    token: descriptor.token ?? '',
  };
}