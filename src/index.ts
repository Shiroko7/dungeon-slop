import { handleApiRoute } from "./api/routes.ts";

const PORT = parseInt(process.env.PORT || "3000", 10);
const isDev = process.env.NODE_ENV !== "production";

async function buildFrontend() {
  const result = await Bun.build({
    entrypoints: ["./src/frontend.tsx"],
    outdir: "./dist",
    minify: !isDev,
    sourcemap: "linked",
    target: "browser",
    define: {
      "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "development"),
    },
  });

  if (!result.success) {
    console.error("Build failed:", result.logs);
    return null;
  }

  const htmlTemplate = await Bun.file("./src/index.html").text();
  const jsFile = result.outputs.find((o) => o.path.endsWith(".js"));
  const cssFile = await Bun.file("./src/index.css").text();

  return htmlTemplate
    .replace("<!-- CSS -->", `<style>${cssFile}</style>`)
    .replace(
      "<!-- JS -->",
      `<script type="module" src="/${jsFile?.path.replace(/\\/g, "/").split("/").pop() || "frontend.js"}"></script>`,
    );
}

// In production, build once. In dev, rebuild per request.
let cachedHtml: string | null = null;
if (!isDev) {
  cachedHtml = await buildFrontend();
  if (!cachedHtml) process.exit(1);
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    const apiResponse = await handleApiRoute(req, pathname);
    if (apiResponse) return apiResponse;

    if (pathname.endsWith(".js") || pathname.endsWith(".js.map")) {
      const file = Bun.file(`./dist${pathname}`);
      if (await file.exists()) {
        return new Response(file, {
          headers: {
            "Content-Type": pathname.endsWith(".map")
              ? "application/json"
              : "application/javascript",
            "Cache-Control": isDev ? "no-store" : "public, max-age=3600",
          },
        });
      }
    }

    if (pathname !== "/") {
      const publicFile = Bun.file(`./public${pathname}`);
      if (await publicFile.exists()) {
        return new Response(publicFile);
      }
    }

    const html = isDev ? await buildFrontend() : cachedHtml;
    if (!html) {
      return new Response("Build failed — check terminal", { status: 500 });
    }

    return new Response(html, {
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": isDev ? "no-store" : "public, max-age=3600",
      },
    });
  },
});

console.log(`Dungeon Slop running at http://localhost:${PORT}${isDev ? " (dev — rebuilds on refresh)" : ""}`);
