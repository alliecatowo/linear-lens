import { defineConfig } from "vitepress";

// GitHub Pages serves project sites under /<repo>/. Set DOCS_BASE=/ for a custom domain.
export default defineConfig({
  title: "Linear Lens",
  description: "Make Linear issue IDs clickable, hoverable and editable inside VS Code and Cursor.",
  base: process.env.DOCS_BASE ?? "/linear-lens/",
  cleanUrls: true,
  lastUpdated: true,
  // ROADMAP.md is an internal planning document, not user documentation.
  srcExclude: ["ROADMAP.md"],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/install" },
      { text: "Settings", link: "/reference/settings" },
      { text: "Open VSX", link: "https://open-vsx.org/extension/alliecatowo/linear-lens" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Install", link: "/guide/install" },
          { text: "Authentication", link: "/guide/authentication" },
          { text: "Features", link: "/guide/features" },
          { text: "Supported syntax", link: "/guide/syntax" },
          { text: "Development", link: "/guide/development" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Settings", link: "/reference/settings" },
          { text: "Commands and shortcuts", link: "/reference/commands" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/alliecatowo/linear-lens" }],
    search: { provider: "local" },
  },
});
