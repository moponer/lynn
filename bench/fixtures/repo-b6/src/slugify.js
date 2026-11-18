export function slugify(text) {
  // 只做了小写，空格与非法字符还没处理（B6 的第一次打回点）
  return String(text).toLowerCase();
}
