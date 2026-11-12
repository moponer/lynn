// Vite 渲染层的非 TS 资源声明：开源预览库自带样式表（@js-preview/excel）按包路径整包引入
declare module "*.css";
// 桌宠形象素材（@pet 指向 assets/pet-dafeiyu）：静态 import 进 bundle，默认导出资源 URL 字符串
declare module "*.png" {
  const src: string;
  export default src;
}
declare module "*.webp" {
  const src: string;
  export default src;
}
