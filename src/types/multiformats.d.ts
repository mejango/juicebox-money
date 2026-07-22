// multiformats 9 publishes declarations through `typesVersions`, but its
// export map predates TypeScript's `bundler` resolution and omits a `types`
// condition. Describe the small public surface used by the CID boundary until
// a reviewed major upgrade can remove this compatibility declaration.
declare module 'multiformats' {
  export interface CID {
    readonly version: 0 | 1
    toString(): string
  }

  export const CID: {
    parse(value: string): CID
  }
}
