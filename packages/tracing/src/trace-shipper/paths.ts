import { relative, resolve, sep } from 'node:path';

export function toRef(root: string, absolutePath: string): string {
  const rel = relative(resolve(root), resolve(absolutePath));
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error(`Path "${absolutePath}" is outside root "${root}"`);
  }
  return rel.split(/[/\\]+/).join('/');
}

export function isTmpFile(name: string): boolean {
  return name.endsWith('.tmp');
}

export function isShipperPath(ref: string): boolean {
  return ref === '.shipper' || ref.startsWith('.shipper/');
}
