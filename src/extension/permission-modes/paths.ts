import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** Resolve symlinks in the nearest existing ancestor, including for new files. */
export function resolvePermissionPath(cwd: string, target: string): string {
  let current = path.resolve(cwd, target);
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.resolve(realpathSync(current), ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling symlink exists but realpath cannot resolve it: fail closed.
      try {
        lstatSync(current);
        throw error;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT' || statError === error) throw statError;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** Conservative component-based protection; callers must check lexical and resolved paths. */
export function isProtectedWrite(target: string): boolean {
  const parts = path.resolve(target).split(path.sep).filter(Boolean).map((part) => part.toLowerCase());
  return parts.some((part, index) =>
    part === '.git' || part === 'node_modules' || part === '.ssh' ||
    part === '.gnupg' || part === '.aws' || part.startsWith('.env') ||
    ['.netrc', '.npmrc', '.pypirc', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'].includes(part) ||
    ['.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout'].includes(part) ||
    /\.(?:pem|key|p12|pfx)$/.test(part) ||
    (part === '.pi' && parts.slice(index + 1).some(child => ['settings.json', 'extensions', 'permission-modes.json'].includes(child))),
  );
}
