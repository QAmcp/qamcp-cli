// "Was this file started directly (as opposed to imported)?" that works on Windows, Linux and
// macOS. The usual `file:///` + argv[1] trick builds four slashes on Linux and never matches,
// which once silently turned programs started on Linux into do-nothing programs.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isMain(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return resolve(fileURLToPath(metaUrl)) === resolve(argv1);
  } catch {
    return false;
  }
}
