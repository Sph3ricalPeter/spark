// Virtual modules served by the plugin (index.ts).
declare module "*@spark/cases" {
  /** Root-relative paths of every `*.spark.tsx` file. */
  const files: string[];
  export default files;
}
declare module "*@spark/icon-libs" {
  /** The icon libraries in the project's package.json. */
  const libs: string[];
  export default libs;
}
declare module "*@spark/project" {
  /** The project's folder name. */
  export const name: string;
}
