// Virtual modules served by the plugin (index.ts).
declare module "*@spark/cases" {
  /** Root-relative paths of every `*.spark.tsx` file. */
  const files: string[];
  export default files;
}
