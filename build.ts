const targets = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
] as const;

const { mkdirSync } = await import("fs");
mkdirSync("dist", { recursive: true });

for (const target of targets) {
  const outfile = `dist/dscl-${target.replace("bun-", "")}`;
  console.log(`Building ${outfile}...`);
  const proc = Bun.spawn([
    "bun",
    "build",
    "--compile",
    `--target=${target}`,
    "--minify",
    "dscl.ts",
    "--outfile",
    outfile,
  ]);
  await proc.exited;
  if (proc.exitCode !== 0) {
    console.error(`Failed to build ${target}`);
    process.exit(1);
  }
}

console.log("All builds complete.");
