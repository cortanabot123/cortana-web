import { readFileSync } from "node:fs"
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

const buildId = new Date().toISOString()

function hermesAppShell(): Plugin {
  return {
    name: "cortana-web-app-shell-service-worker",
    transformIndexHtml(html) {
      return html.replace("<head>", `<head>\n    <meta name="cortana-build" content="${buildId}" />`)
    },
    generateBundle(_options, bundle) {
      const assets = [
        "/",
        "/index.html",
        "/manifest.webmanifest",
        "/icons/icon-192.png",
        "/icons/icon-512.png",
        ...Object.keys(bundle)
          .filter((file) => /\.(?:js|css|woff2)$/.test(file))
          .map((file) => `/${file}`),
      ]
      const template = readFileSync(path.resolve(import.meta.dirname, "src/pwa/sw.js"), "utf8")
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: template
          .replaceAll("__CORTANA_BUILD_ID__", buildId)
          .replace("__CORTANA_WEB_SHELL_ASSETS__", JSON.stringify(assets)),
      })
    },
  }
}

export default defineConfig({
  define: {
    __CORTANA_BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [react(), tailwindcss(), hermesAppShell()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
})
