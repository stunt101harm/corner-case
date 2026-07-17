/** wrangler bundles *.sse files as text modules (see [[rules]] in wrangler.toml). */
declare module "*.sse" {
  const text: string;
  export default text;
}
