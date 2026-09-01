import type { APIRoute } from "astro";

const siteUrl = new URL(import.meta.env.PUBLIC_SITE_URL ?? "https://unottr.com");
const pages = [
  { path: "/", priority: "1.0", changeFrequency: "weekly" },
  { path: "/pricing", priority: "0.9", changeFrequency: "monthly" },
  { path: "/privacy", priority: "0.3", changeFrequency: "yearly" },
  { path: "/terms", priority: "0.3", changeFrequency: "yearly" },
] as const;

export const GET: APIRoute = () => {
  const urls = pages
    .map(
      ({ path, priority, changeFrequency }) => `  <url>
    <loc>${new URL(path, siteUrl).href}</loc>
    <changefreq>${changeFrequency}</changefreq>
    <priority>${priority}</priority>
  </url>`,
    )
    .join("\n");

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`,
    { headers: { "Content-Type": "application/xml; charset=utf-8" } },
  );
};
