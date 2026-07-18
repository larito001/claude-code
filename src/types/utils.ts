export type DeepImmutable<T> = T extends (...args: any[]) => any
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepImmutable<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepImmutable<T[Key]> }
      : T

export type Permutations<T extends string> = T
