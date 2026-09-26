/** Android does not inherit `fontFamily` onto nested `Text`. Every run sets its own. */
export function runFontFamily(cjk: boolean, latin: string, cjkFamily: string): string {
  return cjk ? cjkFamily : latin;
}
