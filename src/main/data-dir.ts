import { resolve } from 'path'

/* STEMKIT_DATA_DIR moves every app-owned path (venv, models, songs, library)
   to a folder you pick. Unset or blank keeps the Electron default. */
export function resolveDataDir(env: NodeJS.ProcessEnv, electronDefault: string): string {
  const override = env.STEMKIT_DATA_DIR?.trim()
  return override ? resolve(override) : electronDefault
}
