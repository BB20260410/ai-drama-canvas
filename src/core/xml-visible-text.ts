/** 反复剥标签，避免一次 replace 后还留下 `<script` 这类残片。 */
export function xmlVisibleText(markup: string): string {
  let current = markup;
  let previous = "";
  while (current !== previous) {
    previous = current;
    current = current.replace(/<[^>]*>/gu, "");
  }
  return current;
}
