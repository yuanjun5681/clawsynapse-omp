/** External text never owns terminal styling, links, clipboard, cursor, or line layout. */
export function safeText(text: string, singleLine = false): string {
  const controls = singleLine
    ? /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
    : /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
  return text.replace(controls, value => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function errorText(error: unknown): string {
  return safeText(error instanceof Error ? error.message : "未知错误", true);
}
