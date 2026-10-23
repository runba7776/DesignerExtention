/** true in the no-install (static hosting) build, false in the local app build. */
declare const __HOSTED__: boolean;
declare module '*?url' {
  const url: string;
  export default url;
}
