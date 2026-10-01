import type { ApiResult } from '../core/types';

let credential = '';
export function consumeAccessLink(): boolean {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const captured = params.get('access');
  if (captured) {
    credential = captured;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return !!credential;
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  consumeAccessLink();
  let response: Response;
  try {
    response = await fetch(path, {
      ...options, credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential, ...options.headers },
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error('Cannot reach the local server at ' + window.location.origin
      + '. Start the app with npm start and open the new access link printed in the terminal.');
  }
  const result = await response.json() as ApiResult<T>;
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}
