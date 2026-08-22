export interface LineShift {
  oldLine: number;
  newLine: number;
  delta: number;
}

export function buildLineShift(pre: string, post: string): LineShift[] {
  const preLines = pre.split("\n").length;
  const postLines = post.split("\n").length;
  const delta = postLines - preLines;
  return [{ oldLine: 0, newLine: 0, delta }];
}
