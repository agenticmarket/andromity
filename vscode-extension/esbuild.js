const esbuild = require("esbuild");

const isWatch = process.argv.includes("--watch");
const isProduction = process.argv.includes("--production");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: isProduction,
    sourcemap: !isProduction,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "info",
  });

  if (isWatch) {
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log("Extension build completed.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
