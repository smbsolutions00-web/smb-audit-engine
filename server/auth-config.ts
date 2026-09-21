const MIN_SECRET_LENGTH = 32;

export function validateAuthConfiguration(env: NodeJS.ProcessEnv) {
  const enabled = env.AUTH_ENABLED === "true";
  const secret = env.SESSION_SECRET || "";
  if (env.NODE_ENV === "production" && !enabled) {
    throw new Error("Refusing to start production with AUTH_ENABLED disabled.");
  }
  if (enabled && secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters when auth is enabled.`);
  }
  return { enabled, secret };
}
