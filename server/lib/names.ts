/**
 * Shared name-parsing helpers used by the audit engine and the
 * ElevenLabs narration generator.
 */

/**
 * Pull a clean first name out of whatever the intake form gave us.
 * Handles things like:
 *   "Tawana Bell"            -> "Tawana"
 *   "Dr. Sarah Johnson"      -> "Sarah"
 *   "Michelle Wolff, LCSW"   -> "Michelle"
 *   "Aina Marie Brooks"      -> "Aina"
 *   "aina"                   -> "Aina"
 *   ""                       -> ""
 * If we can't find anything sensible we return the trimmed original.
 */
export function firstNameOf(fullName: string | undefined | null): string {
  if (!fullName) return "";
  // Drop trailing credentials after a comma (", MD", ", LCSW", ", PhD")
  let s = fullName.split(",")[0].trim();
  // Strip common leading honorifics
  s = s.replace(/^(dr\.?|mr\.?|mrs\.?|ms\.?|miss|pastor|rev\.?|prof\.?)\s+/i, "").trim();
  if (!s) return fullName.trim();
  const first = s.split(/\s+/)[0] || s;
  // Capitalize first letter, keep the rest as written (handles "DaKota", "McKenna").
  return first.charAt(0).toUpperCase() + first.slice(1);
}
