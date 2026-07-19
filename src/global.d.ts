// 为下游应用程序添加的项目级声明保留。
declare module 'react/compiler-runtime' {
  /** 执行 c 对应的业务处理。 */
  export function c(size: number): any[]
}

export {}
