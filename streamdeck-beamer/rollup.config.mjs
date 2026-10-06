import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const sdPlugin = "local.beamer.control.sdPlugin";
const isWatching = Boolean(process.env.ROLLUP_WATCH);

/** @type {import("rollup").RollupOptions} */
export default {
	input: "src/plugin.ts",
	output: {
		file: `${sdPlugin}/bin/plugin.js`,
		format: "es",
		sourcemap: isWatching,
		sourcemapPathTransform: (relative, sourcemap) =>
			relative.replace(/^\.\.\//, ""),
	},
	// Stream Deck startet das Plugin mit seinem eigenen Node; dessen
	// eingebaute Module duerfen nicht mitgebuendelt werden.
	external: (id) => id.startsWith("node:"),
	plugins: [
		typescript({
			tsconfig: "./tsconfig.json",
			// Die tsconfig ist auf reines Typpruefen eingestellt (noEmit),
			// fuer den Bundle-Lauf muss Rollup aber Output bekommen.
			noEmit: false,
			declaration: false,
			declarationMap: false,
		}),
		nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
		commonjs(),
	],
};
