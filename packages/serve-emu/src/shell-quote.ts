/**
 * Quotes one argument for the device shell.
 *
 * `adb shell a b c` joins its words with spaces and the device runs the
 * result through `sh -c`, so `$`, globs, and quotes in a value are
 * interpreted there (an activity like `.Settings$WifiSettingsActivity`
 * loses its nested-class suffix). Wrap request-derived values with this;
 * leave intentional shell syntax such as `VAR=value` assignments unquoted.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
