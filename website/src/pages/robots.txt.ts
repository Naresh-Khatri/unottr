import type { APIRoute } from "astro";

const siteUrl = new URL(import.meta.env.PUBLIC_SITE_URL ?? "https://unottr.com");

export const GET: APIRoute = () => {
  const sitemapUrl = new URL("/sitemap.xml", siteUrl);

  return new Response(
    ["User-agent: *", "Allow: /", "", `Sitemap: ${sitemapUrl.href}`, ""].join("\n"),
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
};
