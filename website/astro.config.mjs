// Docs site for @komaa/cartesia-msteams-bridge, published to GitHub Pages by .github/workflows/docs.yml.
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";

export default defineConfig({
  site: "https://komaa-com.github.io",
  base: "/cartesia-msteams-bridge",
  integrations: [
    // Client-side Mermaid rendering (theme-aware, offline). Must come BEFORE starlight.
    mermaid({ theme: "default", autoTheme: true }),
    starlight({
      head: [
        // Google Analytics 4 (shared StandIn property; filter by hostname in GA).
        { tag: "script", attrs: { async: true, src: "https://www.googletagmanager.com/gtag/js?id=G-M02N9C42XH" } },
        {
          tag: "script",
          content:
            "window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-M02N9C42XH');",
        },
        // Cloudflare Web Analytics beacon (privacy-friendly pageviews; complements GA above).
        { tag: "script", attrs: { type: "module", src: "https://static.cloudflareinsights.com/beacon.min.js", "data-cf-beacon": '{"token": "49de4fe6d4e64fb6a5b18bbc7d133e88"}' } },
      ],
      title: "Microsoft Teams Bridge for Cartesia Line Agents",
      description:
        "Put a Cartesia Line voice agent on a real Microsoft Teams call: verbatim base64 PCM 16 kHz relay, barge-in, native DTMF, live-context events for your agent code, and call governors, connected through the StandIn media bridge.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/komaa-com/cartesia-msteams-bridge",
        },
      ],
      sidebar: [
        { label: "Overview", link: "/" },
        { label: "Getting Started", link: "/getting-started/" },
        { label: "Run the Example", link: "/example/" },
        { label: "Connecting to StandIn", link: "/connecting-to-standin/" },
        { label: "Your Line Agent", link: "/your-line-agent/" },
        { label: "Architecture", link: "/architecture/" },
        { label: "Configuration Reference", link: "/configuration-reference/" },
        { label: "Library API", link: "/library-api/" },
        { label: "Wire Protocol", link: "/wire-protocol/" },
        { label: "Governors and Privacy", link: "/governors-and-privacy/" },
        { label: "Troubleshooting", link: "/troubleshooting/" },
        { label: "Contributing", link: "/contributing/" },
      ],
    }),
  ],
});
