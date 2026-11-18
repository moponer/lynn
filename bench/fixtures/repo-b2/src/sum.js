export function sum(list) {
  // BUG: 空数组时 reduce 没有初始值，返回 undefined，被 Number() 变成 NaN
  return Number(list.reduce((a, b) => a + b));
}
