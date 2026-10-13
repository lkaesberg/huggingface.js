// Browser checks for what only a browser shows: the real Worker and fetch
// (headers, redirects, abort), createImageBitmap limits and rendering. Serves
// the package (its build and the fixtures) itself, logging each request.
// usage: npm run build && npm run test:browser
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "/dist/esm/index.js";
const MIME = {
	".js": "text/javascript",
	".wasm": "application/wasm",
	".png": "image/png",
	".usda": "text/plain",
	".usdc": "application/octet-stream",
	".usdz": "model/vnd.usdz+zip",
};
// A page that imports nothing: each check imports the package itself.
const PAGE = `<!doctype html><script type="importmap">{ "imports": { "three": "/node_modules/three/build/three.module.js", "three/addons/": "/node_modules/three/examples/jsm/" } }</script>`;

// Requests to the server, with their Authorization header.
let requests = [];
const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://localhost");
	const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization" };
	if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
	if (url.pathname === "/") return res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
	requests.push({ url: url.pathname, auth: req.headers.authorization ?? null });
	const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
	if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile())
		return res.writeHead(404, cors).end("not found");
	res
		.writeHead(200, {
			"content-type": MIME[path.extname(file)] ?? "application/octet-stream",
			"cache-control": "no-store",
			...cors,
		})
		.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

// Several meshes and materials, one of them instanced: geometry streams in over several messages.
const SHAPES = "/fixtures/implicit_gprims.usda";
// A quad whose material samples /fixtures/quadrants.png.
const TEXTURED = "/fixtures/uv_set.usda";

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
// An uncaught error or unhandled rejection in the page fails the test it happens in.
let pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
await page.goto(BASE);

/** A CORS server on a new local origin that logs each request's X-Key and Authorization headers. */
async function loggingServer(respond) {
	const log = [];
	const srv = http.createServer((req, res) => {
		const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
		if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
		log.push([req.url, req.headers["x-key"] ?? null, req.headers.authorization ?? null]);
		respond(req, res, cors);
	});
	await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
	return { log, origin: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

/** The textured fixture with its texture moved to `texture`, served at `root` through a route. */
async function routeTextured(root, texture) {
	const usda = fs.readFileSync(path.join(ROOT, TEXTURED), "utf8").replace("@quadrants.png@", `@${texture}@`);
	await page.context().route(root, (route) => route.fulfill({ body: usda, contentType: "text/plain" }));
}

test("headers never follow a redirect to another origin", async () => {
	// Three origins, as when a page loads from a CDN: the page's, the root's, and another that a layer on the
	// root's origin redirects to. First, before any Playwright route: routing changes how redirects are followed.
	const quad =
		'#usda 1.0\ndef Mesh "M" {\n  int[] faceVertexCounts = [3]\n  int[] faceVertexIndices = [0, 1, 2]\n  point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]\n}';
	const other = await loggingServer((req, res, cors) => res.writeHead(200, cors).end(quad));
	const site = await loggingServer((req, res, cors) => {
		if (req.url === "/root.usda") return res.writeHead(200, cors).end("#usda 1.0\n(subLayers = [@./a.usda@])");
		res.writeHead(302, { ...cors, location: `${other.origin}/a.usda` }).end();
	});
	const meshes = await page.evaluate(
		async ([module, url]) => {
			const { loadUsd } = await import(module);
			const result = await loadUsd(url, {
				headers: { Authorization: "Bearer SECRET", "X-Key": "SECRET2" },
				textures: "none",
			});
			result.dispose();
			return result.info.meshes;
		},
		[MODULE, `${site.origin}/root.usda`],
	);
	site.close();
	other.close();
	assert.ok(
		site.log.some(([url, key, auth]) => url === "/a.usda" && key === "SECRET2" && auth === "Bearer SECRET"),
		`headers reach the root origin: ${JSON.stringify(site.log)}`,
	);
	assert.ok(
		other.log.length > 0 && other.log.every(([, key, auth]) => key === null && auth === null),
		JSON.stringify(other.log),
	);
	assert.equal(meshes, 1);
});

test("headers reach the layers and textures on the root origin, and no other origin", async () => {
	requests = [];
	await page.evaluate(
		async ([module, url]) => {
			const { loadUsd } = await import(module);
			const result = await loadUsd(url, { headers: { Authorization: "Bearer test-token" } });
			await result.complete;
			result.dispose();
		},
		[MODULE, TEXTURED],
	);
	const own = requests.filter((r) => r.url.startsWith("/fixtures/"));
	assert.ok(own.some((r) => r.url.endsWith(".usda")) && own.some((r) => r.url.endsWith(".png")));
	assert.ok(
		own.every((r) => r.auth === "Bearer test-token"),
		JSON.stringify(own.map((r) => [r.url, r.auth])),
	);

	// The root (served through a route) authors its texture on another origin of the same server.
	const root = `${BASE}/__fixture/cross-origin.usda`;
	const texture = `http://localhost:${new URL(BASE).port}/fixtures/quadrants.png`;
	await routeTextured(root, texture);
	requests = [];
	const counts = await page.evaluate(
		async ([module, url, origin]) => {
			const { loadUsd } = await import(module);
			const result = await loadUsd(url, { headers: { Authorization: "Bearer test-token" }, allowedOrigins: [origin] });
			const done = await result.complete;
			result.dispose();
			return done;
		},
		[MODULE, root, new URL(texture).origin],
	);
	const textures = requests.filter((r) => r.url.endsWith("quadrants.png"));
	assert.deepEqual(counts, { textures: 1, failed: 0 });
	assert.ok(textures.length > 0 && textures.every((r) => r.auth === null), JSON.stringify(textures));
});

test("a texture outside allowedOrigins is never requested", async () => {
	const root = `${BASE}/__fixture/other-origin.usda`;
	await routeTextured(root, `http://localhost:${new URL(BASE).port}/fixtures/quadrants.png`);
	requests = [];
	const out = await page.evaluate(
		async ([module, url]) => {
			const { loadUsd } = await import(module);
			const result = await loadUsd(url);
			const outcome = {
				counts: await result.complete,
				warning: result.info.warnings.find((w) => w.code === "texture-failed")?.message,
			};
			result.dispose();
			return outcome;
		},
		[MODULE, root],
	);
	assert.deepEqual(
		requests.filter((r) => r.url.endsWith("quadrants.png")),
		[],
	);
	assert.deepEqual(out.counts, { textures: 0, failed: 1 });
	assert.match(out.warning, /not in allowedOrigins/);
});

test("textures past maxTextureBytes, over 16384 px a side or of unchecked formats fail as warnings, not the load", async () => {
	// A PNG header claiming 20000 x 20000 px, and a GIF.
	const huge = Buffer.alloc(33);
	huge.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
	huge.writeUInt32BE(20000, 16);
	huge.writeUInt32BE(20000, 20);
	huge.set([8, 6], 24);
	const gif = Buffer.from("GIF89a\x10\x00\x10\x00\x00\x00\x00", "latin1");
	for (const [name, body] of [
		["huge", huge],
		["gif", gif],
	]) {
		await page.context().route(`**/__${name}.png`, (route) => route.fulfill({ body, contentType: "image/png" }));
		await routeTextured(`${BASE}/__fixture/${name}.usda`, `${BASE}/__${name}.png`);
	}
	const out = await page.evaluate(
		async ([module, cases]) => {
			const { loadUsd } = await import(module);
			const outcomes = [];
			for (const [url, options] of cases) {
				const result = await loadUsd(url, options);
				outcomes.push({
					counts: await result.complete,
					messages: result.info.warnings.filter((w) => w.code === "texture-failed").map((w) => w.message),
				});
				result.dispose();
			}
			return outcomes;
		},
		[
			MODULE,
			[
				[TEXTURED, { maxTextureBytes: 100 }],
				[`${BASE}/__fixture/huge.usda`, {}],
				[`${BASE}/__fixture/gif.usda`, {}],
			],
		],
	);
	assert.deepEqual(
		out.map((o) => o.counts),
		[
			{ textures: 0, failed: 1 },
			{ textures: 0, failed: 1 },
			{ textures: 0, failed: 1 },
		],
	);
	assert.match(out[0].messages[0], /maxTextureBytes/);
	assert.match(out[1].messages[0], /image too large: 20000x20000/);
	assert.match(out[2].messages[0], /unsupported image format/);
});

test("abort rejects with an aborted UsdLoadError, before or during the load", async () => {
	// The root never arrives: the load is still fetching when it is aborted.
	let held;
	await page.context().route("**/__pending.usda", (route) => (held = route));
	const outcomes = await page.evaluate(
		async ([module, url]) => {
			const { loadUsd } = await import(module);
			const outcome = (promise) =>
				promise.then(
					() => "resolved",
					(e) => `${e.name}:${e.code}`,
				);
			const controller = new AbortController();
			const pending = loadUsd("/__pending.usda", { signal: controller.signal });
			setTimeout(() => controller.abort(), 50);
			return [await outcome(pending), await outcome(loadUsd(url, { signal: AbortSignal.abort() }))];
		},
		[MODULE, SHAPES],
	);
	await held?.abort();
	await page.context().unroute("**/__pending.usda");
	assert.deepEqual(outcomes, ["UsdLoadError:aborted", "UsdLoadError:aborted"]);
});

/** Loads `root` from `files` (`{ key: text, or '/fixtures/…' to copy a served file }`) with `options`, logging only the requests made during the load. */
async function loadFiles(root, files, options = {}) {
	const sources = Object.fromEntries(
		Object.entries(files).map(([key, source]) => [
			key,
			source.startsWith("/fixtures/") ? [...fs.readFileSync(path.join(ROOT, source))] : source,
		]),
	);
	await page.evaluate(() => import("/dist/esm/index.js"));
	requests = [];
	return page.evaluate(
		async ([module, root, sources, options]) => {
			const { loadUsd } = await import(module);
			const files = new Map(
				Object.entries(sources).map(([key, source]) => [
					key,
					new File([typeof source === "string" ? source : new Uint8Array(source)], key.split("/").pop()),
				]),
			);
			const result = await loadUsd(root, { ...options, files });
			const complete = await result.complete;
			result.dispose();
			return { meshes: result.info.meshes, complete, warnings: result.info.warnings.map((w) => [w.code, w.path]) };
		},
		[MODULE, root, sources, options],
	);
}

const fetched = () => requests.filter((r) => /\.(usd[acz]?|png)$/.test(r.url));

test("files: a dropped package loads its payloads and textures by relative path, and fetches nothing", async () => {
	const quad = fs
		.readFileSync(path.join(ROOT, TEXTURED), "utf8")
		.replace("@quadrants.png@", "@../Textures/quadrants.png@");
	const result = await loadFiles("pkg/root.usda", {
		"pkg/root.usda": "#usda 1.0\n(subLayers = [@./payloads/quad.usda@])",
		"pkg/payloads/quad.usda": quad,
		"pkg/Textures/quadrants.png": "/fixtures/quadrants.png",
	});
	assert.deepEqual(result, { meshes: 1, complete: { textures: 1, failed: 0 }, warnings: [] });
	assert.deepEqual(fetched(), []);
});

test("files: a missing file is a warning with its local: path, never a request", async () => {
	const result = await loadFiles("root.usda", {
		"root.usda": "#usda 1.0\n(subLayers = [@./absent.usda@, @/fixtures/uv_set.usda@])",
	});
	assert.deepEqual(
		result.warnings
			.filter(([code]) => code === "layer-missing")
			.map(([, path]) => path)
			.sort(),
		["local:///absent.usda", "local:///fixtures/uv_set.usda"],
	);
	assert.deepEqual(fetched(), []);
});

test("files: an http(s) layer in the files follows allowedOrigins and never gets headers", async () => {
	const root = { "root.usda": `#usda 1.0\n(subLayers = [@${BASE}/fixtures/meshes.usda@])` };
	const refused = await loadFiles("root.usda", root, { headers: { Authorization: "Bearer SECRET" } });
	assert.deepEqual(
		refused.warnings.filter(([code]) => code === "layer-missing"),
		[["layer-missing", `${BASE}/fixtures/meshes.usda`]],
	);
	assert.deepEqual(fetched(), []);
	const allowed = await loadFiles("root.usda", root, {
		headers: { Authorization: "Bearer SECRET" },
		allowedOrigins: [BASE],
	});
	assert.ok(allowed.meshes > 0);
	assert.deepEqual(fetched(), [{ url: "/fixtures/meshes.usda", auth: null }]);
});

test("files: a single dropped .usdz loads its packaged texture", async () => {
	const result = await loadFiles("uv_set.usdz", { "uv_set.usdz": "/fixtures/uv_set.usdz" });
	assert.deepEqual(result, { meshes: 1, complete: { textures: 1, failed: 0 }, warnings: [] });
	assert.deepEqual(fetched(), []);
});

let failed = 0;
try {
	for (const [name, fn] of tests) {
		pageErrors = [];
		try {
			await fn();
			if (pageErrors.length) {
				throw new Error(`page error: ${pageErrors.join("; ")}`);
			}
			console.log(`ok   ${name}`);
		} catch (error) {
			failed++;
			console.log(`FAIL ${name}: ${error.message.split("\n")[0]}`);
		}
	}
} finally {
	await browser.close();
	server.close();
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
